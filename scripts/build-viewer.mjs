import path from "node:path";
import process from "node:process";
import { validateBoard } from "../server/board-schema.mjs";
import {
  REPO_ROOT,
  assertReferencedMediaSources,
  collectMediaReferences,
  copyReferencedMedia,
  readAndValidateBoard,
  restorePagesControlFiles,
  verifyViewerDirectory,
  verifyViewerSourceEntry,
  writePublishedBoard,
} from "./viewer-integrity.mjs";

const boardPath = path.join(REPO_ROOT, "data", "board.json");
const docsDir = path.join(REPO_ROOT, "docs");
const viteConfigPath = path.join(REPO_ROOT, "vite.viewer.config.ts");

try {
  const board = await readAndValidateBoard(boardPath, validateBoard);
  const mediaReferences = collectMediaReferences(board);

  await Promise.all([
    assertReferencedMediaSources(REPO_ROOT, mediaReferences, board),
    verifyViewerSourceEntry(REPO_ROOT),
  ]);

  const { build } = await import("vite");
  await build({
    root: REPO_ROOT,
    configFile: viteConfigPath,
  });

  await restorePagesControlFiles(docsDir);
  await writePublishedBoard(docsDir, board);
  await copyReferencedMedia(REPO_ROOT, docsDir, mediaReferences);

  const summary = await verifyViewerDirectory({ docsDir, validateBoard });
  console.log(
    `PASS: built read-only viewer (${summary.files} files, ` +
      `${summary.assets} HTML assets, ${summary.media} media files).`,
  );
} catch (error) {
  console.error(`FAIL: viewer build failed: ${error.message}`);
  process.exitCode = 1;
}
