export const CHILD_IDS = ["xiaoyue", "xiaoyi"] as const;
export const TASK_STATUSES = ["not_started", "in_progress", "completed"] as const;
export const BOARD_VIEWS = ["today", "week", "tasks"] as const;

export type ChildId = (typeof CHILD_IDS)[number];
export type RelatedTo = ChildId | "family";
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type BoardView = (typeof BOARD_VIEWS)[number];
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface PhotoAttachment {
  id: string;
  src: string;
  thumbnail: string;
  caption: string;
  width: number;
  height: number;
  mimeType: string;
}

export interface BoardMeta {
  title: string;
  timezone: string;
  lastUpdated: string;
}

export interface BoardChild {
  id: ChildId;
  name: string;
}

export interface Course {
  id: string;
  childId: ChildId;
  weekday: Weekday;
  title: string;
  startTime: string;
  endTime: string;
  location: string;
  note: string;
  photos: PhotoAttachment[];
}

export interface BoardTask {
  id: string;
  title: string;
  relatedTo: RelatedTo;
  dueDate: string;
  status: TaskStatus;
  completedAt: string | null;
  note: string;
  photos: PhotoAttachment[];
}

export interface Board {
  schemaVersion: number;
  meta: BoardMeta;
  children: BoardChild[];
  schedule: Course[];
  tasks: BoardTask[];
}

export type BoardSelection =
  | { kind: "course"; item: Course }
  | { kind: "task"; item: BoardTask };

export type BoardMode = "viewer" | "editor";
