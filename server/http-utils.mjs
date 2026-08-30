import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { AppError } from './errors.mjs';

const MIME_TYPES = new Map([
  ['.json', 'application/json; charset=utf-8'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

export function sendJson(response, status, payload) {
  if (response.headersSent || response.writableEnded) {
    return;
  }
  const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(bytes);
}

export function sendError(response, error) {
  const appError = error instanceof AppError
    ? error
    : new AppError('Unexpected server error.', { cause: error });

  const payload = {
    error: appError.expose ? appError.message : 'Unexpected server error.',
    code: appError.code,
  };
  if (appError.details !== undefined && appError.expose) {
    payload.details = appError.details;
  }
  sendJson(response, appError.status, payload);
}

export function readRequestBody(request, maxBytes) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    throw new AppError('Request body is too large.', {
      status: 413,
      code: 'request_too_large',
    });
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    request.on('data', (chunk) => {
      if (settled) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        chunks.length = 0;
        request.resume();
        reject(new AppError('Request body is too large.', {
          status: 413,
          code: 'request_too_large',
        }));
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks, total));
      }
    });
    request.once('aborted', () => {
      if (!settled) {
        settled = true;
        reject(new AppError('Request was aborted.', {
          status: 400,
          code: 'request_aborted',
        }));
      }
    });
    request.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

export async function readJsonBody(request, maxBytes = 5 * 1024 * 1024) {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new AppError('Content-Type must be application/json.', {
      status: 415,
      code: 'unsupported_media_type',
    });
  }
  const bytes = await readRequestBody(request, maxBytes);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new AppError('Request body is not valid JSON.', {
      status: 400,
      code: 'invalid_json',
    });
  }
}

export function assertSameOriginMutation(request, port) {
  const host = request.headers.host?.toLowerCase();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!host || !allowedHosts.has(host)) {
    throw new AppError('Mutation request Host is not the local editor.', {
      status: 403,
      code: 'origin_forbidden',
    });
  }

  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site' || fetchSite === 'cross-origin') {
    throw new AppError('Cross-origin mutation requests are forbidden.', {
      status: 403,
      code: 'origin_forbidden',
    });
  }

  const origin = request.headers.origin;
  if (origin === undefined) {
    // Local command-line clients do not normally send Origin. A browser
    // attacker does, and is checked below; the server is loopback-only.
    return;
  }

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new AppError('Mutation request Origin is invalid.', {
      status: 403,
      code: 'origin_forbidden',
    });
  }

  const originHost = parsed.hostname.toLowerCase();
  const originPort = parsed.port || (parsed.protocol === 'http:' ? '80' : '443');
  if (parsed.protocol !== 'http:'
      || !['127.0.0.1', 'localhost'].includes(originHost)
      || originPort !== String(port)) {
    throw new AppError('Mutation request Origin is not the local editor.', {
      status: 403,
      code: 'origin_forbidden',
    });
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export async function serveStaticFile(request, response, {
  routePrefix,
  directory,
  only,
}) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    throw new AppError('Method not allowed.', {
      status: 405,
      code: 'method_not_allowed',
    });
  }

  const url = new URL(request.url, 'http://127.0.0.1');
  if (!url.pathname.startsWith(routePrefix)) {
    return false;
  }

  let relative;
  try {
    relative = decodeURIComponent(url.pathname.slice(routePrefix.length));
  } catch {
    throw new AppError('Invalid path encoding.', { status: 400, code: 'invalid_path' });
  }
  relative = relative.replaceAll('/', path.sep);
  if (!relative || relative.includes('\0') || (only && relative !== only)) {
    throw new AppError('File not found.', { status: 404, code: 'not_found' });
  }

  const root = path.resolve(directory);
  const candidate = path.resolve(root, relative);
  if (!isInside(root, candidate)) {
    throw new AppError('File not found.', { status: 404, code: 'not_found' });
  }

  let fileStat;
  try {
    fileStat = await stat(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new AppError('File not found.', { status: 404, code: 'not_found' });
    }
    throw error;
  }
  if (!fileStat.isFile()) {
    throw new AppError('File not found.', { status: 404, code: 'not_found' });
  }

  response.writeHead(200, {
    'Content-Type': MIME_TYPES.get(path.extname(candidate).toLowerCase()) ?? 'application/octet-stream',
    'Content-Length': fileStat.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') {
    response.end();
  } else {
    await pipeline(createReadStream(candidate), response);
  }
  return true;
}
