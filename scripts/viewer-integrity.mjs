import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectImage, MEDIA_LIMITS } from "../server/media-upload.mjs";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const PAGES_ROBOTS = "User-agent: *\nDisallow: /\n";

export const FORBIDDEN_VIEWER_PATTERNS = Object.freeze([
  // React's runtime contains generic attribute/event names. These patterns require
  // an assignment or use site so the framework itself does not create false positives.
  {
    label: "contenteditable",
    regex: /(?:contenteditable\s*(?::|=(?!=))|setAttribute\s*\(\s*["']contenteditable["'])/i,
  },
  { label: "editor entry", regex: /(?:src[\\/]editor[\\/]|editor[\\/]main\.(?:js|jsx|ts|tsx)|editor\.html)/i },
  { label: "local editor host", regex: /(?:127\.0\.0\.1|localhost)/i },
  { label: "local/write API", regex: /[\\/]api[\\/]/i },
  { label: "revision write token", regex: /\bbaseRevision\b/i },
  { label: "unsaved-change listener", regex: /\bbeforeunload\b/i },
  {
    label: "file upload",
    regex: /(?:new\s+FileReader\b|type\s*(?::|=(?!=))\s*["']file["']|setAttribute\s*\(\s*["']type["']\s*,\s*["']file["'])/i,
  },
  { label: "clipboard/drop upload", regex: /(?:(?:onPaste|onDrop|onDragOver)\s*(?:=|:)|addEventListener\s*\(\s*["'](?:paste|drop|dragover)["'])/i },
  { label: "write HTTP method", regex: /(?:method|type)\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i },
  { label: "Node file write", regex: /\b(?:writeFile|rename|copyFile|unlink)\b/i },
  { label: "save UI", regex: /(?:有未保存修改|正在保存|已保存到本地|已自动保存|保存失败)/ },
  { label: "publish UI", regex: /发布到家庭页面/ },
  { label: "mutation UI", regex: /(?:新增课程|复制课程|删除课程|删除事项|撤销删除)/ },
]);

function formatValidationError(error) {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const pathLabel = typeof error.path === "string" ? `${error.path}: ` : "";
    const message = typeof error.message === "string"
      ? error.message
      : JSON.stringify(error);
    return `${pathLabel}${message}`;
  }
  return String(error);
}

export function validateBoardOrThrow(board, validateBoard, label = "board data") {
  const result = validateBoard(board);
  if (!result || typeof result.ok !== "boolean" || !Array.isArray(result.errors)) {
    throw new Error("validateBoard returned an invalid result contract");
  }
  if (result.ok) {
    return board;
  }

  const details = result.errors.map(formatValidationError);
  throw new Error(
    `${label} has ${details.length} validation error${details.length === 1 ? "" : "s"}:\n` +
      details.map((detail) => `- ${detail}`).join("\n"),
  );
}

export async function readAndValidateBoard(filePath, validateBoard) {
  let board;
  try {
    board = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read JSON from ${filePath}: ${error.message}`);
  }
  return validateBoardOrThrow(board, validateBoard, filePath);
}

export function boardSummary(board) {
  const schedule = Array.isArray(board?.schedule) ? board.schedule : [];
  const tasks = Array.isArray(board?.tasks) ? board.tasks : [];
  const items = [...schedule, ...tasks];
  return {
    children: Array.isArray(board?.children) ? board.children.length : 0,
    schedule: schedule.length,
    tasks: tasks.length,
    completedAt: tasks.filter(
      (task) => typeof task?.completedAt === "string" && task.completedAt.length > 0,
    ).length,
    photos: items.reduce(
      (count, item) => count + (Array.isArray(item?.photos) ? item.photos.length : 0),
      0,
    ),
  };
}

function safeMediaFileName(fileName) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9]+)+$/.test(fileName);
}

export function assertSafeMediaReference(reference, field, context = "photo") {
  if (typeof reference !== "string" || reference.length === 0) {
    throw new Error(`${context}.${field} must be a non-empty string`);
  }
  if (reference.includes("\\") || reference.includes("\0")) {
    throw new Error(`${context}.${field} contains an unsafe path separator`);
  }

  const expectedFolder = field === "src" ? "full" : field === "thumbnail" ? "thumb" : null;
  if (!expectedFolder) {
    throw new Error(`${context}.${field} is not a supported photo path field`);
  }

  const segments = reference.split("/");
  if (
    segments.length !== 3 ||
    segments[0] !== "media" ||
    segments[1] !== expectedFolder ||
    path.posix.normalize(reference) !== reference ||
    !safeMediaFileName(segments[2])
  ) {
    throw new Error(
      `${context}.${field} must match media/${expectedFolder}/<safe-file>`,
    );
  }
  return reference;
}

export function collectMediaReferences(board) {
  const references = new Set();
  for (const collectionName of ["schedule", "tasks"]) {
    const collection = Array.isArray(board?.[collectionName]) ? board[collectionName] : [];
    collection.forEach((item, itemIndex) => {
      const photos = Array.isArray(item?.photos) ? item.photos : [];
      photos.forEach((photo, photoIndex) => {
        const context = `${collectionName}[${itemIndex}].photos[${photoIndex}]`;
        references.add(assertSafeMediaReference(photo?.src, "src", context));
        references.add(assertSafeMediaReference(photo?.thumbnail, "thumbnail", context));
      });
    });
  }
  return [...references].sort();
}

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function referenceToPath(rootPath, reference) {
  return path.resolve(rootPath, ...reference.split("/"));
}

async function assertRegularFile(filePath, label) {
  let entry;
  try {
    entry = await lstat(filePath);
  } catch (error) {
    throw new Error(`${label} is missing: ${filePath} (${error.message})`);
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a regular, non-symlink file: ${filePath}`);
  }
  return entry;
}

function mediaBindings(board) {
  const bindings = new Map();
  for (const collectionName of ["schedule", "tasks"]) {
    const collection = Array.isArray(board?.[collectionName]) ? board[collectionName] : [];
    collection.forEach((item, itemIndex) => {
      const photos = Array.isArray(item?.photos) ? item.photos : [];
      photos.forEach((photo, photoIndex) => {
        for (const field of ["src", "thumbnail"]) {
          const reference = photo?.[field];
          const list = bindings.get(reference) ?? [];
          list.push({
            field,
            photo,
            context: `${collectionName}[${itemIndex}].photos[${photoIndex}]`,
          });
          bindings.set(reference, list);
        }
      });
    });
  }
  return bindings;
}

const MEDIA_EXTENSIONS = new Map([
  ["image/jpeg", new Set([".jpg", ".jpeg"])],
  ["image/png", new Set([".png"])],
  ["image/webp", new Set([".webp"])],
]);

export async function assertReferencedMediaSources(repoRoot, references, board = null) {
  if (references.length === 0) {
    return;
  }

  const mediaRoot = path.join(repoRoot, "media");
  const [realRepoRoot, realMediaRoot] = await Promise.all([
    realpath(repoRoot),
    realpath(mediaRoot).catch((error) => {
      throw new Error(`local media directory is missing: ${mediaRoot} (${error.message})`);
    }),
  ]);
  if (!isWithin(realRepoRoot, realMediaRoot)) {
    throw new Error(`local media directory resolves outside the repository: ${mediaRoot}`);
  }

  const bindings = mediaBindings(board);
  for (const reference of references) {
    const sourcePath = referenceToPath(repoRoot, reference);
    if (!isWithin(mediaRoot, sourcePath)) {
      throw new Error(`unsafe media reference escapes media/: ${reference}`);
    }
    const entry = await assertRegularFile(sourcePath, `referenced media ${reference}`);
    const realSourcePath = await realpath(sourcePath);
    if (!isWithin(realMediaRoot, realSourcePath)) {
      throw new Error(`referenced media resolves outside media/: ${reference}`);
    }
    const isFull = reference.startsWith("media/full/");
    const byteLimit = isFull ? MEDIA_LIMITS.fullBytes : MEDIA_LIMITS.thumbnailBytes;
    const edgeLimit = isFull ? MEDIA_LIMITS.fullMaxEdge : MEDIA_LIMITS.thumbnailMaxEdge;
    if (entry.size > byteLimit) {
      throw new Error(`referenced media exceeds its byte limit: ${reference}`);
    }
    let image;
    try {
      image = inspectImage(await readFile(realSourcePath));
    } catch (error) {
      throw new Error(`referenced media is not a safe structural image: ${reference} (${error.message})`);
    }
    if (Math.max(image.width, image.height) > edgeLimit) {
      throw new Error(`referenced media exceeds its ${edgeLimit}px edge limit: ${reference}`);
    }
    const extension = path.posix.extname(reference).toLowerCase();
    if (!MEDIA_EXTENSIONS.get(image.mimeType)?.has(extension)) {
      throw new Error(`referenced media extension does not match its bytes: ${reference}`);
    }
    for (const binding of bindings.get(reference) ?? []) {
      if (binding.field === "src"
          && (binding.photo.mimeType !== image.mimeType
            || binding.photo.width !== image.width
            || binding.photo.height !== image.height)) {
        throw new Error(`${binding.context}.src metadata does not match its image bytes: ${reference}`);
      }
    }
  }
}

export async function copyReferencedMedia(repoRoot, docsDir, references) {
  for (const reference of references) {
    const sourcePath = referenceToPath(repoRoot, reference);
    const destinationPath = referenceToPath(docsDir, reference);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
}

export async function restorePagesControlFiles(docsDir) {
  await mkdir(docsDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(docsDir, ".nojekyll"), "", "utf8"),
    writeFile(path.join(docsDir, "robots.txt"), PAGES_ROBOTS, "utf8"),
  ]);
}

export async function writePublishedBoard(docsDir, board) {
  const dataDir = path.join(docsDir, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "board.json"),
    `${JSON.stringify(board, null, 2)}\n`,
    "utf8",
  );
}

export async function verifyViewerSourceEntry(repoRoot) {
  const sourceHtmlPath = path.join(repoRoot, "index.html");
  const sourceHtml = await readFile(sourceHtmlPath, "utf8");
  const sourceEntries = [...sourceHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1])
    .filter((reference) => /(?:^|\/)src\//.test(reference));
  const normalised = sourceEntries.map((reference) => reference.replace(/^\.\//, "/"));
  if (normalised.length !== 1 || normalised[0] !== "/src/viewer/main.tsx") {
    throw new Error(
      `viewer index must have exactly one /src/viewer/main.tsx entry; found ${JSON.stringify(sourceEntries)}`,
    );
  }
  const violations = scanForbiddenViewerText(sourceHtmlPath, sourceHtml);
  const sourceFiles = [
    ...(await listFilesRecursive(path.join(repoRoot, "src", "viewer"))),
    ...(await listFilesRecursive(path.join(repoRoot, "src", "shared"))),
  ].filter((filePath) => /\.(?:js|jsx|ts|tsx)$/i.test(filePath));
  for (const filePath of sourceFiles) {
    violations.push(
      ...scanForbiddenViewerText(
        relativePosix(repoRoot, filePath),
        await readFile(filePath, "utf8"),
      ),
    );
  }
  if (violations.length > 0) {
    throw new Error(`viewer source entry is unsafe:\n${violations.map((item) => `- ${item}`).join("\n")}`);
  }
}

export function scanForbiddenViewerText(filePath, text) {
  return FORBIDDEN_VIEWER_PATTERNS
    .filter(({ regex }) => regex.test(text))
    .map(({ label }) => `${filePath}: forbidden ${label} marker`);
}

export async function listFilesRecursive(rootPath) {
  const files = [];
  async function visit(currentPath) {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else {
        files.push(absolutePath);
      }
    }
  }
  await visit(rootPath);
  return files.sort();
}

function relativePosix(rootPath, filePath) {
  return path.relative(rootPath, filePath).split(path.sep).join("/");
}

export async function verifyHtmlAssetReferences(docsDir, html) {
  const references = [];
  const tagPattern = /<(?:script|link|img|source)\b[^>]*?\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi;
  for (const match of html.matchAll(tagPattern)) {
    const rawReference = match[2].trim();
    if (!rawReference || rawReference.startsWith("#") || rawReference.startsWith("data:")) {
      continue;
    }
    if (
      rawReference.startsWith("/") ||
      rawReference.startsWith("\\") ||
      rawReference.startsWith("//") ||
      /^[a-z][a-z0-9+.-]*:/i.test(rawReference)
    ) {
      throw new Error(`viewer HTML asset must use a relative path: ${rawReference}`);
    }

    const withoutSuffix = rawReference.split(/[?#]/, 1)[0];
    let decodedReference;
    try {
      decodedReference = decodeURIComponent(withoutSuffix);
    } catch (error) {
      throw new Error(`viewer HTML asset has invalid URL encoding: ${rawReference} (${error.message})`);
    }
    const assetPath = path.resolve(docsDir, ...decodedReference.split("/"));
    if (!isWithin(docsDir, assetPath)) {
      throw new Error(`viewer HTML asset escapes docs/: ${rawReference}`);
    }
    await assertRegularFile(assetPath, `viewer HTML asset ${rawReference}`);
    references.push(relativePosix(docsDir, assetPath));
  }

  if (!references.some((reference) => reference.endsWith(".js"))) {
    throw new Error("viewer HTML does not reference a JavaScript asset");
  }
  if (!references.some((reference) => reference.endsWith(".css"))) {
    throw new Error("viewer HTML does not reference a CSS asset");
  }
  return [...new Set(references)].sort();
}

export async function verifyViewerDirectory({ docsDir, validateBoard }) {
  const requiredFiles = [".nojekyll", "robots.txt", "index.html", "data/board.json"];
  for (const relativePath of requiredFiles) {
    await assertRegularFile(path.join(docsDir, ...relativePath.split("/")), `required viewer file ${relativePath}`);
  }

  const [html, robots, board] = await Promise.all([
    readFile(path.join(docsDir, "index.html"), "utf8"),
    readFile(path.join(docsDir, "robots.txt"), "utf8"),
    readAndValidateBoard(path.join(docsDir, "data", "board.json"), validateBoard),
  ]);
  const robotsMeta = /<meta\b[^>]*\bname=["']robots["'][^>]*\bcontent=["']([^"']*)["']/i.exec(html);
  const robotsDirectives = new Set(
    (robotsMeta?.[1] ?? "")
      .toLowerCase()
      .split(",")
      .map((directive) => directive.trim())
      .filter(Boolean),
  );
  for (const directive of ["noindex", "nofollow", "noarchive"]) {
    if (!robotsDirectives.has(directive)) {
      throw new Error(`viewer HTML robots meta tag is missing ${directive}`);
    }
  }
  if (!/^User-agent:\s*\*\s*$[\s\S]*^Disallow:\s*\/\s*$/im.test(robots)) {
    throw new Error("viewer robots.txt must disallow all crawlers");
  }

  const references = collectMediaReferences(board);
  const htmlAssets = await verifyHtmlAssetReferences(docsDir, html);
  await assertReferencedMediaSources(docsDir, references, board);

  const outputFiles = await listFilesRecursive(docsDir);
  const outputRelative = outputFiles.map((filePath) => relativePosix(docsDir, filePath));
  const referencedMedia = new Set(references);
  const unexpected = [];
  for (let index = 0; index < outputFiles.length; index += 1) {
    const absolutePath = outputFiles[index];
    const relativePath = outputRelative[index];
    const entry = await lstat(absolutePath);
    if (entry.isSymbolicLink()) {
      unexpected.push(`${relativePath} (symlink)`);
      continue;
    }
    if (/(?:^|\/)editor(?:[./-]|$)/i.test(relativePath) || /\.(?:map|ts|tsx|jsx)$/i.test(relativePath)) {
      unexpected.push(relativePath);
      continue;
    }
    if (relativePath.startsWith("media/")) {
      if (!referencedMedia.has(relativePath)) {
        unexpected.push(`${relativePath} (unreferenced media)`);
      }
      continue;
    }
    if (
      !requiredFiles.includes(relativePath) &&
      !relativePath.startsWith("assets/")
    ) {
      unexpected.push(relativePath);
    }
  }
  if (unexpected.length > 0) {
    throw new Error(`viewer output contains unexpected files:\n${unexpected.map((item) => `- ${item}`).join("\n")}`);
  }

  const scannedFiles = outputFiles.filter((filePath) => /\.(?:html|js)$/i.test(filePath));
  const forbidden = [];
  const javascriptTexts = [];
  for (const filePath of scannedFiles) {
    const fileText = await readFile(filePath, "utf8");
    if (/\.js$/i.test(filePath)) {
      javascriptTexts.push(fileText);
    }
    forbidden.push(
      ...scanForbiddenViewerText(
        relativePosix(docsDir, filePath),
        fileText,
      ),
    );
  }
  if (forbidden.length > 0) {
    throw new Error(`viewer contains forbidden edit capabilities:\n${forbidden.map((item) => `- ${item}`).join("\n")}`);
  }
  if (!javascriptTexts.some((text) => /data\/board\.json\?t=/.test(text)
      && /Date\.now\(\)/.test(text)
      && /no-store/.test(text))) {
    throw new Error("viewer bundle is missing board-data cache busting with cache: no-store");
  }

  return {
    files: outputFiles.length,
    assets: htmlAssets.length,
    media: references.length,
    board: boardSummary(board),
  };
}
