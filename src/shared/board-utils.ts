import type {
  Board,
  BoardTask,
  ChildId,
  Course,
  RelatedTo,
  TaskStatus,
  Weekday,
} from "./types";

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  1: "星期一",
  2: "星期二",
  3: "星期三",
  4: "星期四",
  5: "星期五",
  6: "星期六",
  7: "星期日",
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  completed: "已完成",
};

export const RELATED_FALLBACKS: Record<RelatedTo, string> = {
  xiaoyue: "黄小越",
  xiaoyi: "黄小翊",
  family: "全家",
};

export interface ZonedNow {
  dateKey: string;
  year: number;
  month: number;
  day: number;
  weekday: Weekday;
  minutes: number;
}

export interface TodayCourseState {
  courses: Course[];
  current: Course | null;
  next: Course | null;
}

export interface TaskBuckets {
  overdue: BoardTask[];
  dueToday: BoardTask[];
  upcoming: BoardTask[];
}

export function safeTimeZone(value: string | undefined): string {
  const candidate = value?.trim() || "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "Asia/Shanghai";
  }
}

export function getZonedNow(timeZone: string, at = new Date()): ZonedNow {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dateKey = `${values.year}-${values.month}-${values.day}`;
  const weekday = (new Date(`${dateKey}T00:00:00Z`).getUTCDay() || 7) as Weekday;

  return {
    dateKey,
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    weekday,
    minutes: (Number(values.hour) % 24) * 60 + Number(values.minute),
  };
}

export function timeToMinutes(value: string | undefined): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value ?? "");
  if (!match) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function courseHasExactTime(course: Course): boolean {
  return Number.isFinite(timeToMinutes(course.startTime))
    && Number.isFinite(timeToMinutes(course.endTime));
}

export function formatCourseSchedule(course: Course): string {
  const periodLabel = course.periodLabel?.trim();
  if (periodLabel) return periodLabel;
  if (courseHasExactTime(course)) return `${course.startTime}–${course.endTime}`;
  return "节次未注明";
}

export function compareCourses(left: Course, right: Course): number {
  const leftPeriodOrder = Number.isInteger(left.periodOrder)
    ? Number(left.periodOrder)
    : Number.POSITIVE_INFINITY;
  const rightPeriodOrder = Number.isInteger(right.periodOrder)
    ? Number(right.periodOrder)
    : Number.POSITIVE_INFINITY;
  return (
    leftPeriodOrder - rightPeriodOrder ||
    timeToMinutes(left.startTime) - timeToMinutes(right.startTime) ||
    timeToMinutes(left.endTime) - timeToMinutes(right.endTime) ||
    left.title.localeCompare(right.title, "zh-CN")
  );
}

export function courseIsActiveOn(course: Course, dateKey: string): boolean {
  return !course.startDate || course.startDate <= dateKey;
}

export function coursesForDay(
  board: Board,
  weekday: Weekday,
  childId?: ChildId,
  dateKey?: string,
): Course[] {
  return board.schedule
    .filter(
      (course) =>
        course.weekday === weekday
        && (childId === undefined || course.childId === childId)
        && (dateKey === undefined || courseIsActiveOn(course, dateKey)),
    )
    .slice()
    .sort(compareCourses);
}

export function getTodayCourseState(
  board: Board,
  childId: ChildId,
  at = new Date(),
): TodayCourseState {
  const now = getZonedNow(board.meta.timezone, at);
  const courses = coursesForDay(board, now.weekday, childId, now.dateKey);
  const current =
    courses.find(
      (course) =>
        courseHasExactTime(course) &&
        timeToMinutes(course.startTime) <= now.minutes &&
        now.minutes < timeToMinutes(course.endTime),
    ) ?? null;
  const next = courses.find(
    (course) => courseHasExactTime(course) && timeToMinutes(course.startTime) > now.minutes,
  ) ?? null;
  return { courses, current, next };
}

export function compareOpenTasks(left: BoardTask, right: BoardTask): number {
  return (
    left.dueDate.localeCompare(right.dueDate, "en") ||
    left.title.localeCompare(right.title, "zh-CN")
  );
}

export function compareCompletedTasks(left: BoardTask, right: BoardTask): number {
  return (
    String(right.completedAt ?? right.dueDate).localeCompare(
      String(left.completedAt ?? left.dueDate),
      "en",
    ) || left.title.localeCompare(right.title, "zh-CN")
  );
}

export function sortedTasks(board: Board): BoardTask[] {
  const open = board.tasks
    .filter((task) => task.status !== "completed")
    .slice()
    .sort(compareOpenTasks);
  const completed = board.tasks
    .filter((task) => task.status === "completed")
    .slice()
    .sort(compareCompletedTasks);
  return [...open, ...completed];
}

export function getTaskBuckets(board: Board, at = new Date()): TaskBuckets {
  const dateKey = getZonedNow(board.meta.timezone, at).dateKey;
  const open = board.tasks
    .filter((task) => task.status !== "completed")
    .slice()
    .sort(compareOpenTasks);

  return {
    overdue: open.filter((task) => task.dueDate < dateKey),
    dueToday: open.filter((task) => task.dueDate === dateKey),
    upcoming: open.filter((task) => task.dueDate > dateKey),
  };
}

export function isTaskOverdue(
  task: BoardTask,
  timeZone: string,
  at = new Date(),
): boolean {
  return (
    task.status !== "completed" && task.dueDate < getZonedNow(timeZone, at).dateKey
  );
}

export function childName(board: Board, childId: ChildId): string {
  return board.children.find((child) => child.id === childId)?.name || RELATED_FALLBACKS[childId];
}

export function relatedName(board: Board, relatedTo: RelatedTo): string {
  return relatedTo === "family" ? RELATED_FALLBACKS.family : childName(board, relatedTo);
}

export function formatDateKey(value: string, options: { weekday?: boolean } = {}): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value || "未注明";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    ...(options.weekday ? { weekday: "short" as const } : {}),
  }).format(date);
}

export function formatTimestamp(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未注明";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: safeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function shiftDateKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function currentWeekDateKeys(timeZone: string, at = new Date()): string[] {
  const now = getZonedNow(timeZone, at);
  const monday = shiftDateKey(now.dateKey, 1 - now.weekday);
  return Array.from({ length: 7 }, (_, index) => shiftDateKey(monday, index));
}
