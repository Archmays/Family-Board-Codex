import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { validateBoard } from '../server/board-schema.mjs';
import { inspectImage, storeMediaUpload } from '../server/media-upload.mjs';

const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z',
  'base64',
);
const WEBP_1X1 = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function makePng(width = 1, height = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(height * ((width * 4) + 1));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND'),
  ]);
}

function webpChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length);
  return Buffer.concat([
    Buffer.from(type, 'ascii'),
    length,
    data,
    data.length % 2 === 0 ? Buffer.alloc(0) : Buffer.from([0]),
  ]);
}

function makeExtendedAlphaWebp(width, height, alphaHeader, alphaPayload) {
  const extended = Buffer.alloc(10);
  extended[0] = 0x10;
  extended.writeUIntLE(width - 1, 4, 3);
  extended.writeUIntLE(height - 1, 7, 3);
  const frame = Buffer.alloc(11);
  frame[0] = 0x30;
  frame[3] = 0x9d;
  frame[4] = 0x01;
  frame[5] = 0x2a;
  frame.writeUInt16LE(width, 6);
  frame.writeUInt16LE(height, 8);
  const chunks = Buffer.concat([
    webpChunk('VP8X', extended),
    webpChunk('ALPH', Buffer.concat([Buffer.from([alphaHeader]), alphaPayload])),
    webpChunk('VP8 ', frame),
  ]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(chunks.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, chunks]);
}

function multipartBody(fields, boundary = '----family-board-media-validation') {
  const chunks = [];
  for (const field of fields) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"`;
    if (field.filename) {
      header += `; filename="${field.filename}"\r\nContent-Type: ${field.contentType}`;
    }
    header += '\r\n\r\n';
    chunks.push(
      Buffer.from(header),
      Buffer.isBuffer(field.value) ? field.value : Buffer.from(field.value),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(chunks) };
}

function uploadFor(full, thumbnail, mimeType, width, height) {
  return multipartBody([
    { name: 'full', filename: 'full.bin', contentType: mimeType, value: full },
    {
      name: 'thumbnail',
      filename: 'thumb.png',
      contentType: inspectImage(thumbnail).mimeType,
      value: thumbnail,
    },
    { name: 'width', value: String(width) },
    { name: 'height', value: String(height) },
    { name: 'mimeType', value: mimeType },
    { name: 'caption', value: '' },
  ]);
}

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

function photo(id, extension = 'webp', mimeType = 'image/webp') {
  return {
    id,
    src: `media/full/${id}.${extension}`,
    thumbnail: `media/thumb/${id}.png`,
    caption: '',
    width: 1,
    height: 1,
    mimeType,
  };
}

test('structural parser retains safe JPEG, PNG, and WebP fixtures', () => {
  assert.deepEqual(inspectImage(JPEG_1X1), { mimeType: 'image/jpeg', width: 1, height: 1 });
  assert.deepEqual(inspectImage(makePng()), { mimeType: 'image/png', width: 1, height: 1 });
  assert.deepEqual(inspectImage(WEBP_1X1), { mimeType: 'image/webp', width: 1, height: 1 });
});

test('WebP alpha header permits lossless compression and validates raw payload length', () => {
  assert.deepEqual(
    inspectImage(makeExtendedAlphaWebp(1, 1, 0x01, Buffer.from([0]))),
    { mimeType: 'image/webp', width: 1, height: 1 },
  );
  assert.deepEqual(
    inspectImage(makeExtendedAlphaWebp(2, 1, 0x00, Buffer.from([0, 255]))),
    { mimeType: 'image/webp', width: 2, height: 1 },
  );
  assert.throws(
    () => inspectImage(makeExtendedAlphaWebp(2, 1, 0x00, Buffer.from([0]))),
    (error) => error.status === 422 && /alpha payload length/i.test(error.message),
  );
});

test('structural parser rejects truncated JPEG, PNG, and WebP', () => {
  for (const fixture of [JPEG_1X1, makePng(), WEBP_1X1]) {
    assert.throws(
      () => inspectImage(fixture.subarray(0, fixture.length - 1)),
      (error) => error.status === 422 && error.code === 'invalid_media_upload',
    );
  }

  const signatureOnlyFixtures = [
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'latin1'),
  ];
  for (const fixture of signatureOnlyFixtures) {
    assert.throws(() => inspectImage(fixture), (error) => error.status === 422);
  }
});

test('structural parser rejects EXIF, XMP, and GPS-bearing metadata containers', () => {
  const jpegMetadata = Buffer.from('Exif\0\0GPS latitude', 'ascii');
  const jpegLength = Buffer.alloc(2);
  jpegLength.writeUInt16BE(jpegMetadata.length + 2);
  const jpegWithExif = Buffer.concat([
    JPEG_1X1.subarray(0, 2),
    Buffer.from([0xff, 0xe1]),
    jpegLength,
    jpegMetadata,
    JPEG_1X1.subarray(2),
  ]);

  const png = makePng();
  const pngWithXmp = Buffer.concat([
    png.subarray(0, 33),
    pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0GPS', 'ascii')),
    png.subarray(33),
  ]);

  const webpMetadata = Buffer.concat([
    Buffer.from('EXIF', 'ascii'),
    Buffer.from([4, 0, 0, 0]),
    Buffer.from('GPS\0', 'ascii'),
  ]);
  const webpWithExif = Buffer.concat([WEBP_1X1, webpMetadata]);
  webpWithExif.writeUInt32LE(webpWithExif.length - 8, 4);

  for (const fixture of [jpegWithExif, pngWithXmp, webpWithExif]) {
    assert.throws(
      () => inspectImage(fixture),
      (error) => error.status === 422 && /metadata/i.test(error.message),
    );
  }
});

