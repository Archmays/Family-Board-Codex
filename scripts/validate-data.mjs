import path from "node:path";
import process from "node:process";
import { validateBoard } from "../server/board-schema.mjs";
import {
  boardSummary,
  readAndValidateBoard,
} from "./viewer-integrity.mjs";

const filePath = path.resolve(process.cwd(), process.argv[2] || "data/board.json");

try {
  const board = await readAndValidateBoard(filePath, validateBoard);
  const summary = boardSummary(board);
  console.log(
    `PASS: ${path.relative(process.cwd(), filePath) || filePath} is valid ` +
      `(${summary.children} children, ${summary.schedule} schedule entries, ` +
      `${summary.tasks} tasks, ${summary.completedAt} completedAt values, ` +
      `${summary.photos} photos).`,
  );
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
