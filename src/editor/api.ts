import type { Board, PhotoAttachment } from "../shared/types";

export interface BoardResponse {
  board: Board;
  revision: string;
  publishedRevision: string | null;
}

export interface RevisionResponse {
  revision: string;
  publishedRevision: string | null;
}

export interface ChangeCounts {
  added: number;
  modified: number;
  deleted: number;
}

export interface PublishSummary {
  courses: ChangeCounts;
  tasks: ChangeCounts;
  photos: {
    added: number;
    removed: number;
  };
}

export interface PublishPreflight {
  revision: string;
  publishedRevision: string | null;
  preflightToken: string;
  summary: PublishSummary;
  needsPublish: boolean;
  git?: {
    blocked?: boolean;
    branch?: string;
    head?: string;
    unrelatedPaths?: string[];
  };
}

export interface PublishResponse {
  board: Board;
  revision: string;
  publishedRevision: string | null;
  summary: PublishSummary;
  needsPublish: boolean;
  published: boolean;
  pushed: boolean;
  deploymentStatus: "unverified";
  committed: boolean;
  commitSha: string;
  pagesUrl: string;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : { error: await response.text() };

  if (!response.ok) {
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    throw new ApiError(
      typeof record.error === "string" ? record.error : `请求失败（HTTP ${response.status}）`,
      response.status,
      typeof record.code === "string" ? record.code : undefined,
      Object.hasOwn(record, "details") ? record.details : payload,
    );
  }

  return payload as T;
}

async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/json");

  const response = await fetch(path, {
    ...init,
    headers,
    cache: "no-store",
  });
  return parseResponse<T>(response);
}

export function getBoard(): Promise<BoardResponse> {
  return jsonRequest<BoardResponse>(`/api/board?t=${Date.now()}`);
}

export function getRevision(): Promise<RevisionResponse> {
  return jsonRequest<RevisionResponse>(`/api/revision?t=${Date.now()}`);
}

export function saveBoard(board: Board, baseRevision: string): Promise<BoardResponse> {
  return jsonRequest<BoardResponse>("/api/save", {
    method: "POST",
    body: JSON.stringify({ board, baseRevision }),
  });
}

export async function uploadPhoto(
  full: Blob,
  thumbnail: Blob,
  metadata: { width: number; height: number; mimeType: string; caption?: string },
): Promise<PhotoAttachment> {
  const form = new FormData();
  const extension = metadata.mimeType === "image/jpeg" ? "jpg" : "webp";
  form.append("full", full, `photo.${extension}`);
  form.append("thumbnail", thumbnail, `photo-thumb.${extension}`);
  form.append("width", String(metadata.width));
  form.append("height", String(metadata.height));
  form.append("mimeType", metadata.mimeType);
  form.append("caption", metadata.caption ?? "");

  const response = await fetch("/api/media", {
    method: "POST",
    body: form,
    headers: { Accept: "application/json" },
  });
  const payload = await parseResponse<{ photo: PhotoAttachment }>(response);
  return payload.photo;
}

export function discardPhotoUpload(photo: PhotoAttachment): Promise<{ discarded: true }> {
  return jsonRequest<{ discarded: true }>("/api/media/discard", {
    method: "POST",
    body: JSON.stringify({ photo }),
  });
}

export function getPublishPreflight(baseRevision: string): Promise<PublishPreflight> {
  return jsonRequest<PublishPreflight>("/api/publish/preflight", {
    method: "POST",
    body: JSON.stringify({ baseRevision }),
  });
}

export function publishBoard(baseRevision: string, preflightToken: string): Promise<PublishResponse> {
  return jsonRequest<PublishResponse>("/api/publish", {
    method: "POST",
    body: JSON.stringify({ baseRevision, preflightToken }),
  });
}
