import path from "node:path";
import process from "node:process";
import { validateBoard } from "../server/board-schema.mjs";
import {
  REPO_ROOT,
  verifyViewerDirectory,
} from "./viewer-integrity.mjs";

try {
  const summary = await verifyViewerDirectory({
    docsDir: path.join(REPO_ROOT, "docs"),
    validateBoard,
  });
  console.log(
    `PASS: viewer integrity verified (${summary.files} files, ` +
      `${summary.assets} HTML assets, ${summary.media} media files; ` +
      `${summary.board.schedule} schedule entries, ${summary.board.tasks} tasks, ` +
      `${summary.board.photos} photos).`,
  );
} catch (error) {
  console.error(`FAIL: viewer integrity check failed: ${error.message}`);
  process.exitCode = 1;
}
