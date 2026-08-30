import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  TASK_STATUS_LABELS,
  WEEKDAY_LABELS,
  childName,
  compareCourses,
  currentWeekDateKeys,
  formatDateKey,
  getTaskBuckets,
  getTodayCourseState,
  getZonedNow,
  isTaskOverdue,
  relatedName,
  sortedTasks,
} from "./board-utils";
import {
  BOARD_VIEWS,
  CHILD_IDS,
  TASK_STATUSES,
  type Board,
  type BoardMode,
  type BoardTask,
  type BoardView,
  type ChildId,
  type Course,
  type TaskStatus,
  type Weekday,
} from "./types";

export interface BoardWorkspaceProps {
  board: Board;
  mode: BoardMode;
  selectedView?: BoardView;
  setSelectedView?: (view: BoardView) => void;
  onSelectCourse?: (course: Course) => void;
  onSelectTask?: (task: BoardTask) => void;
}

type ChildFilter = "all" | ChildId;
type TaskLayout = "board" | "list";

const VIEW_LABELS: Record<BoardView, string> = {
  today: "今日",
  week: "本周课表",
  tasks: "近期事项",
};

function Surface({
  className,
  label,
  onClick,
  children,
}: {
  className: string;
  label: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  if (onClick) {
    return (
      <button type="button" className={`${className} fb-surface-button`} onClick={onClick}>
        <span className="fb-visually-hidden">{label}</span>
        {children}
      </button>
    );
  }
  return <article className={className}>{children}</article>;
}

function PhotoPeek({
  photos,
  fallback,
}: {
  photos: Course["photos"] | BoardTask["photos"];
  fallback: string;
}) {
  const first = photos?.[0];
  if (!first) return null;
  return (
    <span className="fb-photo-peek" aria-label={`${photos.length} 张照片`}>
      <img
        src={first.thumbnail}
        alt={first.caption || fallback}
        width={first.width}
        height={first.height}
        loading="lazy"
      />
      {photos.length > 1 ? <span className="fb-photo-count">+{photos.length - 1}</span> : null}
    </span>
  );
}

function CourseCard({
  board,
  course,
  emphasis,
  onSelect,
}: {
  board: Board;
  course: Course;
  emphasis?: "current" | "next";
  onSelect?: (course: Course) => void;
}) {
  return (
    <Surface
      className={`fb-course-card fb-course-card--${course.childId}${
        emphasis ? ` fb-course-card--${emphasis}` : ""
      }`}
      label={`查看课程详情：${course.title}`}
      onClick={onSelect ? () => onSelect(course) : undefined}
    >
      <span className="fb-course-card__time">
        {course.startTime}–{course.endTime}
      </span>
      <span className="fb-course-card__title">{course.title}</span>
      <span className="fb-course-card__person">{childName(board, course.childId)}</span>
      {course.location ? <span className="fb-course-card__meta">{course.location}</span> : null}
      <PhotoPeek photos={course.photos ?? []} fallback={course.title} />
    </Surface>
  );
}

function TaskCard({
  board,
  task,
  compact = false,
  onSelect,
}: {
  board: Board;
  task: BoardTask;
  compact?: boolean;
  onSelect?: (task: BoardTask) => void;
}) {
  const overdue = isTaskOverdue(task, board.meta.timezone);
  return (
    <Surface
      className={`fb-task-card fb-task-card--${task.status.replaceAll("_", "-")}${
        overdue ? " fb-task-card--overdue" : ""
      }${compact ? " fb-task-card--compact" : ""}`}
      label={`查看事项详情：${task.title}`}
      onClick={onSelect ? () => onSelect(task) : undefined}
    >
      <span className="fb-task-card__topline">
        <span className={`fb-status-dot fb-status-dot--${task.status.replaceAll("_", "-")}`} />
        <span>{TASK_STATUS_LABELS[task.status]}</span>
        {overdue ? <span className="fb-overdue-flag">已超期</span> : null}
      </span>
      <span className="fb-task-card__title">{task.title}</span>
      <span className="fb-task-card__facts">
        <span>{relatedName(board, task.relatedTo)}</span>
        <time dateTime={task.dueDate}>{formatDateKey(task.dueDate, { weekday: true })}</time>
      </span>
      {!compact && task.note ? <span className="fb-task-card__note">{task.note}</span> : null}
      <PhotoPeek photos={task.photos ?? []} fallback={task.title} />
    </Surface>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="fb-empty-state">{children}</div>;
}

function TodayView({
  board,
  at,
  onSelectCourse,
  onSelectTask,
  showTasks,
}: {
  board: Board;
  at: Date;
  onSelectCourse?: (course: Course) => void;
  onSelectTask?: (task: BoardTask) => void;
  showTasks: () => void;
}) {
  const now = getZonedNow(board.meta.timezone, at);
  const courseStates = useMemo(
    () =>
      Object.fromEntries(
        CHILD_IDS.map((childId) => [childId, getTodayCourseState(board, childId, at)]),
      ) as Record<ChildId, ReturnType<typeof getTodayCourseState>>,
    [at, board],
  );
  const taskBuckets = useMemo(() => getTaskBuckets(board, at), [at, board]);
  const courseCount = CHILD_IDS.reduce(
    (sum, childId) => sum + courseStates[childId].courses.length,
    0,
  );
  const urgentCount = taskBuckets.overdue.length + taskBuckets.dueToday.length;

  return (
    <div className="fb-today-view">
      <header className="fb-today-hero">
        <div className="fb-date-stamp" aria-label={`${now.month}月${now.day}日 ${WEEKDAY_LABELS[now.weekday]}`}>
          <span className="fb-date-stamp__month">{now.year} · {now.month}月</span>
          <strong>{String(now.day).padStart(2, "0")}</strong>
          <span>{WEEKDAY_LABELS[now.weekday]}</span>
        </div>
        <div className="fb-today-hero__copy">
          <p className="fb-kicker">今天先看这里</p>
          <h2>今天的节奏，一眼看清</h2>
          <p>
            {courseCount > 0 ? `今天有 ${courseCount} 节课` : "今天没有课程"}；
            {urgentCount > 0 ? `${urgentCount} 项已经到期或超期。` : "没有到期事项。"}
          </p>
        </div>
      </header>

      <section className="fb-section" aria-labelledby="fb-today-course-title">
        <div className="fb-section-heading">
          <div>
            <p className="fb-kicker">课程</p>
            <h3 id="fb-today-course-title">两个人今天怎么安排</h3>
          </div>
          <p>当前、下一节与全天课程按时间排列。</p>
        </div>
        <div className="fb-child-lanes">
          {CHILD_IDS.map((childId) => {
            const state = courseStates[childId];
            return (
              <section key={childId} className={`fb-child-lane fb-child-lane--${childId}`}>
                <header className="fb-child-lane__header">
                  <h4>{childName(board, childId)}</h4>
                  <span>{state.courses.length} 节课</span>
                </header>
                <div className="fb-course-focus-grid">
                  <div className="fb-course-focus fb-course-focus--current">
                    <span>正在进行</span>
                    <strong>
                      {state.current
                        ? `${state.current.startTime} · ${state.current.title}`
                        : "当前没有课程"}
                    </strong>
                  </div>
                  <div className="fb-course-focus fb-course-focus--next">
                    <span>下一节</span>
                    <strong>
                      {state.next ? `${state.next.startTime} · ${state.next.title}` : "今天没有下一节"}
                    </strong>
                  </div>
                </div>
                <div className="fb-course-stack">
                  {state.courses.length > 0 ? (
                    state.courses.map((course) => (
                      <CourseCard
                        key={course.id}
                        board={board}
                        course={course}
                        emphasis={
                          course.id === state.current?.id
                            ? "current"
                            : course.id === state.next?.id
                              ? "next"
                              : undefined
                        }
                        onSelect={onSelectCourse}
                      />
                    ))
                  ) : (
                    <EmptyState>今天没有安排课程。</EmptyState>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </section>

      <section className="fb-section fb-section--tasks" aria-labelledby="fb-today-task-title">
        <div className="fb-section-heading">
          <div>
            <p className="fb-kicker">事项</p>
            <h3 id="fb-today-task-title">现在最需要留意什么</h3>
          </div>
          <button type="button" className="fb-text-action" onClick={showTasks}>
            查看全部事项
          </button>
        </div>
        <div className="fb-deadline-grid">
          {(
            [
              ["overdue", "已超期", taskBuckets.overdue, "没有超期事项。"],
              ["today", "今天截止", taskBuckets.dueToday, "今天没有截止事项。"],
              ["upcoming", "接下来", taskBuckets.upcoming.slice(0, 4), "近期没有截止事项。"],
            ] as const
          ).map(([tone, label, tasks, empty]) => (
            <section key={tone} className={`fb-deadline-group fb-deadline-group--${tone}`}>
              <header>
                <h4>{label}</h4>
                <span>{tone === "upcoming" ? taskBuckets.upcoming.length : tasks.length}</span>
              </header>
              <div className="fb-deadline-group__list">
                {tasks.length > 0 ? (
                  tasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      board={board}
                      task={task}
                      compact
                      onSelect={onSelectTask}
                    />
                  ))
                ) : (
                  <EmptyState>{empty}</EmptyState>
                )}
              </div>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}

function WeekView({
  board,
  at,
  onSelectCourse,
}: {
  board: Board;
  at: Date;
  onSelectCourse?: (course: Course) => void;
}) {
  const [filter, setFilter] = useState<ChildFilter>("all");
  const now = getZonedNow(board.meta.timezone, at);
  const weekDates = currentWeekDateKeys(board.meta.timezone, at);
  const schedule = useMemo(
    () =>
      board.schedule
        .filter((course) => filter === "all" || course.childId === filter)
        .slice()
        .sort(compareCourses),
    [board.schedule, filter],
  );

  return (
    <div className="fb-week-view">
      <header className="fb-panel-heading">
        <div>
          <p className="fb-kicker">星期一至星期日</p>
          <h2>本周课表</h2>
          <p>宽屏横向对照整周；手机按日期从上往下查看。</p>
        </div>
        <div className="fb-segmented" role="group" aria-label="按家庭成员筛选课表">
          {(["all", ...CHILD_IDS] as ChildFilter[]).map((childId) => (
            <button
              key={childId}
              type="button"
              aria-pressed={filter === childId}
              onClick={() => setFilter(childId)}
            >
              {childId === "all" ? "全部" : childName(board, childId)}
            </button>
          ))}
        </div>
      </header>
      <div className="fb-week-grid">
        {weekDates.map((dateKey, index) => {
          const weekday = (index + 1) as Weekday;
          const courses = schedule.filter((course) => course.weekday === weekday);
          const today = weekday === now.weekday;
          return (
            <section key={weekday} className={`fb-day-column${today ? " fb-day-column--today" : ""}`}>
              <header className="fb-day-column__header">
                <div>
                  <span>{WEEKDAY_LABELS[weekday]}</span>
                  <strong>{formatDateKey(dateKey)}</strong>
                </div>
                {today ? <em>今天</em> : null}
              </header>
              <div className="fb-day-column__courses">
                {courses.length > 0 ? (
                  courses.map((course) => (
                    <CourseCard
                      key={course.id}
                      board={board}
                      course={course}
                      onSelect={onSelectCourse}
                    />
                  ))
                ) : (
                  <EmptyState>当天没有课程。</EmptyState>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TasksView({
  board,
  onSelectTask,
}: {
  board: Board;
  onSelectTask?: (task: BoardTask) => void;
}) {
  const [layout, setLayout] = useState<TaskLayout>("board");
  const tasks = useMemo(() => sortedTasks(board), [board]);

  return (
    <div className="fb-tasks-view">
      <header className="fb-panel-heading">
        <div>
          <p className="fb-kicker">到期时间与完成进度</p>
          <h2>近期事项</h2>
          <p>用看板看进度，用列表按时间快速扫一遍。</p>
        </div>
        <div className="fb-segmented fb-segmented--compact" role="group" aria-label="事项显示方式">
          <button type="button" aria-pressed={layout === "board"} onClick={() => setLayout("board")}>
            看板
          </button>
          <button type="button" aria-pressed={layout === "list"} onClick={() => setLayout("list")}>
            列表
          </button>
        </div>
      </header>

      {tasks.length === 0 ? (
        <div className="fb-large-empty">
          <span>近期事项</span>
          <strong>现在没有需要跟进的事项</strong>
          <p>新的家庭事项会按截止日期和状态出现在这里。</p>
        </div>
      ) : layout === "board" ? (
        <div className="fb-task-board">
          {TASK_STATUSES.map((status) => {
            const columnTasks = tasks.filter((task) => task.status === status);
            return (
              <section key={status} className={`fb-task-column fb-task-column--${status.replaceAll("_", "-")}`}>
                <header>
                  <h3>{TASK_STATUS_LABELS[status]}</h3>
                  <span>{columnTasks.length}</span>
                </header>
                <div className="fb-task-column__cards">
                  {columnTasks.length > 0 ? (
                    columnTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        board={board}
                        task={task}
                        onSelect={onSelectTask}
                      />
                    ))
                  ) : (
                    <EmptyState>这一栏暂时为空。</EmptyState>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="fb-task-list">
          {tasks.map((task) => (
            <TaskCard key={task.id} board={board} task={task} onSelect={onSelectTask} />
          ))}
        </div>
      )}
    </div>
  );
}

export function BoardWorkspace({
  board,
  mode,
  selectedView,
  setSelectedView,
  onSelectCourse,
  onSelectTask,
}: BoardWorkspaceProps) {
  const [internalView, setInternalView] = useState<BoardView>("today");
  const [clock, setClock] = useState(() => Date.now());
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeView = selectedView ?? internalView;
  const at = useMemo(() => new Date(clock), [clock]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const changeView = (view: BoardView) => {
    if (setSelectedView) setSelectedView(view);
    else setInternalView(view);
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % BOARD_VIEWS.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + BOARD_VIEWS.length) % BOARD_VIEWS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = BOARD_VIEWS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextView = BOARD_VIEWS[nextIndex];
    changeView(nextView);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <section
      className={`fb-workspace fb-workspace--${mode}`}
      aria-label={mode === "viewer" ? "只读家庭日程" : "家庭日程"}
    >
      <nav className="fb-view-tabs" aria-label="日程板主视图">
        <div role="tablist" aria-label="选择要查看的内容">
          {BOARD_VIEWS.map((view, index) => (
            <button
              key={view}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              id={`fb-${view}-tab`}
              type="button"
              role="tab"
              aria-selected={activeView === view}
              aria-controls={`fb-${view}-panel`}
              tabIndex={activeView === view ? 0 : -1}
              onClick={() => changeView(view)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {VIEW_LABELS[view]}
            </button>
          ))}
        </div>
      </nav>

      <div
        id="fb-today-panel"
        role="tabpanel"
        aria-labelledby="fb-today-tab"
        hidden={activeView !== "today"}
      >
        {activeView === "today" ? (
          <TodayView
            board={board}
            at={at}
            onSelectCourse={onSelectCourse}
            onSelectTask={onSelectTask}
            showTasks={() => changeView("tasks")}
          />
        ) : null}
      </div>
      <div
        id="fb-week-panel"
        role="tabpanel"
        aria-labelledby="fb-week-tab"
        hidden={activeView !== "week"}
      >
        {activeView === "week" ? <WeekView board={board} at={at} onSelectCourse={onSelectCourse} /> : null}
      </div>
      <div
        id="fb-tasks-panel"
        role="tabpanel"
        aria-labelledby="fb-tasks-tab"
        hidden={activeView !== "tasks"}
      >
        {activeView === "tasks" ? <TasksView board={board} onSelectTask={onSelectTask} /> : null}
      </div>
    </section>
  );
}

export default BoardWorkspace;
