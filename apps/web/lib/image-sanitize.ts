/**
 * Minimal JPEG/PNG sanitiser for admin-uploaded showcase photos.
 *
 * There is no sharp/jimp in this project and a native image dependency is not
 * worth adding for a handful of gallery photos, so this does not re-encode or
 * resize. What it does do is refuse anything that is not really a JPEG or PNG,
 * and strip the metadata containers — a phone photo carries EXIF with GPS
 * coordinates, and publishing that on the homepage would leak where the
 * workshop is.
 *
 * Structural parsing, not pattern matching: every segment/chunk is walked and
 * re-emitted, so a file that does not parse cleanly is rejected rather than
 * partially copied.
 */

export type ImageKind = "jpg" | "png";

export interface SanitizedImage {
  kind: ImageKind;
  bytes: Buffer;
}

export class ImageRejected extends Error {}

const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
/** Standalone markers: no length field follows them. */
const JPEG_STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chunks worth keeping: structure, palette, transparency, and the colour
 *  information a viewer needs to render the image as intended. Everything else
 *  — tEXt/iTXt/eXIf/tIME and any private chunk — is metadata we drop. */
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "sBIT"]);

/** Identify and strip metadata from an uploaded image, or throw ImageRejected. */
export function sanitizeImage(input: Buffer): SanitizedImage {
  if (input.length >= 2 && input[0] === 0xff && input[1] === JPEG_SOI) {
    return { kind: "jpg", bytes: stripJpeg(input) };
  }
  if (input.length >= 8 && input.subarray(0, 8).equals(PNG_MAGIC)) {
    return { kind: "png", bytes: stripPng(input) };
  }
  throw new ImageRejected("Only JPEG and PNG photos are accepted");
}

/** Copy a JPEG marker by marker, dropping every APPn and COM segment. */
function stripJpeg(input: Buffer): Buffer {
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let i = 2;

  while (i + 1 < input.length) {
    if (input[i] !== 0xff) throw new ImageRejected("Malformed JPEG");
    // Fill bytes are legal padding before a marker.
    let marker = input[i + 1]!;
    let markerAt = i + 1;
    while (marker === 0xff && markerAt + 1 < input.length) {
      markerAt += 1;
      marker = input[markerAt]!;
    }
    if (marker === JPEG_EOI) {
      out.push(Buffer.from([0xff, 0xd9]));
      return Buffer.concat(out);
    }
    if (JPEG_STANDALONE.has(marker)) {
      out.push(Buffer.from([0xff, marker]));
      i = markerAt + 1;
      continue;
    }

    const lengthAt = markerAt + 1;
    if (lengthAt + 1 >= input.length) throw new ImageRejected("Truncated JPEG");
    const length = input.readUInt16BE(lengthAt);
    if (length < 2) throw new ImageRejected("Malformed JPEG segment");
    const segmentEnd = lengthAt + length;
    if (segmentEnd > input.length) throw new ImageRejected("Truncated JPEG segment");

    // APP0..APP15 (0xe0-0xef) and COM (0xfe) hold EXIF, XMP, ICC, thumbnails
    // and free text. None of it is needed to display the photo.
    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) {
      out.push(Buffer.from([0xff, marker]), input.subarray(lengthAt, segmentEnd));
    }

    if (marker === JPEG_SOS) {
      // Entropy-coded scan data runs to the end; it contains no metadata and
      // cannot be walked marker by marker, so copy the remainder verbatim.
      out.push(input.subarray(segmentEnd));
      return Buffer.concat(out);
    }
    i = segmentEnd;
  }
  throw new ImageRejected("Truncated JPEG");
}

/** Copy a PNG chunk by chunk, keeping only the rendering-critical ones. */
function stripPng(input: Buffer): Buffer {
  const out: Buffer[] = [PNG_MAGIC];
  let i = 8;
  let sawIhdr = false;
  let sawIdat = false;

  while (i + 8 <= input.length) {
    const length = input.readUInt32BE(i);
    // Chunk length is a 31-bit value by spec; the CRC adds four more bytes.
    if (length > 0x7fffffff) throw new ImageRejected("Malformed PNG chunk");
    const type = input.subarray(i + 4, i + 8).toString("latin1");
    const end = i + 12 + length;
    if (end > input.length) throw new ImageRejected("Truncated PNG chunk");

    if (type === "IHDR") sawIhdr = true;
    if (type === "IDAT") sawIdat = true;
    if (PNG_KEEP.has(type)) out.push(input.subarray(i, end));

    i = end;
    if (type === "IEND") {
      if (!sawIhdr || !sawIdat) throw new ImageRejected("Malformed PNG");
      return Buffer.concat(out);
    }
  }
  throw new ImageRejected("Truncated PNG");
}
