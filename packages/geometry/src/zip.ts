import { Unzip, UnzipInflate } from "fflate";
import { ModelParseError } from "./types";

/** Decompressed-size ceiling for any single entry we extract from an
 *  uploaded container (3MF / zipped AMF). Keeps zip bombs from exhausting
 *  memory: the input file itself is already capped by the upload limit
 *  (300 MiB), and the only entries we ever extract are model XML - anything
 *  expanding past this is hostile or unparseable in reasonable time anyway
 *  (it would blow the XML parser's own MAX_XML_BYTES cap next). */
export const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 1024;

export interface ExtractedZipEntry {
  name: string;
  data: Buffer;
}

export interface ZipExtractionOptions {
  maxEntryBytes?: number | ((name: string) => number);
  maxExtractedBytes?: number;
  maxEntries?: number;
  maxMatches?: number;
}

/**
 * Safely extract entries from an untrusted zip using fflate's streaming
 * decompressor, aborting the moment an entry exceeds MAX_ENTRY_BYTES.
 * Returns the concatenated bytes of the first entry whose name matches.
 */
export function extractZipEntry(
  buf: Buffer,
  match: (name: string) => boolean,
  options: ZipExtractionOptions = {},
): Buffer | null {
  return extractZipEntries(buf, match, { ...options, maxMatches: 1 })[0]?.data ?? null;
}

/**
 * Extract every matching entry, enforcing both per-entry and total decompressed
 * byte ceilings. The total cap matters for Bambu/MakerWorld 3MF projects,
 * where geometry can be split across several 3D/*.model parts.
 */
export function extractZipEntries(
  buf: Buffer,
  match: (name: string) => boolean,
  options: ZipExtractionOptions = {},
): ExtractedZipEntry[] {
  const results: ExtractedZipEntry[] = [];
  let bombed = false;
  let extractedTotal = 0;
  let entryCount = 0;
  let matchCount = 0;
  const maxExtractedBytes = options.maxExtractedBytes ?? MAX_EXTRACTED_BYTES;
  const maxEntries = options.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxMatches = options.maxMatches ?? Number.POSITIVE_INFINITY;

  const unzip = new Unzip((file) => {
    entryCount += 1;
    if (entryCount > maxEntries) {
      bombed = true;
      file.terminate();
      return;
    }
    if (bombed || matchCount >= maxMatches || !match(file.name)) {
      file.terminate();
      return;
    }
    matchCount += 1;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const maxEntryBytes =
      typeof options.maxEntryBytes === "function"
        ? options.maxEntryBytes(file.name)
        : (options.maxEntryBytes ?? MAX_ENTRY_BYTES);
    file.ondata = (err, chunk, final) => {
      if (err) throw new ModelParseError(`Corrupt zip entry ${file.name}`);
      total += chunk.length;
      extractedTotal += chunk.length;
      if (total > maxEntryBytes || extractedTotal > maxExtractedBytes) {
        bombed = true;
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) results.push({ name: file.name, data: Buffer.concat(chunks) });
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  try {
    // Feed compressed input incrementally. A single push lets some inflaters
    // emit an entire hundreds-of-MiB entry as one callback before `terminate`
    // can take effect. DEFLATE's maximum expansion per 4 KiB input chunk keeps
    // overshoot bounded while the declared/observed output ceilings remain the
    // authoritative checks.
    const inputChunkBytes = 4 * 1024;
    for (let offset = 0; offset < buf.length && !bombed; offset += inputChunkBytes) {
      const end = Math.min(buf.length, offset + inputChunkBytes);
      unzip.push(buf.subarray(offset, end), end === buf.length);
    }
  } catch (err) {
    if (err instanceof ModelParseError) throw err;
    throw new ModelParseError("Not a valid zip container");
  }
  if (bombed) {
    throw new ModelParseError(
      entryCount > maxEntries
        ? `Zip container exceeds ${maxEntries} entries`
        : "Compressed entry expands beyond the allowed size",
      "ZIP_BOMB",
    );
  }
  return results;
}

export function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}
