// Shrinks photos in the browser before upload: phone photos are often 3–8 MB,
// but nothing on the site is shown wider than ~1600px. Smaller files upload
// faster on mobile data and load faster for every shopper.

/** Longest side, in pixels, for product and shop photos. */
export const MAX_IMAGE_DIMENSION = 1600;
/** Profile pictures and logos are shown small. */
export const AVATAR_MAX_DIMENSION = 640;
const JPEG_QUALITY = 0.85;
/** Files already this small are uploaded as they are. */
const SKIP_BELOW_BYTES = 300 * 1024;
/** Formats we can safely redraw; GIFs (animation) and SVGs are left alone. */
const COMPRESSIBLE = /^image\/(jpeg|png|webp|heic|heif)$/i;

interface CompressOptions {
  maxDimension?: number;
  quality?: number;
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ("createImageBitmap" in window) {
    try {
      // Respects the photo's rotation (EXIF), so portraits stay upright.
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to <img> (e.g. HEIC on Safari decodes there).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function hasTransparency(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4 * 16) if (data[i] < 255) return true;
  return false;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Returns a smaller copy of an image file (JPEG, or WebP when it has
 * transparency). Returns the original if it's already small, not a photo,
 * or if the browser can't process it — uploads never fail because of this.
 */
export async function compressImage(file: File, options: CompressOptions = {}): Promise<File> {
  const maxDimension = options.maxDimension ?? MAX_IMAGE_DIMENSION;
  const quality = options.quality ?? JPEG_QUALITY;
  if (!COMPRESSIBLE.test(file.type)) return file;

  try {
    const image = await decode(file);
    const width = "naturalWidth" in image ? image.naturalWidth : image.width;
    const height = "naturalHeight" in image ? image.naturalHeight : image.height;
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    if (scale === 1 && file.size < SKIP_BELOW_BYTES) return file;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    if ("close" in image) image.close();

    const transparent = file.type !== "image/jpeg" && hasTransparency(ctx, canvas.width, canvas.height);
    const type = transparent ? "image/webp" : "image/jpeg";
    const blob = await toBlob(canvas, type, quality);
    if (!blob || blob.size >= file.size) return file;

    const ext = type === "image/webp" ? "webp" : "jpg";
    const name = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${name}.${ext}`, { type, lastModified: Date.now() });
  } catch (error) {
    console.warn("[compressImage] using original file", { name: file.name, type: file.type, error });
    return file;
  }
}
