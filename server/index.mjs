import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BoardStore } from './board-store.mjs';
import { AppError } from './errors.mjs';
import {
  assertSameOriginMutation,
  readJsonBody,
  readRequestBody,
  sendError,
  sendJson,
  serveStaticFile,
} from './http-utils.mjs';
import { discardMediaUpload, MEDIA_LIMITS, storeMediaUpload } from './media-upload.mjs';
import { Publisher } from './publisher.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(MODULE_DIRECTORY, '..');
const DEFAULT_PORT = 4173;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;

function requireObjectBody(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('Request body must be an object.', {
      status: 400,
      code: 'invalid_request',
    });
  }
  return value;
}

function requireBaseRevision(body) {
  if (typeof body.baseRevision !== 'string' || !REVISION_PATTERN.test(body.baseRevision)) {
    throw new AppError('baseRevision must be a SHA-256 revision string.', {
      status: 400,
      code: 'invalid_base_revision',
    });
  }
  return body.baseRevision;
}

function requirePreflightToken(body) {
  if (typeof body.preflightToken !== 'string' || !REVISION_PATTERN.test(body.preflightToken)) {
    throw new AppError('preflightToken must be the token returned by publish preflight.', {
      status: 400,
      code: 'invalid_preflight_token',
    });
  }
  return body.preflightToken;
}

function boardReferencesUploadedMedia(board, photo) {
  return [...board.schedule, ...board.tasks].some((item) => (item.photos ?? []).some(
    (existing) => existing.id === photo?.id
      || existing.src === photo?.src
      || existing.thumbnail === photo?.thumbnail,
  ));
}

function openBrowser(url) {
  let command;
  let args;
  let windowsVerbatimArguments = false;
  if (process.platform === 'win32') {
    command = 'cmd.exe';
    // cmd.exe's `start` has its own quoting rules. Passing the quoted pieces as
    // separate spawn arguments causes Node to quote them a second time, turning
    // the URL into an invalid file path. Send one verbatim command line instead.
    args = [`/d /s /c start "" "${url}"`];
    windowsVerbatimArguments = true;
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments,
      stdio: 'ignore',
    });
    child.unref();
  } catch (error) {
    console.warn(`Could not open the editor automatically: ${error.message}`);
  }
}

async function createViteMiddleware(projectRoot) {
  let createViteServer;
  try {
    ({ createServer: createViteServer } = await import('vite'));
  } catch (error) {
    throw new AppError('Vite is required to run the local editor.', {
      status: 500,
      code: 'vite_unavailable',
      cause: error,
      expose: true,
    });
  }

  return createViteServer({
    root: projectRoot,
    appType: 'spa',
    server: {
      middlewareMode: true,
      hmr: false,
    },
  });
}

