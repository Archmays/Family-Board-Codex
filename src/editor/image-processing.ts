const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const FULL_MAX_EDGE = 1800;
const THUMB_MAX_EDGE = 480;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface ProcessedPhoto {
  full: Blob;
  thumbnail: Blob;
  width: number;
  height: number;
  mimeType: string;
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("浏览器未能生成处理后的照片"));
      }
    }, mimeType, quality);
  });
}

function scaledSize(width: number, height: number, maxEdge: number) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return { width, height };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function decodeImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ("createImageBitmap" in window) {
    return createImageBitmap(file, { imageOrientation: "from-image" });
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function renderToCanvas(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxEdge: number,
) {
  const size = scaledSize(sourceWidth, sourceHeight, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) {
    throw new Error("浏览器无法处理照片画布");
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, size.width, size.height);
  return canvas;
}

async function bestOutput(canvas: HTMLCanvasElement, quality: number) {
  const webp = await canvasToBlob(canvas, "image/webp", quality);
  if (webp.type === "image/webp" && webp.size > 0) {
    return webp;
  }
  return canvasToBlob(canvas, "image/jpeg", quality);
}

export async function processPhoto(file: File): Promise<ProcessedPhoto> {
  if (!ACCEPTED_TYPES.has(file.type)) {
    throw new Error(`${file.name || "所选文件"} 不是支持的 JPEG、PNG 或 WebP 图片`);
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(`${file.name || "所选图片"} 超过 25 MB，请先缩小后再添加`);
  }

  const decoded = await decodeImage(file);
  const sourceWidth = "naturalWidth" in decoded ? decoded.naturalWidth : decoded.width;
  const sourceHeight = "naturalHeight" in decoded ? decoded.naturalHeight : decoded.height;
  if (!sourceWidth || !sourceHeight) {
    if ("close" in decoded) decoded.close();
    throw new Error("无法读取图片尺寸");
  }

  try {
    const fullCanvas = renderToCanvas(decoded, sourceWidth, sourceHeight, FULL_MAX_EDGE);
    const thumbCanvas = renderToCanvas(decoded, sourceWidth, sourceHeight, THUMB_MAX_EDGE);
    const [full, thumbnail] = await Promise.all([
      bestOutput(fullCanvas, 0.86),
      bestOutput(thumbCanvas, 0.78),
    ]);
    return {
      full,
      thumbnail,
      width: fullCanvas.width,
      height: fullCanvas.height,
      mimeType: full.type || "image/webp",
    };
  } finally {
    if ("close" in decoded) decoded.close();
  }
}
