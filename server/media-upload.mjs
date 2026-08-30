import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

import { AppError } from './errors.mjs';

export const MEDIA_LIMITS = Object.freeze({
  fullBytes: 15 * 1024 * 1024,
  thumbnailBytes: 3 * 1024 * 1024,
  requestBytes: 19 * 1024 * 1024,
  fullMaxEdge: 2_000,
  thumbnailMaxEdge: 600,
});

const MIME_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);
const GENERATED_PHOTO_ID_PATTERN = /^photo-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATED_MEDIA_PATH_PATTERN = /^media\/(full|thumb)\/(photo-[0-9a-f-]+)(-thumb)?\.(jpg|png|webp)$/i;

function multipartError(message, status = 422, details) {
  return new AppError(message, {
    status,
    code: status === 413 ? 'media_too_large' : 'invalid_media_upload',
    details,
  });
}

function parseContentDisposition(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const typeMatch = /^form-data(?:;|$)/i.exec(value.trim());
  if (!typeMatch) {
    return null;
  }

  const parameters = {};
  const parameterPattern = /;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)=(?:"((?:\\.|[^"])*)"|([^;\s]*))/g;
  let match;
  while ((match = parameterPattern.exec(value)) !== null) {
    parameters[match[1].toLowerCase()] = match[2] === undefined
      ? match[3]
      : match[2].replace(/\\(["\\])/g, '$1');
  }

  return parameters;
}

function parsePartHeaders(headerBytes) {
  if (headerBytes.length > 16 * 1024) {
    throw multipartError('Multipart part headers are too large.');
  }

  const headers = new Map();
  const headerText = headerBytes.toString('latin1');
  for (const line of headerText.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw multipartError('Malformed multipart part header.');
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(name, value);
  }
  return headers;
}

/** Parse the small, client-processed upload entirely in memory under a hard cap. */
export function parseMultipartForm(body, contentType) {
  const boundaryMatch = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) {
    throw multipartError('Missing or invalid multipart boundary.', 400);
  }

  const delimiter = Buffer.from(`--${boundary}`, 'ascii');
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`, 'ascii');
  const headerSeparator = Buffer.from('\r\n\r\n', 'ascii');
  const parts = [];
  let cursor = 0;

  while (cursor < body.length) {
    if (!body.subarray(cursor, cursor + delimiter.length).equals(delimiter)) {
      throw multipartError('Malformed multipart body.', 400);
    }
    cursor += delimiter.length;

    if (body.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) {
      cursor += 2;
      if (cursor < body.length && !body.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) {
        throw multipartError('Malformed multipart closing boundary.', 400);
      }
      break;
    }

    if (!body.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) {
      throw multipartError('Malformed multipart boundary.', 400);
    }
    cursor += 2;

    const headersEnd = body.indexOf(headerSeparator, cursor);
    if (headersEnd < 0) {
      throw multipartError('Multipart part is missing a header terminator.', 400);
    }
    const headers = parsePartHeaders(body.subarray(cursor, headersEnd));
    const contentStart = headersEnd + headerSeparator.length;
    const boundaryStart = body.indexOf(nextDelimiter, contentStart);
    if (boundaryStart < 0) {
      throw multipartError('Multipart part is missing its closing boundary.', 400);
    }

    const disposition = parseContentDisposition(headers.get('content-disposition'));
    if (!disposition?.name) {
      throw multipartError('Multipart part is missing a field name.', 400);
    }

    parts.push({
      name: disposition.name,
      filename: disposition.filename,
      contentType: headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '',
      data: body.subarray(contentStart, boundaryStart),
    });
    if (parts.length > 12) {
      throw multipartError('Multipart upload contains too many fields.');
    }

    cursor = boundaryStart + 2;
  }

  return parts;
}

function detectImageType(bytes) {
  if (bytes.length >= 4
      && bytes[0] === 0xff
      && bytes[1] === 0xd8
      && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (bytes.length >= 12
      && bytes.toString('ascii', 0, 4) === 'RIFF'
      && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length >= pngSignature.length && bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    return 'image/png';
  }

  return null;
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_TEXT_OR_METADATA_CHUNKS = new Set(['eXIf', 'iTXt', 'tEXt', 'zTXt']);
const PNG_CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const PNG_CHANNELS = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);
const PNG_BIT_DEPTHS = new Map([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function invalidImage(message, details) {
  throw multipartError(message, 422, details);
}

function pngCrc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc = PNG_CRC_TABLE[(crc ^ bytes[offset]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectJpeg(bytes) {
  let cursor = 2;
  let pendingMarker = null;
  let width = null;
  let height = null;
  let sawScan = false;
  let sawEnd = false;

  while (cursor < bytes.length || pendingMarker !== null) {
    let marker;
    if (pendingMarker !== null) {
      marker = pendingMarker;
      pendingMarker = null;
    } else {
      if (bytes[cursor] !== 0xff) {
        invalidImage('JPEG contains data outside a marker or scan.');
      }
      while (cursor < bytes.length && bytes[cursor] === 0xff) {
        cursor += 1;
      }
      if (cursor >= bytes.length) {
        invalidImage('JPEG ends inside a marker.');
      }
      marker = bytes[cursor];
      cursor += 1;
    }

    if (marker === 0xd9) {
      sawEnd = true;
      if (cursor !== bytes.length) {
        invalidImage('JPEG contains trailing bytes after EOI.');
      }
      break;
    }

    if (marker === 0x00
        || marker === 0xd8
        || marker === 0x01
        || (marker >= 0xd0 && marker <= 0xd7)) {
      invalidImage('JPEG contains an unexpected standalone marker.');
    }

    if (cursor + 2 > bytes.length) {
      invalidImage('JPEG segment length is truncated.');
    }
    const segmentLength = bytes.readUInt16BE(cursor);
    if (segmentLength < 2 || cursor + segmentLength > bytes.length) {
      invalidImage('JPEG segment is malformed or truncated.');
    }
    const payloadStart = cursor + 2;
    const payloadEnd = cursor + segmentLength;
    const payload = bytes.subarray(payloadStart, payloadEnd);

    // EXIF (including GPS IFD) and XMP use APP1. Photoshop APP13 and comments
    // are metadata-bearing too, so client-processed uploads must not retain them.
    if (marker === 0xe1 || marker === 0xed || marker === 0xfe) {
      invalidImage('JPEG metadata (EXIF, XMP, GPS, Photoshop, or comment) is not permitted.');
    }

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 11) {
        invalidImage('JPEG SOF segment is too short.');
      }
      const componentCount = payload[5];
      if (componentCount < 1 || segmentLength !== 8 + (3 * componentCount)) {
        invalidImage('JPEG SOF component table is malformed.');
      }
      const nextHeight = payload.readUInt16BE(1);
      const nextWidth = payload.readUInt16BE(3);
      if (nextWidth < 1 || nextHeight < 1) {
        invalidImage('JPEG dimensions must be positive.');
      }
      if ((width !== null && width !== nextWidth) || (height !== null && height !== nextHeight)) {
        invalidImage('JPEG contains conflicting frame dimensions.');
      }
      width = nextWidth;
      height = nextHeight;
    }

    cursor = payloadEnd;
    if (marker !== 0xda) {
      continue;
    }

    const scanComponentCount = payload[0];
    if (scanComponentCount < 1 || segmentLength !== 6 + (2 * scanComponentCount)) {
      invalidImage('JPEG SOS component table is malformed.');
    }
    sawScan = true;
    let entropyBytes = 0;

    while (cursor < bytes.length) {
      if (bytes[cursor] !== 0xff) {
        entropyBytes += 1;
        cursor += 1;
        continue;
      }

      cursor += 1;
      while (cursor < bytes.length && bytes[cursor] === 0xff) {
        cursor += 1;
      }
      if (cursor >= bytes.length) {
        invalidImage('JPEG scan is truncated.');
      }

      const scanMarker = bytes[cursor];
      cursor += 1;
      if (scanMarker === 0x00) {
        entropyBytes += 1;
        continue;
      }
      if (scanMarker >= 0xd0 && scanMarker <= 0xd7) {
        continue;
      }
      if (entropyBytes === 0) {
        invalidImage('JPEG scan contains no entropy-coded data.');
      }
      pendingMarker = scanMarker;
      break;
    }

    if (pendingMarker === null) {
      invalidImage('JPEG scan is missing EOI.');
    }
  }

  if (width === null || height === null || !sawScan || !sawEnd) {
    invalidImage('JPEG is missing a frame, scan, or EOI marker.');
  }
  return { mimeType: 'image/jpeg', width, height };
}

function pngPassSize(size, start, step) {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

function expectedPngScanlines(width, height, bitsPerPixel, interlace) {
  const passes = interlace === 0
    ? [[0, 0, 1, 1]]
    : [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ];
  const rows = [];
  let byteLength = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = pngPassSize(width, startX, stepX);
    const passHeight = pngPassSize(height, startY, stepY);
    if (passWidth === 0 || passHeight === 0) {
      continue;
    }
    const rowLength = 1 + Math.ceil((passWidth * bitsPerPixel) / 8);
    rows.push({ count: passHeight, rowLength });
    byteLength += passHeight * rowLength;
  }
  return { rows, byteLength };
}

function inspectPng(bytes) {
  let cursor = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let width = null;
  let height = null;
  let bitDepth = null;
  let colorType = null;
  let interlace = null;
  let sawPalette = false;
  let sawData = false;
  let dataEnded = false;
  let sawEnd = false;
  const imageData = [];

  while (cursor < bytes.length) {
    chunkCount += 1;
    if (chunkCount > 10_000 || cursor + 12 > bytes.length) {
      invalidImage('PNG chunk table is malformed or truncated.');
    }
    const chunkLength = bytes.readUInt32BE(cursor);
    const typeStart = cursor + 4;
    const typeEnd = typeStart + 4;
    const type = bytes.toString('ascii', typeStart, typeEnd);
    if (!/^[A-Za-z]{4}$/.test(type) || /[a-z]/.test(type[2])) {
      invalidImage('PNG contains an invalid chunk type.');
    }
    const dataStart = typeEnd;
    const dataEnd = dataStart + chunkLength;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) {
      invalidImage('PNG chunk is truncated.');
    }
    if (pngCrc32(bytes, typeStart, dataEnd) !== bytes.readUInt32BE(dataEnd)) {
      invalidImage(`PNG ${type} chunk has an invalid CRC.`);
    }
    const data = bytes.subarray(dataStart, dataEnd);

    if (chunkCount === 1 && type !== 'IHDR') {
      invalidImage('PNG must begin with IHDR.');
    }
    if (PNG_TEXT_OR_METADATA_CHUNKS.has(type)) {
      invalidImage('PNG text, EXIF, XMP, or GPS metadata is not permitted.');
    }
    if (type[0] === type[0].toUpperCase() && !PNG_CRITICAL_CHUNKS.has(type)) {
      invalidImage(`PNG contains unsupported critical chunk ${type}.`);
    }

    if (type === 'IHDR') {
      if (chunkCount !== 1 || chunkLength !== 13 || width !== null) {
        invalidImage('PNG IHDR is malformed or duplicated.');
      }
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      if (width < 1 || height < 1
          || !PNG_BIT_DEPTHS.get(colorType)?.has(bitDepth)
          || data[10] !== 0
          || data[11] !== 0
          || (interlace !== 0 && interlace !== 1)) {
        invalidImage('PNG IHDR contains invalid dimensions or format fields.');
      }
    } else if (type === 'PLTE') {
      if (sawPalette || sawData || chunkLength < 3 || chunkLength > 768 || chunkLength % 3 !== 0
          || colorType === 0 || colorType === 4) {
        invalidImage('PNG PLTE chunk is invalid or out of order.');
      }
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (colorType === 3 && !sawPalette)) {
        invalidImage('PNG IDAT chunks are invalid or out of order.');
      }
      sawData = true;
      imageData.push(data);
    } else if (sawData && type !== 'IEND') {
      dataEnded = true;
    }

    cursor = chunkEnd;
    if (type === 'IEND') {
      if (chunkLength !== 0 || !sawData || cursor !== bytes.length) {
        invalidImage('PNG IEND is invalid or not the final chunk.');
      }
      sawEnd = true;
      break;
    }
  }

  if (width === null || height === null || !sawEnd) {
    invalidImage('PNG is missing IHDR, IDAT, or IEND.');
  }

  let scanlines;
  try {
    scanlines = inflateSync(Buffer.concat(imageData), { maxOutputLength: 40 * 1024 * 1024 });
  } catch {
    invalidImage('PNG IDAT data is malformed or exceeds the decoded size limit.');
  }
  const bitsPerPixel = PNG_CHANNELS.get(colorType) * bitDepth;
  const expected = expectedPngScanlines(width, height, bitsPerPixel, interlace);
  if (scanlines.length !== expected.byteLength) {
    invalidImage('PNG decoded scanline length does not match IHDR dimensions.');
  }
  let scanlineOffset = 0;
  for (const rowGroup of expected.rows) {
    for (let row = 0; row < rowGroup.count; row += 1) {
      if (scanlines[scanlineOffset] > 4) {
        invalidImage('PNG contains an invalid scanline filter.');
      }
      scanlineOffset += rowGroup.rowLength;
    }
  }

  return { mimeType: 'image/png', width, height };
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function inspectWebp(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(4) !== bytes.length - 8) {
    invalidImage('WebP RIFF size is malformed or truncated.');
  }

  let cursor = 12;
  let width = null;
  let height = null;
  let canvasWidth = null;
  let canvasHeight = null;
  let sawExtendedHeader = false;
  let extendedFlags = 0;
  let sawIccProfile = false;
  let sawAlphaChunk = false;
  let alphaCompression = null;
  let alphaPayloadLength = null;
  let imageCodec = null;
  let imageChunks = 0;
  let chunkCount = 0;
  let previousType = null;

  while (cursor < bytes.length) {
    chunkCount += 1;
    if (chunkCount > 10_000) {
      invalidImage('WebP contains too many chunks.');
    }
    if (cursor + 8 > bytes.length) {
      invalidImage('WebP chunk header is truncated.');
    }
    const type = bytes.toString('ascii', cursor, cursor + 4);
    if (!/^[\x20-\x7e]{4}$/.test(type)) {
      invalidImage('WebP contains an invalid chunk type.');
    }
    const chunkLength = bytes.readUInt32LE(cursor + 4);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + chunkLength;
    const paddedEnd = dataEnd + (chunkLength & 1);
    if (!Number.isSafeInteger(paddedEnd) || paddedEnd > bytes.length) {
      invalidImage(`WebP ${type} chunk is truncated.`);
    }
    if ((chunkLength & 1) !== 0 && bytes[dataEnd] !== 0) {
      invalidImage(`WebP ${type} chunk has invalid padding.`);
    }
    const data = bytes.subarray(dataStart, dataEnd);

    if (previousType === 'ALPH' && type !== 'VP8 ') {
      invalidImage('WebP ALPH must be immediately followed by a VP8 image chunk.');
    }

    if (type === 'EXIF' || type === 'XMP ' || type.trim().toUpperCase() === 'GPS') {
      invalidImage('WebP EXIF, XMP, or GPS metadata is not permitted.');
    }

    if (type === 'VP8X') {
      if (sawExtendedHeader || cursor !== 12 || chunkLength !== 10) {
        invalidImage('WebP VP8X chunk is malformed or out of order.');
      }
      sawExtendedHeader = true;
      const flags = data[0];
      extendedFlags = flags;
      if ((flags & 0xc9) !== 0 || (flags & 0x0c) !== 0) {
        invalidImage('WebP VP8X uses reserved bits or declares EXIF/XMP metadata.');
      }
      if ((flags & 0x02) !== 0) {
        invalidImage('Animated WebP uploads are not supported.');
      }
      if (data[1] !== 0 || data[2] !== 0 || data[3] !== 0) {
        invalidImage('WebP VP8X reserved bytes must be zero.');
      }
      canvasWidth = 1 + readUInt24LE(data, 4);
      canvasHeight = 1 + readUInt24LE(data, 7);
    } else if (type === 'VP8 ') {
      if (chunkLength < 10 || (data[0] & 1) !== 0
          || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) {
        invalidImage('WebP VP8 key-frame header is malformed.');
      }
      const frameTag = data[0] | (data[1] << 8) | (data[2] << 16);
      const firstPartitionLength = frameTag >>> 5;
      if ((frameTag & 0x10) === 0
          || firstPartitionLength < 1
          || 10 + firstPartitionLength > chunkLength) {
        invalidImage('WebP VP8 frame partition is malformed or truncated.');
      }
      const nextWidth = data.readUInt16LE(6) & 0x3fff;
      const nextHeight = data.readUInt16LE(8) & 0x3fff;
      if (nextWidth < 1 || nextHeight < 1 || imageChunks > 0) {
        invalidImage('WebP contains invalid or multiple image bitstreams.');
      }
      width = nextWidth;
      height = nextHeight;
      imageCodec = 'VP8 ';
      imageChunks += 1;
    } else if (type === 'VP8L') {
      if (chunkLength < 6 || data[0] !== 0x2f) {
        invalidImage('WebP VP8L header is malformed.');
      }
      const dimensions = data.readUInt32LE(1);
      if ((dimensions >>> 29) !== 0 || imageChunks > 0) {
        invalidImage('WebP VP8L version or image bitstream count is invalid.');
      }
      width = 1 + (dimensions & 0x3fff);
      height = 1 + ((dimensions >>> 14) & 0x3fff);
      imageCodec = 'VP8L';
      imageChunks += 1;
      if (sawAlphaChunk) {
        invalidImage('WebP ALPH cannot be combined with a VP8L image chunk.');
      }
    } else if (type === 'ICCP') {
      if (!sawExtendedHeader || sawIccProfile || imageChunks > 0 || chunkLength === 0) {
        invalidImage('WebP ICCP chunk is duplicated, empty, or out of order.');
      }
      sawIccProfile = true;
    } else if (type === 'ALPH') {
      if (!sawExtendedHeader || sawAlphaChunk || imageChunks > 0
          || chunkLength < 2 || (data[0] & 0xe2) !== 0) {
        invalidImage('WebP ALPH chunk is malformed, duplicated, or out of order.');
      }
      sawAlphaChunk = true;
      alphaCompression = data[0] & 0x03;
      alphaPayloadLength = chunkLength - 1;
    } else {
      invalidImage(`WebP contains unsupported chunk ${type}.`);
    }

    previousType = type;
    cursor = paddedEnd;
  }

  if (cursor !== bytes.length || imageChunks !== 1 || width === null || height === null) {
    invalidImage('WebP is missing one complete image bitstream.');
  }
  if (sawExtendedHeader && (canvasWidth !== width || canvasHeight !== height)) {
    invalidImage('WebP canvas dimensions do not match its image bitstream.');
  }
  if (sawAlphaChunk && alphaCompression === 0 && alphaPayloadLength !== width * height) {
    invalidImage('WebP raw alpha payload length does not match its image dimensions.');
  }
  if (sawExtendedHeader) {
    const declaresIccProfile = (extendedFlags & 0x20) !== 0;
    const declaresAlpha = (extendedFlags & 0x10) !== 0;
    if (declaresIccProfile !== sawIccProfile
        || (imageCodec === 'VP8 ' && declaresAlpha !== sawAlphaChunk)) {
      invalidImage('WebP VP8X feature flags do not match its chunks or image header.');
    }
  } else if (sawIccProfile || sawAlphaChunk) {
    invalidImage('WebP auxiliary chunks require a VP8X header.');
  }
  return { mimeType: 'image/webp', width, height };
}

function inspectImage(bytes) {
  const mimeType = detectImageType(bytes);
  if (mimeType === 'image/jpeg') {
    return inspectJpeg(bytes);
  }
  if (mimeType === 'image/png') {
    return inspectPng(bytes);
  }
  if (mimeType === 'image/webp') {
    return inspectWebp(bytes);
  }
  invalidImage('File must contain a valid JPEG, PNG, or WebP image.');
}

function enforceImageLimits(image, label, maxEdge) {
  if (Math.max(image.width, image.height) > maxEdge) {
    invalidImage(`${label} dimensions must not exceed ${maxEdge}px on either edge.`, {
      width: image.width,
      height: image.height,
      maxEdge,
    });
  }
}

function singlePart(parts, name, { file = false } = {}) {
  const matches = parts.filter((part) => part.name === name);
  if (matches.length !== 1) {
    throw multipartError(`Multipart field "${name}" must appear exactly once.`);
  }
  if (file && matches[0].filename === undefined) {
    throw multipartError(`Multipart field "${name}" must be a file.`);
  }
  if (!file && matches[0].filename !== undefined) {
    throw multipartError(`Multipart field "${name}" must be text.`);
  }
  return matches[0];
}

function decodeTextField(part, name, maxBytes) {
  if (part.data.length > maxBytes) {
    throw multipartError(`Multipart field "${name}" is too large.`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(part.data);
  } catch {
    throw multipartError(`Multipart field "${name}" is not valid UTF-8.`);
  }
}

function validateDimension(value, name) {
  if (!/^[1-9]\d{0,4}$/.test(value)) {
    throw multipartError(`${name} must be a positive integer.`);
  }
  const dimension = Number(value);
  if (dimension > 20_000) {
    throw multipartError(`${name} must not exceed 20000.`);
  }
  return dimension;
}

async function writeUniqueFile(filePath, bytes) {
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function storeMediaUpload({ projectRoot, body, contentType }) {
  if (!Buffer.isBuffer(body)) {
    throw multipartError('Media request body is invalid.', 400);
  }
  if (body.length > MEDIA_LIMITS.requestBytes) {
    throw multipartError('Media upload exceeds the request size limit.', 413);
  }

  const parts = parseMultipartForm(body, contentType);
  const allowedNames = new Set(['full', 'thumbnail', 'width', 'height', 'mimeType', 'caption']);
  const unexpected = parts.find((part) => !allowedNames.has(part.name));
  if (unexpected) {
    throw multipartError(`Unexpected multipart field "${unexpected.name}".`);
  }

  const full = singlePart(parts, 'full', { file: true });
  const thumbnail = singlePart(parts, 'thumbnail', { file: true });
  const widthText = decodeTextField(singlePart(parts, 'width'), 'width', 20);
  const heightText = decodeTextField(singlePart(parts, 'height'), 'height', 20);
  const declaredMimeType = decodeTextField(singlePart(parts, 'mimeType'), 'mimeType', 100).trim().toLowerCase();
  const caption = decodeTextField(singlePart(parts, 'caption'), 'caption', 2_000);

  if (caption.length > 500) {
    throw multipartError('caption must be at most 500 characters.');
  }
  if (full.data.length === 0 || full.data.length > MEDIA_LIMITS.fullBytes) {
    throw multipartError('Full image is empty or exceeds 15 MiB.', full.data.length > MEDIA_LIMITS.fullBytes ? 413 : 422);
  }
  if (thumbnail.data.length === 0 || thumbnail.data.length > MEDIA_LIMITS.thumbnailBytes) {
    throw multipartError('Thumbnail is empty or exceeds 3 MiB.', thumbnail.data.length > MEDIA_LIMITS.thumbnailBytes ? 413 : 422);
  }

  const fullImage = inspectImage(full.data);
  const thumbnailImage = inspectImage(thumbnail.data);
  const fullMimeType = fullImage.mimeType;
  const thumbnailMimeType = thumbnailImage.mimeType;
  enforceImageLimits(fullImage, 'Full image', MEDIA_LIMITS.fullMaxEdge);
  enforceImageLimits(thumbnailImage, 'Thumbnail', MEDIA_LIMITS.thumbnailMaxEdge);
  if (declaredMimeType !== fullMimeType) {
    throw multipartError('mimeType does not match the full image structure.');
  }
  if (full.contentType && full.contentType !== 'application/octet-stream' && full.contentType !== fullMimeType) {
    throw multipartError('Full image Content-Type does not match its signature.');
  }
  if (thumbnail.contentType
      && thumbnail.contentType !== 'application/octet-stream'
      && thumbnail.contentType !== thumbnailMimeType) {
    throw multipartError('Thumbnail Content-Type does not match its signature.');
  }

  const width = validateDimension(widthText.trim(), 'width');
  const height = validateDimension(heightText.trim(), 'height');
  if (width !== fullImage.width || height !== fullImage.height) {
    throw multipartError('Declared width and height do not match the full image dimensions.', 422, {
      declared: { width, height },
      actual: { width: fullImage.width, height: fullImage.height },
    });
  }
  const id = `photo-${randomUUID()}`;
  const fullFilename = `${id}.${MIME_EXTENSIONS.get(fullMimeType)}`;
  const thumbnailFilename = `${id}-thumb.${MIME_EXTENSIONS.get(thumbnailMimeType)}`;
  const fullDirectory = path.resolve(projectRoot, 'media', 'full');
  const thumbnailDirectory = path.resolve(projectRoot, 'media', 'thumb');
  const fullPath = path.join(fullDirectory, fullFilename);
  const thumbnailPath = path.join(thumbnailDirectory, thumbnailFilename);

  await Promise.all([
    mkdir(fullDirectory, { recursive: true }),
    mkdir(thumbnailDirectory, { recursive: true }),
  ]);

  try {
    await writeUniqueFile(fullPath, full.data);
    await writeUniqueFile(thumbnailPath, thumbnail.data);
  } catch (error) {
    await Promise.allSettled([
      rm(fullPath, { force: true }),
      rm(thumbnailPath, { force: true }),
    ]);
    throw error;
  }

  return {
    photo: {
      id,
      src: `media/full/${fullFilename}`,
      thumbnail: `media/thumb/${thumbnailFilename}`,
      caption,
      width,
      height,
      mimeType: fullMimeType,
    },
  };
}

/** Remove only a complete server-generated upload that the client could not attach. */
export async function discardMediaUpload({ projectRoot, photo }) {
  if (photo === null || typeof photo !== 'object' || Array.isArray(photo)
      || typeof photo.id !== 'string' || !GENERATED_PHOTO_ID_PATTERN.test(photo.id)
      || typeof photo.src !== 'string' || typeof photo.thumbnail !== 'string') {
    throw multipartError('Uploaded photo reference is invalid.', 400);
  }

  const fullMatch = GENERATED_MEDIA_PATH_PATTERN.exec(photo.src);
  const thumbMatch = GENERATED_MEDIA_PATH_PATTERN.exec(photo.thumbnail);
  if (!fullMatch || fullMatch[1] !== 'full' || fullMatch[2] !== photo.id || fullMatch[3]
      || !thumbMatch || thumbMatch[1] !== 'thumb' || thumbMatch[2] !== photo.id || thumbMatch[3] !== '-thumb') {
    throw multipartError('Uploaded photo paths do not match the generated photo ID.', 400);
  }

  const resolvedRoot = path.resolve(projectRoot);
  const fullPath = path.join(resolvedRoot, ...photo.src.split('/'));
  const thumbnailPath = path.join(resolvedRoot, ...photo.thumbnail.split('/'));
  await Promise.all([
    rm(fullPath, { force: true }),
    rm(thumbnailPath, { force: true }),
  ]);
  return { discarded: true };
}

export { detectImageType, inspectImage };
