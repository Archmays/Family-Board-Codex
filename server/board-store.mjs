import { createHash, randomUUID } from 'node:crypto';
import {
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

import { validateBoard } from './board-schema.mjs';
import {
  AppError,
  BoardValidationError,
  RevisionConflictError,
} from './errors.mjs';

const REVISION_PATTERN = /^[a-f0-9]{64}$/;

function serializeBoard(board) {
  return `${JSON.stringify(board, null, 2)}\n`;
}

function serializePublishState(publishedRevision, publishedBoard) {
  // Version-1 names are retained for compatibility. This is the pushed snapshot
  // (or legacy local docs baseline), never evidence that Pages serves it.
  return `${JSON.stringify({
    schemaVersion: 1,
    publishedRevision,
    publishedBoard,
  }, null, 2)}\n`;
}

function shanghaiTimestamp(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().replace('Z', '+08:00');
}

/**
 * Compute the optimistic-concurrency revision. Buffers and strings are hashed
 * byte-for-byte; objects use the same stable formatting used for board.json.
 */
export function computeRevision(value) {
  let bytes;

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    bytes = value;
  } else if (typeof value === 'string') {
    bytes = Buffer.from(value, 'utf8');
  } else {
    bytes = Buffer.from(serializeBoard(value), 'utf8');
  }

  return createHash('sha256').update(bytes).digest('hex');
}

