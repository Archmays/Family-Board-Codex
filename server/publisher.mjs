import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';

import { validateBoard } from './board-schema.mjs';
import { AppError, RevisionConflictError } from './errors.mjs';

const MAX_COMMAND_OUTPUT = 5 * 1024 * 1024;
const PREFLIGHT_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function normalizeGitPath(filePath) {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isPublishOwnedPath(filePath) {
  const normalized = normalizeGitPath(filePath);
  return normalized === 'data/board.json'
    || normalized === 'data/board.json.bak'
    || normalized.startsWith('data/.board.json.')
    || normalized === 'data/publish-state.json'
    || normalized.startsWith('data/.publish-state.')
    || normalized.startsWith('docs/')
    || normalized.startsWith('media/');
}

function isCommitOwnedPath(filePath) {
  const normalized = normalizeGitPath(filePath);
  return normalized === 'data/board.json' || normalized.startsWith('docs/');
}

function commandDisplay(command, args) {
  return [command, ...args].join(' ');
}

export function runCommand(command, args, {
  cwd,
  allowedExitCodes = [0],
  env = process.env,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;

    const collect = (chunks, chunk, currentBytes) => {
      if (currentBytes + chunk.length > MAX_COMMAND_OUTPUT) {
        outputExceeded = true;
        child.kill();
        return currentBytes;
      }
      chunks.push(chunk);
      return currentBytes + chunk.length;
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes = collect(stderr, chunk, stderrBytes);
    });
    child.once('error', (error) => {
      reject(new AppError(`Could not start ${commandDisplay(command, args)}.`, {
        status: 500,
        code: 'command_start_failed',
        cause: error,
        expose: true,
      }));
    });
    child.once('close', (exitCode, signal) => {
      const result = {
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };

      if (outputExceeded) {
        reject(new AppError(`${commandDisplay(command, args)} produced too much output.`, {
          status: 500,
          code: 'command_output_limit',
          expose: true,
        }));
      } else if (!allowedExitCodes.includes(exitCode)) {
        reject(new AppError(`${commandDisplay(command, args)} failed with exit code ${exitCode}.`, {
          status: 500,
          code: 'command_failed',
          details: {
            exitCode,
            stdout: result.stdout.toString('utf8').slice(-8_000),
            stderr: result.stderr.toString('utf8').slice(-8_000),
          },
          expose: true,
        }));
      } else {
        resolve(result);
      }
    });
  });
}

async function git(projectRoot, args, options = {}) {
  return runCommand('git', args, { cwd: projectRoot, ...options });
}

function nulPaths(buffer) {
  return buffer
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(normalizeGitPath);
}

export async function inspectGit(projectRoot) {
  const [rootResult, branchResult, headResult, worktreeResult, stagedResult, untrackedResult] = await Promise.all([
    git(projectRoot, ['rev-parse', '--show-toplevel']),
    git(projectRoot, ['branch', '--show-current']),
    git(projectRoot, ['rev-parse', 'HEAD']),
    git(projectRoot, ['diff', '--no-renames', '--name-only', '-z']),
    git(projectRoot, ['diff', '--cached', '--no-renames', '--name-only', '-z']),
    git(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);

  const gitRoot = path.resolve(rootResult.stdout.toString('utf8').trim());
  if (gitRoot.toLowerCase() !== path.resolve(projectRoot).toLowerCase()) {
    throw new AppError('The editor project root is not the Git repository root.', {
      status: 409,
      code: 'git_root_mismatch',
      details: { gitRoot },
    });
  }

  const branch = branchResult.stdout.toString('utf8').trim();
  const allPaths = new Set([
    ...nulPaths(worktreeResult.stdout),
    ...nulPaths(stagedResult.stdout),
    ...nulPaths(untrackedResult.stdout),
  ]);
  const unrelatedPaths = [...allPaths].filter((filePath) => !isPublishOwnedPath(filePath)).sort();

  return {
    branch,
    head: headResult.stdout.toString('utf8').trim(),
    blocked: branch !== 'main' || unrelatedPaths.length > 0,
    unrelatedPaths,
  };
}

function gitObjectId(bytes, objectFormat) {
  return createHash(objectFormat)
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

async function listSnapshotFiles(projectRoot) {
  const relativePaths = ['data/board.json'];
  async function visit(relativeDirectory) {
    const absoluteDirectory = path.join(projectRoot, ...relativeDirectory.split('/'));
    const directoryEntry = await lstat(absoluteDirectory);
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
      throw new AppError(`Publish path must be a regular directory: ${relativeDirectory}`, {
        status: 409,
        code: 'publish_snapshot_unsafe',
      });
    }
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new AppError(`Publish snapshot contains a symlink: ${relativePath}`, {
          status: 409,
          code: 'publish_snapshot_unsafe',
        });
      }
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else if (entry.isFile()) {
        relativePaths.push(relativePath);
      } else {
        throw new AppError(`Publish snapshot contains a non-regular file: ${relativePath}`, {
          status: 409,
          code: 'publish_snapshot_unsafe',
        });
      }
    }
  }
  await visit('docs');
  return relativePaths.sort();
}

