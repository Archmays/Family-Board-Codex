import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoardWorkspace } from "../shared/BoardWorkspace";
import type { Board, BoardTask, BoardView, Course, PhotoAttachment } from "../shared/types";
import {
  ApiError,
  discardPhotoUpload,
  getBoard,
  getPublishPreflight,
  getRevision,
  publishBoard,
  saveBoard as saveBoardRequest,
  uploadPhoto,
  type PublishPreflight,
} from "./api";
import { processPhoto } from "./image-processing";
import "./editor.css";

type SaveState = "loading" | "saved" | "dirty" | "saving" | "autosaved" | "failed";
type DrawerState = { kind: "course" | "task"; id: string } | null;
type ConflictState = { board: Board; revision: string; publishedRevision: string | null } | null;

interface UndoState {
  task: BoardTask;
  index: number;
  expiresAt: number;
}

const SAVE_LABELS: Record<SaveState, string> = {
  loading: "正在读取本地文件",
  saved: "已保存到本地",
  dirty: "有未保存修改",
  saving: "正在保存",
  autosaved: "已自动保存",
  failed: "保存失败",
};

function cloneBoard(board: Board): Board {
  return structuredClone(board);
}

function makeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function shanghaiDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shanghaiWeekday() {
  const dateKey = shanghaiDateKey();
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay() || 7;
}

