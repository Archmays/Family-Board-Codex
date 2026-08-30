import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateBoard } from '../server/board-schema.mjs';
import { BoardStore } from '../server/board-store.mjs';
import { createFamilyBoardServer } from '../server/index.mjs';
import { Publisher, runCommand } from '../server/publisher.mjs';

function makeBoard() {
  return {
    schemaVersion: 1,
    meta: {
      title: '黄家日程板',
      timezone: 'Asia/Shanghai',
      lastUpdated: '2026-08-30T22:00:00+08:00',
    },
    children: [
      { id: 'xiaoyue', name: '黄小越' },
      { id: 'xiaoyi', name: '黄小翊' },
    ],
    schedule: [],
    tasks: [],
  };
}

async function makeProject(t, prefix = 'family-board-server-test-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'data'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'data'), { recursive: true });
  const bytes = `${JSON.stringify(makeBoard(), null, 2)}\n`;
  await writeFile(path.join(root, 'data', 'board.json'), bytes);
  await writeFile(path.join(root, 'docs', 'data', 'board.json'), bytes);
  return root;
}

test('schema enforces completedAt consistency and complete photo fields', () => {
  const board = makeBoard();
  board.tasks.push({
    id: 'task-1',
    title: 'Done',
    relatedTo: 'family',
    dueDate: '2026-08-30',
    status: 'completed',
    completedAt: null,
    note: '',
    photos: [],
  });
  const result = validateBoard(board);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === 'tasks[0].completedAt'));
});

test('BoardStore serializes saves, timestamps them, keeps one backup, and rejects stale revisions', async (t) => {
  const root = await makeProject(t);
  const store = new BoardStore({ projectRoot: root });
  const initial = await store.getSnapshot();
  const next = structuredClone(initial.board);
  next.schedule.push({
    id: 'course-1',
    childId: 'xiaoyue',
    weekday: 1,
    title: 'Math',
    startTime: '08:00',
    endTime: '09:00',
    location: '',
    note: '',
    photos: [],
  });

  const saved = await store.save(next, initial.revision);
  assert.match(saved.board.meta.lastUpdated, /\+08:00$/);
  assert.equal(saved.board.schedule.length, 1);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, 'data', 'board.json.bak'), 'utf8')),
    initial.board,
  );
  await assert.rejects(
    store.save(next, initial.revision),
    (error) => error.status === 409 && error.code === 'revision_conflict',
  );
});

test('BoardStore final comparison preserves an external writer and returns a revision conflict', async (t) => {
  const root = await makeProject(t, 'family-board-capture-race-test-');
  let externalBytes;
  const store = new BoardStore({
    projectRoot: root,
    testHooks: {
      async beforeFinalRevisionCheck({ boardPath }) {
        await writeFile(boardPath, externalBytes);
      },
    },
  });
  const initial = await store.getSnapshot();
  const external = structuredClone(initial.board);
  external.tasks.push({
    id: 'task-external',
    title: 'External edit',
    relatedTo: 'family',
    dueDate: '2026-09-03',
    status: 'not_started',
    completedAt: null,
    note: '',
    photos: [],
  });
  externalBytes = `${JSON.stringify(external, null, 2)}\n`;
  const desired = structuredClone(initial.board);
  desired.schedule.push({
    id: 'course-local',
    childId: 'xiaoyue',
    weekday: 1,
    title: 'Local edit',
    startTime: '10:00',
    endTime: '11:00',
    location: '',
    note: '',
    photos: [],
  });

  await assert.rejects(
    store.save(desired, initial.revision),
    (error) => error.status === 409 && error.code === 'revision_conflict',
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, 'data', 'board.json'), 'utf8')),
    external,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, 'data', 'board.json.bak'), 'utf8')),
    initial.board,
  );
});