async function writeDurableFile(filePath, bytes) {
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Directory fsync is not supported consistently on Windows. The file
    // itself has already been synced, so this remains a best-effort hardening.
    if (!['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseBoardBytes(bytes, filePath) {
  let board;
  try {
    board = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new AppError(`Could not parse ${filePath}.`, {
      status: 500,
      code: 'board_file_invalid_json',
      cause: error,
      expose: true,
    });
  }

  const validation = validateBoard(board);
  if (!validation.ok) {
    throw new AppError(`${filePath} does not satisfy the board schema.`, {
      status: 500,
      code: 'board_file_invalid',
      details: { errors: validation.errors },
      expose: true,
    });
  }

  return board;
}

function parsePublishStateBytes(bytes, filePath) {
  let state;
  try {
    state = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new AppError(`Could not parse ${filePath}.`, {
      status: 500,
      code: 'publish_state_invalid_json',
      cause: error,
      expose: true,
    });
  }

  const validObject = state !== null && typeof state === 'object' && !Array.isArray(state);
  const validRevision = state?.publishedRevision === null
    || (typeof state?.publishedRevision === 'string' && REVISION_PATTERN.test(state.publishedRevision));
  const validNullSnapshot = state?.publishedRevision === null && state?.publishedBoard === null;
  const boardValidation = state?.publishedRevision === null
    ? { ok: validNullSnapshot, errors: [] }
    : validateBoard(state?.publishedBoard);
  const validBoardSnapshot = state?.publishedRevision !== null
    && boardValidation.ok
    && computeRevision(state.publishedBoard) === state.publishedRevision;
  if (!validObject
      || state.schemaVersion !== 1
      || !validRevision
      || (!validNullSnapshot && !validBoardSnapshot)) {
    throw new AppError(`${filePath} does not satisfy the publish-state schema.`, {
      status: 500,
      code: 'publish_state_invalid',
      details: { errors: boardValidation.errors },
      expose: true,
    });
  }

  return state;
}

export class BoardStore {
  constructor({ projectRoot, testHooks = {} }) {
    this.projectRoot = path.resolve(projectRoot);
    this.boardPath = path.join(this.projectRoot, 'data', 'board.json');
    this.backupPath = path.join(this.projectRoot, 'data', 'board.json.bak');
    this.publishStatePath = path.join(this.projectRoot, 'data', 'publish-state.json');
    this.publishedBoardPath = path.join(this.projectRoot, 'docs', 'data', 'board.json');
    this.mutationTail = Promise.resolve();
    this.testHooks = testHooks;
  }

  async withExclusive(operation) {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.catch(() => {});
    return result;
  }

  async readBoardFile(filePath = this.boardPath) {
    let bytes;
    try {
      bytes = await readFile(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new AppError(`Required board file is missing: ${filePath}`, {
          status: 500,
          code: 'board_file_missing',
          expose: true,
        });
      }
      throw error;
    }

    return {
      board: parseBoardBytes(bytes, filePath),
      bytes,
      revision: computeRevision(bytes),
    };
  }

  async readPublishState() {
    try {
      const bytes = await readFile(this.publishStatePath);
      const state = parsePublishStateBytes(bytes, this.publishStatePath);
      return {
        exists: true,
        publishedRevision: state.publishedRevision,
        publishedBoard: state.publishedBoard,
      };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { exists: false, publishedRevision: null, publishedBoard: null };
      }
      throw error;
    }
  }

  async getLegacyPublishedRevision() {
    try {
      const bytes = await readFile(this.publishedBoardPath);
      return computeRevision(bytes);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async getPublishedSnapshot() {
    const state = await this.readPublishState();
    if (state.exists) {
      return {
        revision: state.publishedRevision,
        board: state.publishedBoard,
      };
    }

    try {
      const published = await this.readBoardFile(this.publishedBoardPath);
      return { revision: published.revision, board: published.board };
    } catch (error) {
      if (error?.code === 'board_file_missing') {
        return { revision: null, board: null };
      }
      throw error;
    }
  }

  async getPublishedRevision() {
    return (await this.getPublishedSnapshot()).revision;
  }

  async writePublishState(publishedRevision, publishedBoard) {
    if (publishedRevision !== null
        && (typeof publishedRevision !== 'string' || !REVISION_PATTERN.test(publishedRevision))) {
      throw new AppError('Published revision must be null or a SHA-256 revision string.', {
        status: 500,
        code: 'invalid_published_revision',
        expose: true,
      });
    }

    const dataDirectory = path.dirname(this.publishStatePath);
    const transactionId = `${process.pid}-${randomUUID()}`;
    const tempPath = path.join(dataDirectory, `.publish-state.${transactionId}.tmp`);
    try {
      const stateBytes = Buffer.from(serializePublishState(publishedRevision, publishedBoard), 'utf8');
      parsePublishStateBytes(stateBytes, this.publishStatePath);
      await writeDurableFile(tempPath, stateBytes);
      await rename(tempPath, this.publishStatePath);
      await syncDirectory(dataDirectory);
    } finally {
      await rm(tempPath, { force: true });
    }
    return publishedRevision;
  }

  async ensurePublishState({ revision, board }) {
    const current = await this.readPublishState();
    if (current.exists) {
      if (current.publishedRevision !== revision) {
        throw new AppError('Published state changed after preflight.', {
          status: 409,
          code: 'publish_state_changed',
          details: { publishedRevision: current.publishedRevision },
        });
      }
      return current.publishedRevision;
    }
    return this.writePublishState(revision, board);
  }

  async markPublishedRevision(publishedRevision, publishedBoard) {
    return this.writePublishState(publishedRevision, publishedBoard);
  }

  async getSnapshotUnlocked() {
    const current = await this.readBoardFile();
    const publishedRevision = await this.getPublishedRevision();
    return {
      board: current.board,
      revision: current.revision,
      publishedRevision,
    };
  }

  async getSnapshot() {
    return this.withExclusive(() => this.getSnapshotUnlocked());
  }

  async save(board, baseRevision) {
    return this.withExclusive(async () => {
      let boardToSave;
      try {
        boardToSave = JSON.parse(JSON.stringify(board));
      } catch {
        throw new BoardValidationError([{ path: 'root', message: 'must be JSON-serializable', code: 'type' }]);
      }

      if (boardToSave?.meta && typeof boardToSave.meta === 'object' && !Array.isArray(boardToSave.meta)) {
        boardToSave.meta.lastUpdated = shanghaiTimestamp();
      }

      const validation = validateBoard(boardToSave);
      if (!validation.ok) {
        throw new BoardValidationError(validation.errors);
      }

      const current = await this.readBoardFile();
      const publishedRevision = await this.getPublishedRevision();
      if (baseRevision !== current.revision) {
        throw new RevisionConflictError(current.revision, publishedRevision);
      }

      const dataDirectory = path.dirname(this.boardPath);
      const transactionId = `${process.pid}-${randomUUID()}`;
      const nextTempPath = path.join(dataDirectory, `.board.json.${transactionId}.tmp`);
      const backupTempPath = path.join(dataDirectory, `.board.json.bak.${transactionId}.tmp`);
      const nextBytes = Buffer.from(serializeBoard(boardToSave), 'utf8');

      try {
        await writeDurableFile(nextTempPath, nextBytes);
        const latestBytes = await readFile(this.boardPath).catch((error) => {
          if (error?.code === 'ENOENT') {
            throw new RevisionConflictError(null, publishedRevision);
          }
          throw error;
        });
        const latestRevision = computeRevision(latestBytes);
        if (latestRevision !== current.revision) {
          throw new RevisionConflictError(latestRevision, publishedRevision);
        }

        await writeDurableFile(backupTempPath, latestBytes);
        await rename(backupTempPath, this.backupPath);

        // This is the final best-effort compare immediately before the atomic
        // same-volume replacement. It preserves atomic reader visibility while
        // narrowing the unavoidable cross-process CAS window to one rename.
        await this.testHooks.beforeFinalRevisionCheck?.({ boardPath: this.boardPath });
        const finalBytes = await readFile(this.boardPath).catch((error) => {
          if (error?.code === 'ENOENT') {
            throw new RevisionConflictError(null, publishedRevision);
          }
          throw error;
        });
        const finalRevision = computeRevision(finalBytes);
        if (finalRevision !== current.revision) {
          throw new RevisionConflictError(finalRevision, publishedRevision);
        }
        await rename(nextTempPath, this.boardPath);
        await syncDirectory(dataDirectory);
        const installedRevision = computeRevision(await readFile(this.boardPath));
        if (installedRevision !== computeRevision(nextBytes)) {
          throw new RevisionConflictError(installedRevision, publishedRevision);
        }
      } finally {
        await Promise.allSettled([
          rm(nextTempPath, { force: true }),
          rm(backupTempPath, { force: true }),
        ]);
      }

      const saved = await this.readBoardFile();
      return {
        board: saved.board,
        revision: saved.revision,
        publishedRevision: await this.getPublishedRevision(),
      };
    });
  }

  async exists() {
    try {
      return (await stat(this.boardPath)).isFile();
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }
}

export { serializeBoard };