export async function createFamilyBoardServer({
  projectRoot = DEFAULT_PROJECT_ROOT,
  useVite = true,
  boardStore,
  publisher,
} = {}) {
  const resolvedRoot = path.resolve(projectRoot);
  const store = boardStore ?? new BoardStore({ projectRoot: resolvedRoot });
  const publishService = publisher ?? new Publisher({
    projectRoot: resolvedRoot,
    boardStore: store,
  });
  const vite = useVite ? await createViteMiddleware(resolvedRoot) : null;
  let listeningPort = null;

  async function handleApi(request, response, pathname) {
    if (pathname === '/api/board' && request.method === 'GET') {
      sendJson(response, 200, await store.getSnapshot());
      return true;
    }

    if (pathname === '/api/revision' && request.method === 'GET') {
      const snapshot = await store.getSnapshot();
      sendJson(response, 200, {
        revision: snapshot.revision,
        publishedRevision: snapshot.publishedRevision,
      });
      return true;
    }

    if (!pathname.startsWith('/api/')) {
      return false;
    }

    if (request.method !== 'POST') {
      throw new AppError('API route not found or method not allowed.', {
        status: 405,
        code: 'method_not_allowed',
      });
    }
    assertSameOriginMutation(request, listeningPort);

    if (pathname === '/api/save') {
      const body = requireObjectBody(await readJsonBody(request));
      const baseRevision = requireBaseRevision(body);
      if (!Object.hasOwn(body, 'board')) {
        throw new AppError('board is required.', { status: 400, code: 'invalid_request' });
      }
      sendJson(response, 200, await store.save(body.board, baseRevision));
      return true;
    }

    if (pathname === '/api/media') {
      const contentType = request.headers['content-type'] ?? '';
      if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) {
        throw new AppError('Content-Type must be multipart/form-data.', {
          status: 415,
          code: 'unsupported_media_type',
        });
      }
      const bytes = await readRequestBody(request, MEDIA_LIMITS.requestBytes);
      let stored;
      let responseClosed = false;
      const cleanupInterruptedUpload = () => {
        responseClosed = true;
        if (stored && !response.writableFinished) {
          void discardMediaUpload({ projectRoot: resolvedRoot, photo: stored.photo }).catch(() => {});
        }
      };
      response.once('close', cleanupInterruptedUpload);
      stored = await storeMediaUpload({
        projectRoot: resolvedRoot,
        body: bytes,
        contentType,
      });
      if (responseClosed || response.destroyed) {
        await discardMediaUpload({ projectRoot: resolvedRoot, photo: stored.photo });
        return true;
      }
      sendJson(response, 201, stored);
      return true;
    }

    if (pathname === '/api/media/discard') {
      const body = requireObjectBody(await readJsonBody(request, 64 * 1024));
      sendJson(response, 200, await store.withExclusive(async () => {
        const snapshot = await store.getSnapshotUnlocked();
        if (boardReferencesUploadedMedia(snapshot.board, body.photo)) {
          throw new AppError('A saved board item already references this photo.', {
            status: 409,
            code: 'media_in_use',
          });
        }
        return discardMediaUpload({
          projectRoot: resolvedRoot,
          photo: body.photo,
        });
      }));
      return true;
    }

    if (pathname === '/api/publish/preflight') {
      const body = requireObjectBody(await readJsonBody(request, 64 * 1024));
      sendJson(response, 200, await publishService.preflight(requireBaseRevision(body)));
      return true;
    }

    if (pathname === '/api/publish') {
      const body = requireObjectBody(await readJsonBody(request, 64 * 1024));
      sendJson(response, 200, await publishService.publish(
        requireBaseRevision(body),
        requirePreflightToken(body),
      ));
      return true;
    }

    throw new AppError('API route not found.', { status: 404, code: 'not_found' });
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (await handleApi(request, response, url.pathname)) {
        return;
      }
      if (url.pathname.startsWith('/data/')) {
        await serveStaticFile(request, response, {
          routePrefix: '/data/',
          directory: path.join(resolvedRoot, 'data'),
          only: 'board.json',
        });
        return;
      }
      if (url.pathname.startsWith('/media/')) {
        await serveStaticFile(request, response, {
          routePrefix: '/media/',
          directory: path.join(resolvedRoot, 'media'),
        });
        return;
      }

      if (!vite) {
        throw new AppError('Page not found.', { status: 404, code: 'not_found' });
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        throw new AppError('Method not allowed.', { status: 405, code: 'method_not_allowed' });
      }
      if (url.pathname === '/') {
        request.url = `/editor.html${url.search}`;
      }
      vite.middlewares(request, response, (error) => {
        if (error) {
          sendError(response, error);
        } else if (!response.writableEnded) {
          sendError(response, new AppError('Page not found.', { status: 404, code: 'not_found' }));
        }
      });
    } catch (error) {
      if (error?.status >= 500) {
        console.error(error);
      }
      sendError(response, error);
    }
  });

  async function listen({ port = DEFAULT_PORT, autoOpen = true } = {}) {
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error('port must be an integer from 0 to 65535');
    }
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once('error', onError);
      server.listen({ host: '127.0.0.1', port }, () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address();
    listeningPort = typeof address === 'object' && address ? address.port : port;
    const url = `http://127.0.0.1:${listeningPort}/`;
    if (autoOpen && process.env.FAMILY_BOARD_NO_OPEN !== '1') {
      openBrowser(`${url}editor.html`);
    }
    return { host: '127.0.0.1', port: listeningPort, url };
  }

  async function close() {
    await new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await vite?.close();
  }

  return {
    server,
    boardStore: store,
    publisher: publishService,
    listen,
    close,
  };
}

function parseCliPort(argv) {
  const portIndex = argv.indexOf('--port');
  const candidate = portIndex >= 0 ? argv[portIndex + 1] : process.env.FAMILY_BOARD_PORT;
  if (candidate === undefined) {
    return DEFAULT_PORT;
  }
  const port = Number(candidate);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid editor port: ${candidate}`);
  }
  return port;
}

export async function startFamilyBoardServer(options = {}) {
  const app = await createFamilyBoardServer(options);
  const address = await app.listen({
    port: options.port ?? parseCliPort(process.argv.slice(2)),
    autoOpen: options.autoOpen ?? true,
  });
  return { ...app, address };
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  const app = await startFamilyBoardServer();
  console.log(`Family Board editor: ${app.address.url}`);

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export { DEFAULT_PORT, DEFAULT_PROJECT_ROOT };