test('HTTP server is loopback-capable, returns revisions, and blocks cross-origin mutations', async (t) => {
  const root = await makeProject(t);
  const store = new BoardStore({ projectRoot: root });
  const publisher = {
    async preflight(baseRevision) {
      return {
        revision: baseRevision,
        publishedRevision: baseRevision,
        needsPublish: false,
        summary: {
          courses: { added: 0, modified: 0, deleted: 0 },
          tasks: { added: 0, modified: 0, deleted: 0 },
          photos: { added: 0, removed: 0 },
        },
        git: { blocked: false, unrelatedPaths: [] },
      };
    },
  };
  const app = await createFamilyBoardServer({
    projectRoot: root,
    useVite: false,
    boardStore: store,
    publisher,
  });
  t.after(() => app.close());
  const address = await app.listen({ port: 0, autoOpen: false });

  const boardResponse = await fetch(`${address.url}api/board`);
  assert.equal(boardResponse.status, 200);
  const snapshot = await boardResponse.json();
  assert.match(snapshot.revision, /^[a-f0-9]{64}$/);

  const forbidden = await fetch(`${address.url}api/publish/preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ baseRevision: snapshot.revision }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, 'origin_forbidden');

  const missingToken = await fetch(`${address.url}api/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: snapshot.revision }),
  });
  assert.equal(missingToken.status, 400);
  assert.equal((await missingToken.json()).code, 'invalid_preflight_token');

  const staticPost = await fetch(`${address.url}data/board.json`, { method: 'POST' });
  assert.equal(staticPost.status, 405);
  assert.equal((await staticPost.json()).code, 'method_not_allowed');

  await Promise.all([
    mkdir(path.join(root, 'media', 'full'), { recursive: true }),
    mkdir(path.join(root, 'media', 'thumb'), { recursive: true }),
  ]);
  const unreferencedPhoto = {
    id: 'photo-11111111-1111-4111-8111-111111111111',
    src: 'media/full/photo-11111111-1111-4111-8111-111111111111.png',
    thumbnail: 'media/thumb/photo-11111111-1111-4111-8111-111111111111-thumb.png',
  };
  await Promise.all([
    writeFile(path.join(root, unreferencedPhoto.src), 'full'),
    writeFile(path.join(root, unreferencedPhoto.thumbnail), 'thumb'),
  ]);
  const discarded = await fetch(`${address.url}api/media/discard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ photo: unreferencedPhoto }),
  });
  assert.equal(discarded.status, 200);
  assert.equal((await discarded.json()).discarded, true);
  await assert.rejects(readFile(path.join(root, unreferencedPhoto.src)), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, unreferencedPhoto.thumbnail)), { code: 'ENOENT' });

  const referencedPhoto = {
    id: 'photo-22222222-2222-4222-8222-222222222222',
    src: 'media/full/photo-22222222-2222-4222-8222-222222222222.png',
    thumbnail: 'media/thumb/photo-22222222-2222-4222-8222-222222222222-thumb.png',
    caption: '',
    width: 1,
    height: 1,
    mimeType: 'image/png',
  };
  await Promise.all([
    writeFile(path.join(root, referencedPhoto.src), 'full'),
    writeFile(path.join(root, referencedPhoto.thumbnail), 'thumb'),
  ]);
  const boardWithPhoto = structuredClone(snapshot.board);
  boardWithPhoto.tasks.push({
    id: 'task-with-photo',
    title: 'Referenced photo',
    relatedTo: 'family',
    dueDate: '2026-09-07',
    status: 'not_started',
    completedAt: null,
    note: '',
    photos: [referencedPhoto],
  });
  await store.save(boardWithPhoto, snapshot.revision);
  const retained = await fetch(`${address.url}api/media/discard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ photo: referencedPhoto }),
  });
  assert.equal(retained.status, 409);
  assert.equal((await retained.json()).code, 'media_in_use');
  assert.equal(await readFile(path.join(root, referencedPhoto.src), 'utf8'), 'full');
  assert.equal(await readFile(path.join(root, referencedPhoto.thumbnail), 'utf8'), 'thumb');
});

