import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateBoard } from "../server/board-schema.mjs";
import {
  assertSafeMediaReference,
  collectMediaReferences,
  scanForbiddenViewerText,
  validateBoardOrThrow,
  verifyViewerDirectory,
} from "../scripts/viewer-integrity.mjs";

const WEBP_1X1 = Buffer.from(
  "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
  "base64",
);

const validBoard = {
  schemaVersion: 1,
  meta: {
    title: "家庭日程板",
    timezone: "Asia/Shanghai",
    lastUpdated: "2026-08-30T21:18:54+08:00",
  },
  children: [
    { id: "xiaoyue", name: "黄小越" },
    { id: "xiaoyi", name: "黄小翊" },
  ],
  schedule: [
    {
      id: "course-1",
      childId: "xiaoyue",
      weekday: 1,
      title: "示例课",
      startTime: "09:00",
      endTime: "10:00",
      location: "",
      note: "",
      photos: [
        {
          id: "photo-1",
          src: "media/full/photo-1.webp",
          thumbnail: "media/thumb/photo-1.webp",
          caption: "",
          width: 1,
          height: 1,
          mimeType: "image/webp",
        },
      ],
    },
  ],
  tasks: [],
};

test("photo references are strict, field-specific project paths", () => {
  assert.equal(
    assertSafeMediaReference("media/full/a-1.webp", "src"),
    "media/full/a-1.webp",
  );
  assert.equal(
    assertSafeMediaReference("media/thumb/a-1.webp", "thumbnail"),
    "media/thumb/a-1.webp",
  );
  for (const [reference, field] of [
    ["../secret.jpg", "src"],
    ["media/full/../secret.jpg", "src"],
    ["media\\full\\a.jpg", "src"],
    ["media/thumb/a.jpg", "src"],
    ["media/full/a.jpg", "thumbnail"],
    ["media/full/space name.jpg", "src"],
  ]) {
    assert.throws(() => assertSafeMediaReference(reference, field));
  }
});

test("media collection uses only src and thumbnail and deduplicates paths", () => {
  const board = structuredClone(validBoard);
  board.tasks.push({
    id: "task-1",
    photos: [
      {
        src: "media/full/photo-1.webp",
        thumbnail: "media/thumb/photo-1.webp",
        ignoredPath: "media/full/not-copied.webp",
      },
    ],
  });
  assert.deepEqual(collectMediaReferences(board), [
    "media/full/photo-1.webp",
    "media/thumb/photo-1.webp",
  ]);
});

test("shared schema reports completedAt and photo path validation", () => {
  const board = structuredClone(validBoard);
  board.tasks.push({
    id: "task-completed",
    title: "已完成事项",
    relatedTo: "family",
    dueDate: "2026-08-30",
    status: "completed",
    completedAt: null,
    note: "",
    photos: [
      {
        id: "photo-2",
        src: "media/full/photo-2.webp",
        thumbnail: "media/full/not-a-thumbnail.webp",
        caption: "",
        width: 1200,
        height: 800,
        mimeType: "image/webp",
      },
    ],
  });

  const result = validateBoard(board);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path.includes("completedAt")));
  assert.ok(result.errors.some((error) => error.path.includes("thumbnail")));
  assert.throws(
    () => validateBoardOrThrow(board, validateBoard),
    /completedAt[\s\S]*thumbnail|thumbnail[\s\S]*completedAt/,
  );
});

test("forbidden viewer scan detects editor and write capabilities", () => {
  assert.deepEqual(scanForbiddenViewerText("safe.js", "fetch('./data/board.json')"), []);
  const violations = scanForbiddenViewerText(
    "unsafe.js",
    "fetch('/api/board',{method:'POST'}); const props={contentEditable:true,type:'file',onPaste:event=>event}; import('/src/editor/main.tsx')",
  );
  assert.ok(violations.some((item) => item.includes("local/write API")));
  assert.ok(violations.some((item) => item.includes("write HTTP method")));
  assert.ok(violations.some((item) => item.includes("contenteditable")));
  assert.ok(violations.some((item) => item.includes("file upload")));
  assert.ok(violations.some((item) => item.includes("clipboard/drop upload")));
  assert.ok(violations.some((item) => item.includes("editor entry")));
});

test("viewer integrity verifies relative assets and exactly referenced media", async (t) => {
  const taskTmpRoot = path.join(process.cwd(), ".tmp");
  await mkdir(taskTmpRoot, { recursive: true });
  const docsDir = await mkdtemp(path.join(taskTmpRoot, "build-viewer-test-"));
  t.after(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  await Promise.all([
    mkdir(path.join(docsDir, "assets"), { recursive: true }),
    mkdir(path.join(docsDir, "data"), { recursive: true }),
    mkdir(path.join(docsDir, "media", "full"), { recursive: true }),
    mkdir(path.join(docsDir, "media", "thumb"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(docsDir, ".nojekyll"), ""),
    writeFile(path.join(docsDir, "robots.txt"), "User-agent: *\nDisallow: /\n"),
    writeFile(
      path.join(docsDir, "index.html"),
      '<meta name="robots" content="noindex,nofollow,noarchive"><link rel="stylesheet" href="./assets/main.css"><script type="module" src="./assets/main.js"></script>',
    ),
    writeFile(path.join(docsDir, "assets", "main.css"), "body{}"),
    writeFile(
      path.join(docsDir, "assets", "main.js"),
      "fetch(`./data/board.json?t=${Date.now()}`,{cache:'no-store'})",
    ),
    writeFile(path.join(docsDir, "data", "board.json"), JSON.stringify(validBoard)),
    writeFile(path.join(docsDir, "media", "full", "photo-1.webp"), WEBP_1X1),
    writeFile(path.join(docsDir, "media", "thumb", "photo-1.webp"), WEBP_1X1),
  ]);

  const validateBoard = () => ({ ok: true, errors: [] });
  const summary = await verifyViewerDirectory({ docsDir, validateBoard });
  assert.equal(summary.media, 2);
  assert.equal(summary.assets, 2);

  await writeFile(path.join(docsDir, "media", "full", "photo-1.webp"), "not-an-image");
  await assert.rejects(
    verifyViewerDirectory({ docsDir, validateBoard }),
    /not a safe structural image/,
  );
  await writeFile(path.join(docsDir, "media", "full", "photo-1.webp"), WEBP_1X1);

  await writeFile(
    path.join(docsDir, "index.html"),
    '<meta name="robots" content="noindex"><link rel="stylesheet" href="./assets/main.css"><script type="module" src="./assets/main.js"></script>',
  );
  await assert.rejects(
    verifyViewerDirectory({ docsDir, validateBoard }),
    /missing nofollow/,
  );
  await writeFile(
    path.join(docsDir, "index.html"),
    '<meta name="robots" content="noindex,nofollow,noarchive"><link rel="stylesheet" href="./assets/main.css"><script type="module" src="./assets/main.js"></script>',
  );

  await writeFile(path.join(docsDir, "media", "full", "stale.webp"), "stale");
  await assert.rejects(
    verifyViewerDirectory({ docsDir, validateBoard }),
    /unreferenced media/,
  );
});