test('upload verifies actual dimensions, edge limits, and writes only accepted bytes', async (t) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'family-board-media-validation-'));
  t.after(async () => {
    assert.ok(path.basename(projectRoot).startsWith('family-board-media-validation-'));
    await rm(projectRoot, { recursive: true, force: true });
  });

  const safeFormats = [
    { bytes: JPEG_1X1, mimeType: 'image/jpeg', extension: 'jpg' },
    { bytes: makePng(), mimeType: 'image/png', extension: 'png' },
    { bytes: WEBP_1X1, mimeType: 'image/webp', extension: 'webp' },
  ];
  for (const fixture of safeFormats) {
    const upload = uploadFor(fixture.bytes, makePng(), fixture.mimeType, 1, 1);
    const stored = await storeMediaUpload({
      projectRoot,
      body: upload.body,
      contentType: `multipart/form-data; boundary=${upload.boundary}`,
    });
    assert.match(stored.photo.src, new RegExp(`\\.${fixture.extension}$`));
    assert.deepEqual(await readFile(path.join(projectRoot, stored.photo.src)), fixture.bytes);
  }

  const mismatched = uploadFor(makePng(2, 1), makePng(), 'image/png', 1, 1);
  await assert.rejects(
    storeMediaUpload({
      projectRoot,
      body: mismatched.body,
      contentType: `multipart/form-data; boundary=${mismatched.boundary}`,
    }),
    (error) => error.status === 422 && /do not match/.test(error.message),
  );

  const oversizedFull = uploadFor(makePng(2_001, 1), makePng(), 'image/png', 2_001, 1);
  await assert.rejects(
    storeMediaUpload({
      projectRoot,
      body: oversizedFull.body,
      contentType: `multipart/form-data; boundary=${oversizedFull.boundary}`,
    }),
    (error) => error.status === 422 && error.details?.maxEdge === 2_000,
  );

  const oversizedThumb = uploadFor(makePng(), makePng(601, 1), 'image/png', 1, 1);
  await assert.rejects(
    storeMediaUpload({
      projectRoot,
      body: oversizedThumb.body,
      contentType: `multipart/form-data; boundary=${oversizedThumb.boundary}`,
    }),
    (error) => error.status === 422 && error.details?.maxEdge === 600,
  );
});

test('schemaVersion is required and must equal 1', () => {
  const missing = makeBoard();
  delete missing.schemaVersion;
  assert.ok(validateBoard(missing).errors.some(
    (error) => error.path === 'schemaVersion' && error.code === 'required',
  ));

  const wrong = makeBoard();
  wrong.schemaVersion = 2;
  assert.ok(validateBoard(wrong).errors.some(
    (error) => error.path === 'schemaVersion' && error.code === 'enum',
  ));
});

test('schema enforces global photo IDs and safe extension/MIME consistency', () => {
  const board = makeBoard();
  board.schedule.push({
    id: 'course-1',
    childId: 'xiaoyue',
    weekday: 1,
    title: 'Course',
    startTime: '08:00',
    endTime: '09:00',
    location: '',
    note: '',
    photos: [photo('photo-shared')],
  });
  board.tasks.push({
    id: 'task-1',
    title: 'Task',
    relatedTo: 'family',
    dueDate: '2026-08-31',
    status: 'not_started',
    completedAt: null,
    note: '',
    photos: [
      photo('photo-shared'),
      photo('photo-wrong-mime', 'png', 'image/jpeg'),
      {
        ...photo('photo-bad-thumb'),
        thumbnail: 'media/thumb/photo-bad-thumb.gif',
      },
    ],
  });

  const result = validateBoard(board);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(
    (error) => error.path === 'tasks[0].photos[0].id' && error.code === 'duplicate',
  ));
  assert.ok(result.errors.some(
    (error) => error.path === 'tasks[0].photos[1].src' && error.code === 'consistency',
  ));
  assert.ok(result.errors.some(
    (error) => error.path === 'tasks[0].photos[2].thumbnail' && error.code === 'format',
  ));

  const valid = makeBoard();
  valid.tasks.push({
    id: 'task-safe-photo',
    title: 'Safe photo',
    relatedTo: 'family',
    dueDate: '2026-08-31',
    status: 'not_started',
    completedAt: null,
    note: '',
    photos: [photo('photo-safe-jpeg', 'jpeg', 'image/jpeg')],
  });
  assert.deepEqual(validateBoard(valid), { ok: true, errors: [] });
});
