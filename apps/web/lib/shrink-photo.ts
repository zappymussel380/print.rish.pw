/**
 * Shrink a showcase photo in the admin's browser before it is uploaded.
 *
 * Phone photos arrive at 1440×2560 and 250–600 KB, while the homepage grid
 * shows them at most 800 CSS px wide — six of them outweighed all of the
 * site's JavaScript. The server has no image library on purpose (see
 * lib/image-sanitize.ts), so the browser, which already decodes the photo for
 * its preview, does the resize.
 *
 * Re-encoding also bakes the camera's rotation into the pixels. The server
 * strips EXIF (and with it the orientation tag), so a JPEG kept as-is could
 * show up sideways.
 */

/** Longest side stored: 800 CSS px on a 2× screen, and enough for the lightbox. */
export const SHOWCASE_MAX_EDGE_PX = 1600;
/** A PNG this small that already fits is kept as-is, transparency and all. */
export const KEEP_PNG_UNDER_BYTES = 1024 * 1024;
const JPEG_QUALITY = 0.82;

/** Scale (width, height) down to fit within maxEdge on the longest side. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Whether a photo must be re-encoded, or can be uploaded untouched. JPEGs
 *  always are, so their orientation is baked in. */
export function needsReencode(type: string, size: number, width: number, height: number): boolean {
  if (type !== "image/png") return true;
  return size > KEEP_PNG_UNDER_BYTES || Math.max(width, height) > SHOWCASE_MAX_EDGE_PX;
}

/** The photo to upload: a resized JPEG, or the original whenever the browser
 *  can't decode or encode it (the server's own checks still apply). */
export async function shrinkPhoto(file: File): Promise<File> {
  if (typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }
  try {
    if (!needsReencode(file.type, file.size, bitmap.width, bitmap.height)) return file;
    const { width, height } = fitWithin(bitmap.width, bitmap.height, SHOWCASE_MAX_EDGE_PX);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    // JPEG has no alpha: a transparent PNG gets white, not black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) return file;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}