async function capturePublishSnapshot(projectRoot, expectedBoardRevision) {
  const formatResult = await git(projectRoot, ['rev-parse', '--show-object-format']);
  const objectFormat = formatResult.stdout.toString('utf8').trim();
  if (!['sha1', 'sha256'].includes(objectFormat)) {
    throw new AppError(`Unsupported Git object format: ${objectFormat}`, {
      status: 500,
      code: 'git_object_format_unsupported',
      expose: true,
    });
  }
  const snapshot = new Map();
  for (const relativePath of await listSnapshotFiles(projectRoot)) {
    const absolutePath = path.join(projectRoot, ...relativePath.split('/'));
    const entry = await lstat(absolutePath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new AppError(`Publish snapshot file is not regular: ${relativePath}`, {
        status: 409,
        code: 'publish_snapshot_unsafe',
      });
    }
    const bytes = await readFile(absolutePath);
    if ((relativePath === 'data/board.json' || relativePath === 'docs/data/board.json')
        && createHash('sha256').update(bytes).digest('hex') !== expectedBoardRevision) {
      throw new AppError(`${relativePath} changed while the publish snapshot was being frozen.`, {
        status: 409,
        code: 'publish_board_changed_during_freeze',
      });
    }
    snapshot.set(relativePath, gitObjectId(bytes, objectFormat));
  }
  return snapshot;
}

function parseIndexEntries(buffer, label) {
  const entries = new Map();
  for (const record of buffer.toString('utf8').split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    const header = separator >= 0 ? record.slice(0, separator) : '';
    const filePath = separator >= 0 ? normalizeGitPath(record.slice(separator + 1)) : '';
    const [mode, second, third] = header.split(' ');
    const isTreeRecord = second === 'blob';
    const objectId = isTreeRecord ? third : second;
    const stage = isTreeRecord ? '0' : third;
    if (!filePath || !/^100(?:644|755)$/.test(mode) || stage !== '0' || !/^[a-f0-9]{40,64}$/.test(objectId)) {
      throw new AppError(`${label} contains an unsupported entry: ${record}`, {
        status: 409,
        code: 'publish_snapshot_mismatch',
      });
    }
    entries.set(filePath, objectId);
  }
  return entries;
}

function assertSnapshotMatches(actual, expected, label) {
  const actualPaths = [...actual.keys()].sort();
  const expectedPaths = [...expected.keys()].sort();
  const mismatches = [];
  if (!isDeepStrictEqual(actualPaths, expectedPaths)) {
    mismatches.push('file set differs');
  }
  for (const [filePath, objectId] of expected) {
    if (actual.get(filePath) !== objectId) {
      mismatches.push(filePath);
    }
  }
  if (mismatches.length > 0) {
    throw new AppError(`${label} no longer matches the verified publish snapshot.`, {
      status: 409,
      code: 'publish_snapshot_mismatch',
      details: { mismatches },
    });
  }
}