test('Publisher freezes confirmed bytes, commits only the index, and reloads a later disk edit', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'family-board-publish-test-'));
  t.after(async () => {
    assert.ok(path.basename(base).startsWith('family-board-publish-test-'));
    await rm(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  await mkdir(path.join(root, 'data'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'data'), { recursive: true });
  const bytes = `${JSON.stringify(makeBoard(), null, 2)}\n`;
  await writeFile(path.join(root, 'data', 'board.json'), bytes);
  await writeFile(path.join(root, 'docs', 'data', 'board.json'), bytes);
  await writeFile(path.join(root, '.gitignore'), 'data/board.json.bak\ndata/publish-state.json\ndata/*.tmp\n');

  const git = (...args) => runCommand('git', args, { cwd: root });
  await runCommand('git', ['init', '--bare', remote], { cwd: base });
  await runCommand('git', ['init', '-b', 'main'], { cwd: root });
  await git('config', 'user.name', 'Server Test');
  await git('config', 'user.email', 'server-test@example.invalid');
  await git('add', '.');
  await git('commit', '-m', 'Initial');
  await git('remote', 'add', 'origin', remote);
  await git('push', '-u', 'origin', 'main');

  const store = new BoardStore({ projectRoot: root });
  const initial = await store.getSnapshot();
  const changed = structuredClone(initial.board);
  changed.tasks.push({
    id: 'task-1',
    title: 'Test',
    relatedTo: 'family',
    dueDate: '2026-09-01',
    status: 'not_started',
    completedAt: null,
    note: '',
    photos: [],
  });
  const saved = await store.save(changed, initial.revision);
  const external = structuredClone(saved.board);
  external.tasks.push({
    id: 'task-external-after-confirmation',
    title: 'Later external edit',
    relatedTo: 'family',
    dueDate: '2026-09-04',
    status: 'not_started',
    completedAt: null,
    note: '',
    photos: [],
  });
  const savedBytes = `${JSON.stringify(saved.board, null, 2)}\n`;
  const externalBytes = `${JSON.stringify(external, null, 2)}\n`;
  let buildInvocation;
  const publisherOptions = {
    projectRoot: root,
    boardStore: store,
    commandRunner: async (command, args, options) => {
      buildInvocation = { command, args, options };
      await copyFile(path.join(root, 'data', 'board.json'), path.join(root, 'docs', 'data', 'board.json'));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    pagesUrl: 'https://example.invalid/',
  };
  const headRacePublisher = new Publisher({
    ...publisherOptions,
    commandRunner: async () => {
      await copyFile(path.join(root, 'data', 'board.json'), path.join(root, 'docs', 'data', 'board.json'));
      await git('commit', '--allow-empty', '-m', 'Concurrent confirmed-head change');
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });
  const headRacePlan = await headRacePublisher.preflight(saved.revision);
  await assert.rejects(
    headRacePublisher.publish(saved.revision, headRacePlan.preflightToken),
    (error) => error.status === 409
      && error.code === 'publish_blocked_after_build'
      && error.details?.expectedHead === headRacePlan.git.head
      && error.details?.head !== headRacePlan.git.head,
  );

  const captureRacePublisher = new Publisher({
    ...publisherOptions,
    testHooks: {
      async beforeCapturePublishSnapshot() {
        await writeFile(path.join(root, 'data', 'board.json'), externalBytes);
      },
    },
  });
  const captureRacePlan = await captureRacePublisher.preflight(saved.revision);
  await assert.rejects(
    captureRacePublisher.publish(saved.revision, captureRacePlan.preflightToken),
    (error) => error.status === 409 && error.code === 'publish_board_changed_during_freeze',
  );
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'data', 'board.json'), 'utf8')), external);
  await writeFile(path.join(root, 'data', 'board.json'), savedBytes);

  const publisher = new Publisher({
    ...publisherOptions,
    testHooks: {
      async beforePublishCommit() {
        await writeFile(path.join(root, 'data', 'board.json'), externalBytes);
      },
    },
  });

  const preflight = await publisher.preflight(saved.revision);
  assert.equal(preflight.git.branch, 'main');
  assert.match(preflight.preflightToken, /^[a-f0-9]{64}$/);
  await assert.rejects(
    publisher.publish(saved.revision, '0'.repeat(64)),
    (error) => error.status === 409 && error.code === 'publish_preflight_changed',
  );
  const unrelatedPath = path.join(root, 'unrelated.txt');
  await writeFile(unrelatedPath, 'unrelated');
  await assert.rejects(
    publisher.publish(saved.revision, preflight.preflightToken),
    (error) => error.status === 409 && error.code === 'publish_preflight_changed',
  );
  await rm(unrelatedPath, { force: true });
  const confirmedPreflight = await publisher.preflight(saved.revision);
  const result = await publisher.publish(saved.revision, confirmedPreflight.preflightToken);
  assert.equal(result.published, true);
  assert.equal(result.pushed, true);
  assert.equal(result.needsPublish, true);
  assert.deepEqual(result.board, external);
  assert.equal(result.publishedRevision, saved.revision);
  assert.equal(buildInvocation.options.cwd, root);
  assert.equal(buildInvocation.options.env.NODE_ENV, 'production');
  if (process.platform === 'win32') {
    assert.equal(buildInvocation.command.toLowerCase(), (process.env.ComSpec || 'cmd.exe').toLowerCase());
    assert.deepEqual(buildInvocation.args, ['/d', '/s', '/c', 'npm.cmd', 'run', 'build']);
  } else {
    assert.equal(buildInvocation.command, 'npm');
    assert.deepEqual(buildInvocation.args, ['run', 'build']);
  }
  const publishState = JSON.parse(await readFile(path.join(root, 'data', 'publish-state.json'), 'utf8'));
  assert.equal(publishState.publishedRevision, saved.revision);
  assert.deepEqual(publishState.publishedBoard, saved.board);
  const message = (await git('log', '-1', '--format=%s')).stdout.toString().trim();
  assert.match(message, /^Update family board \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const changedPaths = (await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'))
    .stdout.toString().trim().split(/\r?\n/).sort();
  assert.deepEqual(changedPaths, ['data/board.json', 'docs/data/board.json']);
  assert.deepEqual(
    JSON.parse((await git('show', 'HEAD:data/board.json')).stdout.toString('utf8')),
    saved.board,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, 'data', 'board.json'), 'utf8')),
    external,
  );
  const localSha = (await git('rev-parse', 'HEAD')).stdout.toString().trim();
  const remoteSha = (await git('--git-dir', remote, 'rev-parse', 'refs/heads/main')).stdout.toString().trim();
  assert.equal(localSha, remoteSha);
});