function messageFromError(error: unknown) {
  if (error instanceof ApiError) {
    const details = error.details as { errors?: unknown } | undefined;
    if (Array.isArray(details?.errors) && details.errors.length) {
      const formatted = details.errors.map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const path = typeof record.path === "string" ? `${record.path}: ` : "";
          const message = typeof record.message === "string" ? record.message : JSON.stringify(record);
          return `${path}${message}`;
        }
        return String(entry);
      });
      return `${error.message}：${formatted.join("；")}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "发生未知错误";
}

function Icon({ name }: { name: "save" | "preview" | "publish" | "plus" | "copy" | "trash" | "close" }) {
  const paths: Record<typeof name, React.ReactNode> = {
    save: <path d="M5 4h12l2 2v14H5zM8 4v6h8V4M8 20v-6h8v6" />,
    preview: <><path d="M2.8 12s3.4-5.5 9.2-5.5 9.2 5.5 9.2 5.5-3.4 5.5-9.2 5.5S2.8 12 2.8 12Z" /><circle cx="12" cy="12" r="2.5" /></>,
    publish: <><path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5" /><path d="M5 13v7h14v-7" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function Field({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={`form-field${wide ? " form-field--wide" : ""}`}><span>{label}</span>{children}</label>;
}

interface PhotoManagerProps {
  photos: PhotoAttachment[];
  onAppend: (photos: PhotoAttachment[]) => boolean;
  onChange: (photos: PhotoAttachment[]) => void;
  onError: (message: string) => void;
  onWorkChange: (delta: 1 | -1) => void;
}

function PhotoManager({ photos, onAppend, onChange, onError, onWorkChange }: PhotoManagerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [lightbox, setLightbox] = useState<PhotoAttachment | null>(null);

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length || uploading) return;
    setUploading(true);
    onWorkChange(1);
    try {
      for (const file of files) {
        const processed = await processPhoto(file);
        const uploaded = await uploadPhoto(processed.full, processed.thumbnail, {
          width: processed.width,
          height: processed.height,
          mimeType: processed.mimeType,
        });
        // Attach each successful file immediately. This keeps earlier files in
        // a multi-upload if a later file fails and merges against the latest
        // board state instead of an async, stale photos closure.
        try {
          if (!onAppend([uploaded])) {
            throw new Error("照片处理完成时，关联的课程或事项已不存在。请重新选择照片。");
          }
        } catch (error) {
          try {
            await discardPhotoUpload(uploaded);
          } catch (cleanupError) {
            throw new Error(`${messageFromError(error)}；未关联照片的自动清理失败：${messageFromError(cleanupError)}`);
          }
          throw error;
        }
      }
    } catch (error) {
      onError(messageFromError(error));
    } finally {
      onWorkChange(-1);
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [onAppend, onError, onWorkChange, uploading]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (files.length) {
        event.preventDefault();
        void addFiles(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= photos.length || from === to) return;
    const next = [...photos];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  return <section className="photo-manager" aria-labelledby="photo-manager-title">
    <div className="photo-manager__heading">
      <div>
        <h3 id="photo-manager-title">照片附件</h3>
        <p>上传时会移除 EXIF/GPS，并生成适合网页显示的版本。</p>
      </div>
      <button className="button button--small" type="button" onClick={() => inputRef.current?.click()} disabled={uploading}>
        <Icon name="plus" />{uploading ? "处理中…" : "选择照片"}
      </button>
    </div>
    <input
      ref={inputRef}
      className="visually-hidden"
      type="file"
      accept="image/jpeg,image/png,image/webp"
      multiple
      onChange={(event) => void addFiles(Array.from(event.target.files ?? []))}
    />
    <div
      className={`photo-dropzone${uploading ? " photo-dropzone--busy" : ""}`}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
      onDrop={(event) => { event.preventDefault(); void addFiles(Array.from(event.dataTransfer.files)); }}
    >
      拖拽图片到这里，或直接按 Ctrl/Cmd+V 粘贴截图
    </div>
    <p className="privacy-note">请勿添加证件、电话号码、家庭地址等敏感资料。发布后的页面和照片属于公开互联网资源。</p>

    {photos.length > 0 && <div className="photo-editor-list">
      {photos.map((photo, index) => <article
        className="photo-editor-card"
        key={photo.id}
        draggable
        onDragStart={() => setDragIndex(index)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={() => { if (dragIndex !== null) move(dragIndex, index); setDragIndex(null); }}
      >
        <button className="photo-editor-card__preview" type="button" onClick={() => setLightbox(photo)} aria-label={`放大照片 ${index + 1}`}>
          <img src={`/${photo.thumbnail}`} alt={photo.caption || `照片 ${index + 1}`} />
        </button>
        <label className="photo-editor-card__caption">
          <span>图片说明</span>
          <input value={photo.caption} onChange={(event) => {
            const next = [...photos];
            next[index] = { ...photo, caption: event.target.value };
            onChange(next);
          }} placeholder="这张照片记录了什么？" />
        </label>
        <div className="photo-editor-card__actions">
          <button type="button" onClick={() => move(index, index - 1)} disabled={index === 0} aria-label="向前移动">↑</button>
          <button type="button" onClick={() => move(index, index + 1)} disabled={index === photos.length - 1} aria-label="向后移动">↓</button>
          <button type="button" className="danger-text" onClick={() => onChange(photos.filter((item) => item.id !== photo.id))}>移除</button>
        </div>
      </article>)}
    </div>}

    {lightbox && <div className="lightbox" role="dialog" aria-modal="true" aria-label="照片放大预览" onClick={() => setLightbox(null)}>
      <button type="button" className="lightbox__close" onClick={() => setLightbox(null)} aria-label="关闭照片预览"><Icon name="close" /></button>
      <figure onClick={(event) => event.stopPropagation()}>
        <img src={`/${lightbox.src}`} alt={lightbox.caption || "照片预览"} />
        {lightbox.caption && <figcaption>{lightbox.caption}</figcaption>}
      </figure>
    </div>}
  </section>;
}

interface DrawerProps {
  drawer: DrawerState;
  board: Board;
  onClose: () => void;
  onUpdateCourse: (course: Course) => void;
  onUpdateTask: (task: BoardTask) => void;
  onAppendCoursePhotos: (courseId: string, photos: PhotoAttachment[]) => boolean;
  onAppendTaskPhotos: (taskId: string, photos: PhotoAttachment[]) => boolean;
  onCopyCourse: (course: Course) => void;
  onDeleteCourse: (course: Course) => void;
  onDeleteTask: (task: BoardTask) => void;
  onError: (message: string) => void;
  onPhotoWorkChange: (delta: 1 | -1) => void;
}

function EditorDrawer(props: DrawerProps) {
  const { drawer, board, onClose, onUpdateCourse, onUpdateTask, onAppendCoursePhotos, onAppendTaskPhotos, onCopyCourse, onDeleteCourse, onDeleteTask, onError, onPhotoWorkChange } = props;
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const course = drawer?.kind === "course" ? board.schedule.find((item) => item.id === drawer.id) : undefined;
  const task = drawer?.kind === "task" ? board.tasks.find((item) => item.id === drawer.id) : undefined;

  useEffect(() => {
    if (!drawer) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawer, onClose]);

  if (!drawer || (!course && !task)) return null;

  return <div className="drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="editor-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <header className="editor-drawer__header">
        <div>
          <p>{course ? "课程详情" : "事项详情"}</p>
          <h2 id="drawer-title">{course?.title || task?.title || "未命名"}</h2>
        </div>
        <button ref={closeButtonRef} type="button" className="icon-button" onClick={onClose} aria-label="关闭详情"><Icon name="close" /></button>
      </header>

      <div className="editor-drawer__body">
        {course && <>
          <div className="form-grid">
            <Field label="孩子">
              <select value={course.childId} onChange={(event) => onUpdateCourse({ ...course, childId: event.target.value as Course["childId"] })}>
                <option value="xiaoyue">黄小越</option><option value="xiaoyi">黄小翊</option>
              </select>
            </Field>
            <Field label="星期">
              <select value={course.weekday} onChange={(event) => onUpdateCourse({ ...course, weekday: Number(event.target.value) as Course["weekday"] })}>
                {["一", "二", "三", "四", "五", "六", "日"].map((day, index) => <option value={index + 1} key={day}>星期{day}</option>)}
              </select>
            </Field>
            <Field label="课程名称" wide><input value={course.title} onChange={(event) => onUpdateCourse({ ...course, title: event.target.value })} /></Field>
            <Field label="节次/时段"><input value={course.periodLabel ?? ""} onChange={(event) => onUpdateCourse({ ...course, periodLabel: event.target.value || undefined })} placeholder="如 第一节（可留空）" /></Field>
            <Field label="节次顺序"><input type="number" min="1" max="1000" value={course.periodOrder ?? ""} onChange={(event) => onUpdateCourse({ ...course, periodOrder: event.target.value ? Number(event.target.value) : undefined })} placeholder="用于排序" /></Field>
            <Field label="开始时间"><input type="time" value={course.startTime ?? ""} onChange={(event) => onUpdateCourse({ ...course, startTime: event.target.value || undefined })} /></Field>
            <Field label="结束时间"><input type="time" value={course.endTime ?? ""} onChange={(event) => onUpdateCourse({ ...course, endTime: event.target.value || undefined })} /></Field>
            <Field label="地点" wide><input value={course.location} onChange={(event) => onUpdateCourse({ ...course, location: event.target.value })} placeholder="可留空" /></Field>
            <Field label="备注" wide><textarea rows={4} value={course.note} onChange={(event) => onUpdateCourse({ ...course, note: event.target.value })} placeholder="可留空" /></Field>
          </div>
          <PhotoManager photos={course.photos} onAppend={(photos) => onAppendCoursePhotos(course.id, photos)} onChange={(photos) => onUpdateCourse({ ...course, photos })} onError={onError} onWorkChange={onPhotoWorkChange} />
        </>}

        {task && <>
          <div className="form-grid">
            <Field label="标题" wide><input value={task.title} onChange={(event) => onUpdateTask({ ...task, title: event.target.value })} /></Field>
            <Field label="关联">
              <select value={task.relatedTo} onChange={(event) => onUpdateTask({ ...task, relatedTo: event.target.value as BoardTask["relatedTo"] })}>
                <option value="xiaoyue">黄小越</option><option value="xiaoyi">黄小翊</option><option value="family">全家</option>
              </select>
            </Field>
            <Field label="截止日期"><input type="date" value={task.dueDate} onChange={(event) => onUpdateTask({ ...task, dueDate: event.target.value })} /></Field>
            <Field label="状态" wide>
              <select value={task.status} onChange={(event) => {
                const status = event.target.value as BoardTask["status"];
                onUpdateTask({ ...task, status, completedAt: status === "completed" ? (task.completedAt ?? new Date().toISOString()) : null });
              }}>
                <option value="not_started">未开始</option><option value="in_progress">进行中</option><option value="completed">已完成</option>
              </select>
            </Field>
            <Field label="备注" wide><textarea rows={5} value={task.note} onChange={(event) => onUpdateTask({ ...task, note: event.target.value })} placeholder="可留空" /></Field>
          </div>
          <PhotoManager photos={task.photos} onAppend={(photos) => onAppendTaskPhotos(task.id, photos)} onChange={(photos) => onUpdateTask({ ...task, photos })} onError={onError} onWorkChange={onPhotoWorkChange} />
        </>}
      </div>

      <footer className="editor-drawer__footer">
        {course && <button className="button" type="button" onClick={() => onCopyCourse(course)}><Icon name="copy" />复制课程</button>}
        <button className="button button--danger" type="button" onClick={() => course ? onDeleteCourse(course) : task && onDeleteTask(task)}><Icon name="trash" />删除{course ? "课程" : "事项"}</button>
      </footer>
    </aside>
  </div>;
}

function PublishDialog({ plan, busy, onCancel, onConfirm }: { plan: PublishPreflight; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);
  const groups = [
    ["课程", plan.summary.courses],
    ["事项", plan.summary.tasks],
  ] as const;
  return <div className="modal-layer" role="presentation">
    <section className="publish-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-dialog-title">
      <p className="dialog-eyebrow">发布前检查</p>
      <h2 id="publish-dialog-title">把当前快照发布到家庭页面？</h2>
      <p>本地保存与公开发布是两件事。确认后将构建只读页面、提交并推送到 GitHub Pages。</p>
      <div className="publish-summary">
        {groups.map(([label, counts]) => <div key={label}>
          <strong>{label}</strong>
          <span>新增 {counts.added}</span><span>修改 {counts.modified}</span><span>删除 {counts.deleted}</span>
        </div>)}
        <div><strong>照片</strong><span>新增 {plan.summary.photos.added}</span><span>移除 {plan.summary.photos.removed}</span></div>
      </div>
      {!plan.needsPublish && <p className="dialog-note">本地内容与已发布版本一致；仍会检查构建和远端同步状态。</p>}
      <div className="dialog-actions">
        <button ref={cancelRef} className="button" type="button" onClick={onCancel} disabled={busy}>取消</button>
        <button className="button button--primary" type="button" onClick={onConfirm} disabled={busy}><Icon name="publish" />{busy ? "正在发布…" : "确认发布"}</button>
      </div>
    </section>
  </div>;
}

export default function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [revision, setRevision] = useState("");
  const [publishedRevision, setPublishedRevision] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [view, setView] = useState<BoardView>("today");
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [conflict, setConflict] = useState<ConflictState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [undoSeconds, setUndoSeconds] = useState(0);
  const [publishPlan, setPublishPlan] = useState<PublishPreflight | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [photoWorkCount, setPhotoWorkCount] = useState(0);

  const boardRef = useRef<Board | null>(null);
  const revisionRef = useRef("");
  const publishedRevisionRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const mutationVersionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const photoWorkCountRef = useRef(0);

  const changePhotoWorkCount = useCallback((delta: 1 | -1) => {
    photoWorkCountRef.current = Math.max(0, photoWorkCountRef.current + delta);
    setPhotoWorkCount(photoWorkCountRef.current);
  }, []);

  const assignBoard = useCallback((next: Board, isDirty: boolean) => {
    boardRef.current = next;
    dirtyRef.current = isDirty;
    setBoard(next);
    if (isDirty) setSaveState("dirty");
  }, []);

  const mutateBoard = useCallback((producer: (draft: Board) => void) => {
    const current = boardRef.current;
    if (!current) return;
    const draft = cloneBoard(current);
    producer(draft);
    mutationVersionRef.current += 1;
    setPublishPlan(null);
    setNotice(null);
    assignBoard(draft, true);
  }, [assignBoard]);

  const requestSave = useCallback((kind: "manual" | "auto"): Promise<boolean> => {
    const run = saveQueueRef.current.then(async () => {
      if (photoWorkCountRef.current > 0) {
        if (kind === "manual") setNotice("照片仍在处理中；完成后再保存。");
        return false;
      }
      if (!dirtyRef.current || !boardRef.current) return true;
      const snapshot = cloneBoard(boardRef.current);
      const capturedVersion = mutationVersionRef.current;
      setSaveState("saving");
      setNotice(null);

      try {
        const response = await saveBoardRequest(snapshot, revisionRef.current);
        revisionRef.current = response.revision;
        publishedRevisionRef.current = response.publishedRevision;
        setRevision(response.revision);
        setPublishedRevision(response.publishedRevision);

        if (mutationVersionRef.current === capturedVersion) {
          assignBoard(response.board, false);
          setSaveState(kind === "auto" ? "autosaved" : "saved");
        } else {
          setSaveState("dirty");
        }
        return true;
      } catch (error) {
        dirtyRef.current = true;
        setSaveState("failed");
        setNotice(messageFromError(error));
        if (error instanceof ApiError && error.status === 409) {
          try {
            const disk = await getBoard();
            setConflict({ board: disk.board, revision: disk.revision, publishedRevision: disk.publishedRevision });
          } catch {
            // Keep the original conflict visible even if the follow-up read fails.
          }
        }
        return false;
      }
    });
    saveQueueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, [assignBoard]);

  const loadInitial = useCallback(async () => {
    try {
      const response = await getBoard();
      revisionRef.current = response.revision;
      publishedRevisionRef.current = response.publishedRevision;
      setRevision(response.revision);
      setPublishedRevision(response.publishedRevision);
      assignBoard(response.board, false);
      setSaveState("saved");
      setFatalError(null);
    } catch (error) {
      setFatalError(messageFromError(error));
      setSaveState("failed");
    }
  }, [assignBoard]);

  useEffect(() => { void loadInitial(); }, [loadInitial]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (dirtyRef.current) void requestSave("auto");
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [requestSave]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void requestSave("manual");
      }
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current || photoWorkCountRef.current > 0) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [requestSave]);

  useEffect(() => {
    const onFocus = async () => {
      if (!revisionRef.current || saveState === "saving") return;
      try {
        const current = await getRevision();
        if (current.publishedRevision !== publishedRevisionRef.current) {
          publishedRevisionRef.current = current.publishedRevision;
          setPublishedRevision(current.publishedRevision);
        }
        if (current.revision === revisionRef.current) return;
        const disk = await getBoard();
        if (dirtyRef.current) {
          setConflict({ board: disk.board, revision: disk.revision, publishedRevision: disk.publishedRevision });
          setNotice("磁盘上的日程已被其他程序修改。为防止覆盖，本地修改尚未保存。");
        } else {
          revisionRef.current = disk.revision;
          publishedRevisionRef.current = disk.publishedRevision;
          setRevision(disk.revision);
          setPublishedRevision(disk.publishedRevision);
          assignBoard(disk.board, false);
          setSaveState("saved");
          setNotice("已自动载入磁盘上的最新版本。");
        }
      } catch (error) {
        setNotice(`检查磁盘版本失败：${messageFromError(error)}`);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [assignBoard, saveState]);

  useEffect(() => {
    if (!undo) return;
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((undo.expiresAt - Date.now()) / 1000));
      setUndoSeconds(seconds);
      if (seconds === 0) setUndo(null);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [undo]);

  const hasUnsavedDraft = photoWorkCount > 0 || saveState === "dirty" || saveState === "saving" || saveState === "failed";
  const isPublished = !hasUnsavedDraft && Boolean(revision && revision === publishedRevision);
  const saveLabel = photoWorkCount > 0 ? "正在处理照片" : SAVE_LABELS[saveState];
  const publicationLabel = hasUnsavedDraft
    ? "当前修改尚未发布"
    : isPublished ? "已发布" : "本地已保存、尚未发布";

  const updateCourse = useCallback((course: Course) => {
    mutateBoard((draft) => {
      const index = draft.schedule.findIndex((item) => item.id === course.id);
      if (index >= 0) draft.schedule[index] = course;
    });
  }, [mutateBoard]);

  const updateTask = useCallback((task: BoardTask) => {
    mutateBoard((draft) => {
      const index = draft.tasks.findIndex((item) => item.id === task.id);
      if (index >= 0) draft.tasks[index] = task;
    });
  }, [mutateBoard]);

  const appendCoursePhotos = useCallback((courseId: string, photos: PhotoAttachment[]) => {
    let appended = false;
    mutateBoard((draft) => {
      const course = draft.schedule.find((item) => item.id === courseId);
      if (course) {
        course.photos.push(...photos);
        appended = true;
      }
    });
    return appended;
  }, [mutateBoard]);

  const appendTaskPhotos = useCallback((taskId: string, photos: PhotoAttachment[]) => {
    let appended = false;
    mutateBoard((draft) => {
      const task = draft.tasks.find((item) => item.id === taskId);
      if (task) {
        task.photos.push(...photos);
        appended = true;
      }
    });
    return appended;
  }, [mutateBoard]);

  const addCourse = () => {
    const course: Course = {
      id: makeId("course"), childId: "xiaoyue", weekday: shanghaiWeekday() as Course["weekday"], title: "新课程",
      periodLabel: "第一节", periodOrder: 20, location: "", note: "", photos: [],
    };
    mutateBoard((draft) => { draft.schedule.push(course); });
    setView("week");
    setDrawer({ kind: "course", id: course.id });
  };

  const addTask = () => {
    const task: BoardTask = {
      id: makeId("task"), title: "新事项", relatedTo: "family", dueDate: shanghaiDateKey(),
      status: "not_started", completedAt: null, note: "", photos: [],
    };
    mutateBoard((draft) => { draft.tasks.push(task); });
    setView("tasks");
    setDrawer({ kind: "task", id: task.id });
  };

  const copyCourse = (course: Course) => {
    const copy: Course = {
      ...structuredClone(course),
      id: makeId("course"),
      title: `${course.title}（副本）`,
      photos: course.photos.map((photo) => ({ ...structuredClone(photo), id: makeId("photo") })),
    };
    mutateBoard((draft) => { draft.schedule.push(copy); });
    setDrawer({ kind: "course", id: copy.id });
  };

  const deleteCourse = (course: Course) => {
    if (!window.confirm(`确定删除课程“${course.title}”吗？`)) return;
    mutateBoard((draft) => { draft.schedule = draft.schedule.filter((item) => item.id !== course.id); });
    setDrawer(null);
  };

  const deleteTask = (task: BoardTask) => {
    const index = boardRef.current?.tasks.findIndex((item) => item.id === task.id) ?? -1;
    mutateBoard((draft) => { draft.tasks = draft.tasks.filter((item) => item.id !== task.id); });
    setDrawer(null);
    setUndo({ task, index: Math.max(0, index), expiresAt: Date.now() + 8_000 });
  };

  const undoDelete = () => {
    if (!undo) return;
    mutateBoard((draft) => { draft.tasks.splice(Math.min(undo.index, draft.tasks.length), 0, undo.task); });
    setUndo(null);
    setDrawer({ kind: "task", id: undo.task.id });
  };

  const discardAndReload = () => {
    if (!conflict) return;
    mutationVersionRef.current += 1;
    revisionRef.current = conflict.revision;
    publishedRevisionRef.current = conflict.publishedRevision;
    setRevision(conflict.revision);
    setPublishedRevision(conflict.publishedRevision);
    assignBoard(conflict.board, false);
    setConflict(null);
    setSaveState("saved");
    setNotice("已放弃本地修改并载入磁盘版本。");
  };

  const beginPublish = async () => {
    if (photoWorkCountRef.current > 0) {
      setNotice("照片仍在处理中；完成并保存后再发布。");
      return;
    }
    setPublishing(true);
    setNotice(null);
    try {
      if (dirtyRef.current && !(await requestSave("manual"))) return;
      const plan = await getPublishPreflight(revisionRef.current);
      if (plan.git?.blocked) {
        if (plan.git.branch && plan.git.branch !== "main") {
          setNotice(`发布已停止：当前 Git 分支是 ${plan.git.branch}，只能从 main 发布。请交给 Codex 处理。`);
        } else {
          setNotice(`发布已停止：发现日程数据与发布媒体之外的未提交修改：${plan.git.unrelatedPaths?.join("、") || "未知路径"}。请交给 Codex 处理。`);
        }
        return;
      }
      setPublishPlan(plan);
    } catch (error) {
      setNotice(`发布前检查失败：${messageFromError(error)}`);
    } finally {
      setPublishing(false);
    }
  };

  const confirmPublish = async () => {
    if (!publishPlan) return;
    const confirmedPlan = publishPlan;
    if (photoWorkCountRef.current > 0 || dirtyRef.current || revisionRef.current !== confirmedPlan.revision) {
      setPublishPlan(null);
      setNotice("日程在发布确认前发生了变化。请重新执行发布前检查并确认最新摘要。");
      return;
    }
    const confirmedMutationVersion = mutationVersionRef.current;
    setPublishing(true);
    try {
      const result = await publishBoard(confirmedPlan.revision, confirmedPlan.preflightToken);
      if (!result.published) throw new Error("Git push 未成功，公开页面尚未更新");
      publishedRevisionRef.current = result.publishedRevision;
      setPublishedRevision(result.publishedRevision);
      setPublishPlan(null);
      const hasNewBrowserDraft = dirtyRef.current
        || mutationVersionRef.current !== confirmedMutationVersion;
      if (hasNewBrowserDraft) {
        if (result.revision !== confirmedPlan.revision) {
          setConflict({
            board: result.board,
            revision: result.revision,
            publishedRevision: result.publishedRevision,
          });
          setNotice(`已发布确认时的版本（提交 ${result.commitSha.slice(0, 8)}）；发布期间浏览器和磁盘内容都发生了变化，本地草稿已保留，请先处理版本冲突。`);
        } else {
          setNotice(`已发布确认时的版本（提交 ${result.commitSha.slice(0, 8)}）；发布期间新增的本地修改已保留，尚未保存或发布。`);
        }
        if (dirtyRef.current) setSaveState("dirty");
      } else {
        mutationVersionRef.current += 1;
        revisionRef.current = result.revision;
        setRevision(result.revision);
        assignBoard(result.board, false);
        setSaveState("saved");
        setDrawer(null);
        setNotice(result.needsPublish
          ? `已发布确认时的版本（提交 ${result.commitSha.slice(0, 8)}）；同时载入了磁盘上的更新内容，该内容尚未发布。`
          : `已发布到家庭页面。提交 ${result.commitSha.slice(0, 8)}。`);
      }
    } catch (error) {
      setNotice(`发布失败：${messageFromError(error)}`);
    } finally {
      setPublishing(false);
    }
  };

  const openPreview = () => {
    if (dirtyRef.current) setNotice("只读预览显示上一次保存到磁盘的版本；请先保存以查看当前修改。");
    window.open("/index.html?preview=local", "_blank", "noopener,noreferrer");
  };

  const errorPanel = useMemo(() => {
    if (!fatalError) return null;
    return <div className="fatal-panel"><h1>本地日程暂时无法打开</h1><p>{fatalError}</p><button className="button button--primary" type="button" onClick={() => void loadInitial()}>重新读取</button></div>;
  }, [fatalError, loadInitial]);

  if (errorPanel) return errorPanel;
  if (!board) return <div className="editor-loading"><span className="loading-orbit" />正在读取本地日程…</div>;

  return <div className="editor-app">
    <header className="editor-commandbar">
      <div className="editor-commandbar__identity">
        <span className="local-mark">LOCAL</span>
        <div><strong>家庭日程板</strong><span>本地编辑器 · 仅 127.0.0.1</span></div>
      </div>
      <div className="save-ledger" aria-live="polite">
        <span className={`state-pill state-pill--${saveState}`}>{saveLabel}</span>
        <span className={`state-pill ${isPublished ? "state-pill--published" : "state-pill--unpublished"}`}>{publicationLabel}</span>
      </div>
      <div className="editor-commandbar__actions">
        <button className="button" type="button" onClick={openPreview}><Icon name="preview" />只读预览</button>
        <button className="button" type="button" onClick={() => void requestSave("manual")} disabled={photoWorkCount > 0 || saveState === "saving" || !dirtyRef.current}><Icon name="save" />保存</button>
        <button className="button button--primary" type="button" onClick={() => void beginPublish()} disabled={photoWorkCount > 0 || publishing || saveState === "saving"}><Icon name="publish" />{publishing ? "检查中…" : "发布到家庭页面"}</button>
      </div>
    </header>

    {conflict && <section className="conflict-banner" role="alert">
      <div><strong>检测到磁盘版本冲突</strong><p>Codex 或其他程序已修改 board.json。当前本地改动不会被静默覆盖。</p></div>
      <button className="button button--danger" type="button" onClick={discardAndReload}>放弃本地修改并载入磁盘版本</button>
    </section>}
    {notice && <div className="editor-notice" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice(null)} aria-label="关闭提示"><Icon name="close" /></button></div>}

    <div className="editor-createbar">
      <p><strong>编辑保存在本机。</strong> 自动保存每 60 秒仅在有修改时运行，绝不会自动发布。</p>
      <div><button className="button button--small" type="button" onClick={addCourse}><Icon name="plus" />新增课程</button><button className="button button--small" type="button" onClick={addTask}><Icon name="plus" />新增事项</button></div>
    </div>

    <BoardWorkspace
      board={board}
      mode="editor"
      selectedView={view}
      setSelectedView={setView}
      onSelectCourse={(course) => setDrawer({ kind: "course", id: course.id })}
      onSelectTask={(task) => setDrawer({ kind: "task", id: task.id })}
    />

    <EditorDrawer
      drawer={drawer}
      board={board}
      onClose={() => setDrawer(null)}
      onUpdateCourse={updateCourse}
      onUpdateTask={updateTask}
      onAppendCoursePhotos={appendCoursePhotos}
      onAppendTaskPhotos={appendTaskPhotos}
      onCopyCourse={copyCourse}
      onDeleteCourse={deleteCourse}
      onDeleteTask={deleteTask}
      onError={setNotice}
      onPhotoWorkChange={changePhotoWorkCount}
    />

    {undo && <div className="undo-toast" role="status"><span>已删除“{undo.task.title}” · {undoSeconds} 秒内可撤销</span><button type="button" onClick={undoDelete}>撤销</button></div>}
    {publishPlan && <PublishDialog plan={publishPlan} busy={publishing} onCancel={() => setPublishPlan(null)} onConfirm={() => void confirmPublish()} />}
  </div>;
}