async function verifyStagedSnapshot(projectRoot, expected) {
  const [scopedResult, allStagedResult] = await Promise.all([
    git(projectRoot, ['ls-files', '--stage', '-z', '--', 'data/board.json', 'docs']),
    git(projectRoot, ['diff', '--cached', '--name-only', '-z']),
  ]);
  const allStagedPaths = nulPaths(allStagedResult.stdout);
  const unrelated = allStagedPaths.filter((filePath) => !isCommitOwnedPath(filePath));
  if (unrelated.length > 0) {
    throw new AppError('The staged index contains unrelated changes.', {
      status: 409,
      code: 'publish_staged_unrelated_changes',
      details: { unrelatedPaths: unrelated.sort() },
    });
  }
  assertSnapshotMatches(parseIndexEntries(scopedResult.stdout, 'Staged index'), expected, 'Staged index');
}

async function verifyCommitSnapshot(projectRoot, commitRef, expected, { verifyChangedPaths = false } = {}) {
  const treeResult = await git(projectRoot, ['ls-tree', '-r', '-z', commitRef, '--', 'data/board.json', 'docs']);
  assertSnapshotMatches(parseIndexEntries(treeResult.stdout, 'Committed tree'), expected, 'Committed tree');
  if (verifyChangedPaths) {
    const changedResult = await git(projectRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commitRef]);
    const unrelated = nulPaths(changedResult.stdout).filter((filePath) => !isCommitOwnedPath(filePath));
    if (unrelated.length > 0) {
      throw new AppError('The publish commit contains unrelated changes.', {
        status: 409,
        code: 'publish_commit_unrelated_changes',
        details: { unrelatedPaths: unrelated.sort() },
      });
    }
  }
}

function countItemChanges(currentItems = [], publishedItems = []) {
  const currentById = new Map(currentItems.map((item) => [item.id, item]));
  const publishedById = new Map(publishedItems.map((item) => [item.id, item]));
  let added = 0;
  let modified = 0;
  let deleted = 0;

  for (const [id, item] of currentById) {
    if (!publishedById.has(id)) {
      added += 1;
    } else if (!isDeepStrictEqual(item, publishedById.get(id))) {
      modified += 1;
    }
  }
  for (const id of publishedById.keys()) {
    if (!currentById.has(id)) {
      deleted += 1;
    }
  }

  return { added, modified, deleted };
}

function collectPhotos(board) {
  const photos = new Map();
  for (const item of [...(board?.schedule ?? []), ...(board?.tasks ?? [])]) {
    for (const photo of item.photos ?? []) {
      photos.set(photo.id, photo);
    }
  }
  return photos;
}

export function summarizeBoardChanges(currentBoard, publishedBoard) {
  const currentPhotos = collectPhotos(currentBoard);
  const publishedPhotos = collectPhotos(publishedBoard);
  let addedPhotos = 0;
  let removedPhotos = 0;

  for (const id of currentPhotos.keys()) {
    if (!publishedPhotos.has(id)) {
      addedPhotos += 1;
    }
  }
  for (const id of publishedPhotos.keys()) {
    if (!currentPhotos.has(id)) {
      removedPhotos += 1;
    }
  }

  return {
    courses: countItemChanges(currentBoard?.schedule, publishedBoard?.schedule),
    tasks: countItemChanges(currentBoard?.tasks, publishedBoard?.tasks),
    photos: { added: addedPhotos, removed: removedPhotos },
  };
}

export function createPreflightToken({ revision, publishedRevision, summary, git: gitState }) {
  return createHash('sha256').update(JSON.stringify({
    revision,
    publishedRevision,
    summary,
    git: {
      branch: gitState.branch,
      head: gitState.head,
      blocked: gitState.blocked,
      unrelatedPaths: gitState.unrelatedPaths,
    },
  })).digest('hex');
}

function commitTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

export class Publisher {
  constructor({
    projectRoot,
    boardStore,
    commandRunner = runCommand,
    pagesUrl = 'https://archmays.github.io/Family-Board-Codex/',
    testHooks = {},
  }) {
    this.projectRoot = path.resolve(projectRoot);
    this.boardStore = boardStore;
    this.commandRunner = commandRunner;
    this.pagesUrl = pagesUrl;
    this.testHooks = testHooks;
  }

  async #preflightUnlocked(baseRevision) {
    const snapshot = await this.boardStore.getSnapshotUnlocked();
    if (baseRevision !== snapshot.revision) {
      throw new RevisionConflictError(snapshot.revision, snapshot.publishedRevision);
    }

    const [publishedSnapshot, gitState] = await Promise.all([
      this.boardStore.getPublishedSnapshot(),
      inspectGit(this.projectRoot),
    ]);

    const plan = {
      revision: snapshot.revision,
      publishedRevision: publishedSnapshot.revision,
      needsPublish: publishedSnapshot.revision !== snapshot.revision,
      summary: summarizeBoardChanges(snapshot.board, publishedSnapshot.board),
      git: {
        branch: gitState.branch,
        head: gitState.head,
        blocked: gitState.blocked,
        unrelatedPaths: gitState.unrelatedPaths,
      },
    };
    plan.preflightToken = createPreflightToken(plan);
    return { plan, publishedSnapshot };
  }

  async preflight(baseRevision) {
    return this.boardStore.withExclusive(async () => (await this.#preflightUnlocked(baseRevision)).plan);
  }

  async publish(baseRevision, preflightToken) {
    return this.boardStore.withExclusive(async () => {
      const { plan: preflight, publishedSnapshot } = await this.#preflightUnlocked(baseRevision);
      if (typeof preflightToken !== 'string'
          || !PREFLIGHT_TOKEN_PATTERN.test(preflightToken)
          || preflightToken !== preflight.preflightToken) {
        throw new AppError('The publish preflight changed. Review the latest summary and confirm again.', {
          status: 409,
          code: 'publish_preflight_changed',
          details: { preflight },
        });
      }
      const gitState = await inspectGit(this.projectRoot);
      const refreshedGitPlan = {
        ...preflight,
        git: {
          branch: gitState.branch,
          head: gitState.head,
          blocked: gitState.blocked,
          unrelatedPaths: gitState.unrelatedPaths,
        },
      };
      refreshedGitPlan.preflightToken = createPreflightToken(refreshedGitPlan);
      if (refreshedGitPlan.preflightToken !== preflightToken) {
        throw new AppError('Git state changed after publish preflight. Review and confirm again.', {
          status: 409,
          code: 'publish_preflight_changed',
          details: { preflight: refreshedGitPlan },
        });
      }
      if (gitState.branch !== 'main') {
        throw new AppError('Publishing is allowed only from the main branch.', {
          status: 409,
          code: 'publish_wrong_branch',
          details: { branch: gitState.branch, unrelatedPaths: gitState.unrelatedPaths },
        });
      }
      if (gitState.unrelatedPaths.length > 0) {
        throw new AppError('Unrelated working-tree changes block publishing.', {
          status: 409,
          code: 'publish_blocked_unrelated_changes',
          details: { unrelatedPaths: gitState.unrelatedPaths },
        });
      }

      // Freeze the legacy docs-derived value before the build replaces docs/.
      // From this point on, only a successful push may advance publishedRevision.
      await this.boardStore.ensurePublishState(publishedSnapshot);

      const isWindows = process.platform === 'win32';
      const npmCommand = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
      const npmArgs = isWindows
        ? ['/d', '/s', '/c', 'npm.cmd', 'run', 'build']
        : ['run', 'build'];
      await this.commandRunner(npmCommand, npmArgs, { cwd: this.projectRoot });

      const afterBuild = await this.boardStore.getSnapshotUnlocked();
      if (afterBuild.revision !== baseRevision) {
        throw new RevisionConflictError(afterBuild.revision, afterBuild.publishedRevision);
      }

      const published = await this.boardStore.readBoardFile(this.boardStore.publishedBoardPath);
      const publishedValidation = validateBoard(published.board);
      if (!publishedValidation.ok
          || published.revision !== afterBuild.revision
          || !isDeepStrictEqual(afterBuild.board, published.board)) {
        throw new AppError('The build did not produce a valid, matching published board.', {
          status: 500,
          code: 'published_board_mismatch',
          details: { errors: publishedValidation.errors },
          expose: true,
        });
      }

      const afterBuildGit = await inspectGit(this.projectRoot);
      if (afterBuildGit.branch !== 'main'
          || afterBuildGit.head !== preflight.git.head
          || afterBuildGit.unrelatedPaths.length > 0) {
        throw new AppError('Git state changed during the build; publishing stopped before staging.', {
          status: 409,
          code: 'publish_blocked_after_build',
          details: {
            branch: afterBuildGit.branch,
            head: afterBuildGit.head,
            expectedHead: preflight.git.head,
            unrelatedPaths: afterBuildGit.unrelatedPaths,
          },
        });
      }

      await this.testHooks.beforeCapturePublishSnapshot?.({
        projectRoot: this.projectRoot,
        baseRevision,
      });
      const frozenSnapshot = await capturePublishSnapshot(this.projectRoot, baseRevision);
      await git(this.projectRoot, ['add', '-A', '--', 'data/board.json', 'docs']);
      await verifyStagedSnapshot(this.projectRoot, frozenSnapshot);
      const staged = await git(this.projectRoot, ['diff', '--cached', '--quiet', '--', 'data/board.json', 'docs'], {
        allowedExitCodes: [0, 1],
      });
      await this.testHooks.beforePublishCommit?.({
        projectRoot: this.projectRoot,
        baseRevision,
        frozenSnapshot: new Map(frozenSnapshot),
      });

      let committed = false;
      if (staged.exitCode === 1) {
        const message = `Update family board ${commitTimestamp()}`;
        await git(this.projectRoot, ['commit', '-m', message]);
        committed = true;
      }

      const commitResult = await git(this.projectRoot, ['rev-parse', 'HEAD']);
      const commitSha = commitResult.stdout.toString('utf8').trim();
      await verifyCommitSnapshot(this.projectRoot, commitSha, frozenSnapshot, { verifyChangedPaths: committed });

      let pushResult;
      try {
        pushResult = await git(this.projectRoot, ['push', 'origin', `${commitSha}:refs/heads/main`]);
      } catch (error) {
        throw new AppError('The local board was committed, but push did not succeed.', {
          status: 502,
          code: 'push_failed',
          details: {
            committed,
            commitSha,
            pushed: false,
            cause: error?.details ?? error?.message,
          },
        });
      }

      try {
        await this.boardStore.markPublishedRevision(afterBuild.revision, afterBuild.board);
      } catch (error) {
        throw new AppError('Push succeeded, but the local published-state record could not be updated.', {
          status: 500,
          code: 'publish_state_record_failed',
          details: {
            committed,
            commitSha,
            pushed: true,
            cause: error?.details ?? error?.message,
          },
          expose: true,
        });
      }

      const finalSnapshot = await this.boardStore.getSnapshotUnlocked();
      return {
        board: finalSnapshot.board,
        revision: finalSnapshot.revision,
        publishedRevision: finalSnapshot.publishedRevision,
        needsPublish: finalSnapshot.revision !== finalSnapshot.publishedRevision,
        summary: preflight.summary,
        committed,
        commitSha,
        published: true,
        pushed: true,
        pagesUrl: this.pagesUrl,
        pushOutput: `${pushResult.stdout.toString('utf8')}${pushResult.stderr.toString('utf8')}`.trim(),
      };
    });
  }
}

export { commitTimestamp, isPublishOwnedPath };