test('failed push preserves the last successful revision across reload and can be retried', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'family-board-push-retry-test-'));
  t.after(async () => {
    assert.ok(path.basename(base).startsWith('family-board-push-retry-test-'));
    await rm(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  const missingRemote = path.join(base, 'missing-remote.git');
  await mkdir(path.join(root, 'data'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'data'), { recursive: true });
  const bytes = `${JSON.stringify(makeBoard(), null, 2)}\n`;
  await writeFile(path.join(root, 'data', 'board.json'), bytes);
  await writeFile(path.join(root, 'docs', 'data', 'board.json'), bytes);
  await writeFile(path.join(root, '.gitignore'), 'data/board.json.bak\ndata/publish-state.json\ndata/*.tmp\n');

  const git = (...args) => runCommand('git', args, { cwd: root });
  await runCommand('git', ['init', '--bare', remote], { cwd: base });
  await runCommand('git', ['init', '-b', 'main'], { cwd: root });
  await git('config', 'user.name', 'Server Test');
  await git('config', 'user.email', 'server-test@example.invalid');
  await git('add', '.');
  await git('commit', '-m', 'Initial');
  await git('remote', 'add', 'origin', remote);
  await git('push', '-u', 'origin', 'main');

  const store = new BoardStore({ projectRoot: root });
  const initial = await store.getSnapshot();
  const changed = structuredClone(initial.board);
  changed.tasks.push({
    id: 'task-retry',
    title: 'Retry publish',
    relatedTo: 'family',
    dueDate: '2026-09-02',
    status: 'not_started',
    completedAt: null,
    note: '',
    photos: [],
  });
  const saved = await store.save(changed, initial.revision);
  await git('remote', 'set-url', 'origin', missingRemote);

  const makePublisher = (boardStore) => new Publisher({
    projectRoot: root,
    boardStore,
    commandRunner: async () => {
      await copyFile(path.join(root, 'data', 'board.json'), path.join(root, 'docs', 'data', 'board.json'));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    pagesUrl: 'https://example.invalid/',
  });

  const failedPublisher = makePublisher(store);
  const failedPlan = await failedPublisher.preflight(saved.revision);
  await assert.rejects(
    failedPublisher.publish(saved.revision, failedPlan.preflightToken),
    (error) => error.code === 'push_failed'
      && error.details?.pushed === false
      && typeof error.details?.commitSha === 'string',
  );

  const failedState = JSON.parse(await readFile(path.join(root, 'data', 'publish-state.json'), 'utf8'));
  assert.equal(failedState.publishedRevision, initial.revision);
  assert.deepEqual(failedState.publishedBoard, initial.board);
  const reloadedStore = new BoardStore({ projectRoot: root });
  const afterReload = await reloadedStore.getSnapshot();
  assert.equal(afterReload.revision, saved.revision);
  assert.equal(afterReload.publishedRevision, initial.revision);
  assert.notEqual(afterReload.publishedRevision, afterReload.revision);

  await git('remote', 'set-url', 'origin', remote);
  const retryPublisher = makePublisher(reloadedStore);
  const retryPlan = await retryPublisher.preflight(saved.revision);
  assert.equal(retryPlan.summary.tasks.added, 1);
  assert.equal(retryPlan.summary.tasks.modified, 0);
  assert.equal(retryPlan.summary.tasks.deleted, 0);
  const retried = await retryPublisher.publish(saved.revision, retryPlan.preflightToken);
  assert.equal(retried.published, true);
  assert.equal(retried.pushed, true);
  assert.equal(retried.committed, false);
  assert.equal(retried.publishedRevision, saved.revision);
  assert.equal(retried.needsPublish, false);
  const retryState = JSON.parse(await readFile(path.join(root, 'data', 'publish-state.json'), 'utf8'));
  assert.equal(retryState.publishedRevision, saved.revision);
  assert.deepEqual(retryState.publishedBoard, saved.board);
  const localSha = (await git('rev-parse', 'HEAD')).stdout.toString().trim();
  const remoteSha = (await git('--git-dir', remote, 'rev-parse', 'refs/heads/main')).stdout.toString().trim();
  assert.equal(localSha, remoteSha);
});
