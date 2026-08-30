import { useCallback, useEffect, useRef, useState } from "react";
import BoardWorkspace from "../shared/BoardWorkspace";
import {
  TASK_STATUS_LABELS,
  WEEKDAY_LABELS,
  childName,
  formatDateKey,
  formatTimestamp,
  relatedName,
} from "../shared/board-utils";
import type {
  Board,
  BoardSelection,
  BoardTask,
  Course,
  PhotoAttachment,
} from "../shared/types";

type LoadState = "loading" | "ready" | "refreshing" | "error";

function parseBoard(value: unknown): Board {
  if (!value || typeof value !== "object") throw new Error("日程数据格式不正确");
  const board = value as Partial<Board>;
  if (!board.meta || !Array.isArray(board.children) || !Array.isArray(board.schedule) || !Array.isArray(board.tasks)) {
    throw new Error("日程数据缺少必要内容");
  }
  return {
    ...(board as Board),
    schedule: board.schedule.map((course) => ({ ...course, photos: course.photos ?? [] })),
    tasks: board.tasks.map((task) => ({
      ...task,
      photos: task.photos ?? [],
      completedAt: task.completedAt ?? null,
    })),
  };
}

function PhotoGallery({
  photos,
  fallback,
  onOpen,
}: {
  photos: PhotoAttachment[];
  fallback: string;
  onOpen: (photo: PhotoAttachment) => void;
}) {
  if (photos.length === 0) {
    return <p className="fb-drawer__empty-photo">没有关联照片。</p>;
  }
  return (
    <div className="fb-photo-gallery">
      {photos.map((photo) => (
        <figure key={photo.id}>
          <button type="button" onClick={() => onOpen(photo)} aria-label={`放大照片：${photo.caption || fallback}`}>
            <img
              src={photo.thumbnail}
              alt={photo.caption || fallback}
              width={photo.width}
              height={photo.height}
              loading="lazy"
            />
          </button>
          {photo.caption ? <figcaption>{photo.caption}</figcaption> : null}
        </figure>
      ))}
    </div>
  );
}

function DetailRows({ children }: { children: React.ReactNode }) {
  return <dl className="fb-detail-rows">{children}</dl>;
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ReadOnlyDrawer({
  board,
  selection,
  onClose,
  onOpenPhoto,
}: {
  board: Board;
  selection: BoardSelection;
  onClose: () => void;
  onOpenPhoto: (photo: PhotoAttachment) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const isCourse = selection.kind === "course";
  const item = selection.item;
  useEffect(() => {
    closeRef.current?.focus();
  }, [selection]);

  return (
    <div className="fb-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="fb-drawer" role="dialog" aria-modal="true" aria-labelledby="fb-detail-title">
        <header className="fb-drawer__header">
          <div>
            <span className="fb-drawer__eyebrow">{isCourse ? "课程详情" : "事项详情"} · 只读</span>
            <h2 id="fb-detail-title">{item.title}</h2>
          </div>
          <button ref={closeRef} type="button" className="fb-close-button" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="fb-drawer__body">
          {selection.kind === "course" ? (
            <CourseDetails board={board} course={selection.item} />
          ) : (
            <TaskDetails board={board} task={selection.item} />
          )}
          <section className="fb-drawer__photos" aria-labelledby="fb-photo-heading">
            <div className="fb-drawer__section-heading">
              <h3 id="fb-photo-heading">照片</h3>
              <span>{item.photos.length} 张</span>
            </div>
            <PhotoGallery photos={item.photos} fallback={item.title} onOpen={onOpenPhoto} />
          </section>
        </div>
      </aside>
    </div>
  );
}

function CourseDetails({ board, course }: { board: Board; course: Course }) {
  return (
    <DetailRows>
      <DetailRow label="孩子">{childName(board, course.childId)}</DetailRow>
      <DetailRow label="星期">{WEEKDAY_LABELS[course.weekday]}</DetailRow>
      <DetailRow label="时间">{course.startTime}–{course.endTime}</DetailRow>
      <DetailRow label="地点">{course.location || "未填写"}</DetailRow>
      <DetailRow label="备注">{course.note || "没有备注"}</DetailRow>
    </DetailRows>
  );
}

function TaskDetails({ board, task }: { board: Board; task: BoardTask }) {
  return (
    <DetailRows>
      <DetailRow label="关联">{relatedName(board, task.relatedTo)}</DetailRow>
      <DetailRow label="截止日期">{formatDateKey(task.dueDate, { weekday: true })}</DetailRow>
      <DetailRow label="状态">{TASK_STATUS_LABELS[task.status]}</DetailRow>
      {task.completedAt ? (
        <DetailRow label="完成时间">{formatTimestamp(task.completedAt, board.meta.timezone)}</DetailRow>
      ) : null}
      <DetailRow label="备注">{task.note || "没有备注"}</DetailRow>
    </DetailRows>
  );
}

function PhotoLightbox({ photo, onClose }: { photo: PhotoAttachment; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, [photo]);
  return (
    <div className="fb-lightbox" role="dialog" aria-modal="true" aria-label={photo.caption || "照片预览"}>
      <button ref={closeRef} type="button" className="fb-lightbox__close" onClick={onClose}>
        关闭照片
      </button>
      <figure>
        <img src={photo.src} alt={photo.caption || "关联照片"} width={photo.width} height={photo.height} />
        {photo.caption ? <figcaption>{photo.caption}</figcaption> : null}
      </figure>
    </div>
  );
}

export function ViewerApp() {
  const [board, setBoard] = useState<Board | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [selection, setSelection] = useState<BoardSelection | null>(null);
  const [lightboxPhoto, setLightboxPhoto] = useState<PhotoAttachment | null>(null);
  const lastFocus = useRef<HTMLElement | null>(null);

  const loadBoard = useCallback(async (refresh = false) => {
    setLoadState(refresh ? "refreshing" : "loading");
    setErrorMessage("");
    try {
      const response = await fetch(`./data/board.json?t=${Date.now()}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`读取日程数据失败（HTTP ${response.status}）`);
      const nextBoard = parseBoard(await response.json());
      setBoard(nextBoard);
      setLoadState("ready");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "暂时无法读取日程数据");
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    if (board) document.title = board.meta.title;
  }, [board]);

  useEffect(() => {
    if (!selection) return;
    document.body.classList.add("fb-overlay-open");
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (lightboxPhoto) setLightboxPhoto(null);
      else setSelection(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.classList.remove("fb-overlay-open");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [selection, lightboxPhoto]);

  const openSelection = (next: BoardSelection) => {
    lastFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelection(next);
  };

  const closeSelection = () => {
    setLightboxPhoto(null);
    setSelection(null);
    window.setTimeout(() => lastFocus.current?.focus(), 0);
  };

  const title = board?.meta.title || "黄家日程板";

  return (
    <div className="fb-viewer-shell">
      <a className="fb-skip-link" href="#fb-main">跳到主要内容</a>
      <header className="fb-site-header">
        <div className="fb-site-header__brand">
          <span className="fb-family-mark" aria-hidden="true"><i /><i /></span>
          <div>
            <p>黄家 · 一周安排</p>
            <h1>{title}</h1>
          </div>
        </div>
        <div className="fb-site-header__status" aria-label="页面状态">
          <div className="fb-public-badges">
            <span className="fb-public-badge">公开页面</span>
            <span className="fb-readonly-badge">只读预览</span>
          </div>
          <p>
            <span>数据最后更新</span>
            <strong>{board ? formatTimestamp(board.meta.lastUpdated, board.meta.timezone) : "正在读取…"}</strong>
          </p>
          <button
            type="button"
            className="fb-refresh-button"
            onClick={() => void loadBoard(true)}
            disabled={loadState === "loading" || loadState === "refreshing"}
            aria-busy={loadState === "refreshing"}
          >
            {loadState === "refreshing" ? "刷新中…" : "刷新数据"}
          </button>
        </div>
      </header>

      <main id="fb-main">
        {loadState === "error" && !board ? (
          <section className="fb-load-panel" role="alert">
            <p className="fb-kicker">数据未能读取</p>
            <h2>日程板暂时打不开</h2>
            <p>{errorMessage}</p>
            <button type="button" onClick={() => void loadBoard()}>重新读取</button>
          </section>
        ) : board ? (
          <>
            {loadState === "error" ? (
              <div className="fb-inline-alert" role="status">刷新失败，仍显示上一次成功读取的内容。</div>
            ) : null}
            <BoardWorkspace
              board={board}
              mode="viewer"
              onSelectCourse={(course) => openSelection({ kind: "course", item: course })}
              onSelectTask={(task) => openSelection({ kind: "task", item: task })}
            />
          </>
        ) : (
          <section className="fb-loading-panel" aria-live="polite">
            <span className="fb-loading-line" />
            <span className="fb-loading-line fb-loading-line--short" />
            <p>正在整理家庭日程…</p>
          </section>
        )}
      </main>

      <footer className="fb-site-footer">
        <p>公开只读日程 · 请勿在照片或文字中放置地址、电话、证件等敏感信息</p>
      </footer>

      {board && selection ? (
        <ReadOnlyDrawer
          board={board}
          selection={selection}
          onClose={closeSelection}
          onOpenPhoto={setLightboxPhoto}
        />
      ) : null}
      {lightboxPhoto ? <PhotoLightbox photo={lightboxPhoto} onClose={() => setLightboxPhoto(null)} /> : null}
    </div>
  );
}

export default ViewerApp;
