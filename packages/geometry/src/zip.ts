import { Unzip, UnzipInflate } from "fflate";
import { ModelParseError } from "./types";

/** Default decompressed-size ceiling for any single entry we extract from an
 *  uploaded container. Keeps zip bombs from exhausting memory: the input file
 *  itself is already capped by the upload limit (300 MiB), and the only
 *  entries we ever extract are model XML.
 *
 *  This is the fallback for callers that pass no `maxEntryBytes`, which today
 *  means zipped AMF. 3MF overrides it per entry (see `load3mfProject`), since
 *  a detailed `3D/*.model` part legitimately runs to MAX_XML_BYTES - well past
 *  this default. Do not assume this value bounds every extraction. */
export const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
/** Aggregate decompressed budget across every entry we extract from one
 *  container. A multi-part 3MF spends this across several `3D/*.model` parts,
 *  so it has to clear the single-entry ceiling with room to spare rather than
 *  merely match it. */
export const MAX_EXTRACTED_BYTES = 192 * 1024 * 1024;
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
  /** Why extraction aborted, so the thrown error names the limit that was hit
   *  instead of accusing every oversized model of being a zip bomb. */
  let bombed: "entries" | "entry" | "total" | null = null;
  let extractedTotal = 0;
  let entryCount = 0;
  let matchCount = 0;
  const maxExtractedBytes = options.maxExtractedBytes ?? MAX_EXTRACTED_BYTES;
  const maxEntries = options.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxMatches = options.maxMatches ?? Number.POSITIVE_INFINITY;

  const unzip = new Unzip((file) => {
    entryCount += 1;
    if (entryCount > maxEntries) {
      bombed = "entries";
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
        bombed = total > maxEntryBytes ? "entry" : "total";
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
    throw new ModelParseError(zipLimitMessage(bombed, maxEntries), "ZIP_BOMB");
  }
  return results;
}

/** Phrased for the customer who uploaded an ordinary, highly detailed model:
 *  the old wording called every oversized entry a zip bomb, which reads as an
 *  accusation and gives no hint that simplifying the mesh is the fix. */
function zipLimitMessage(reason: "entries" | "entry" | "total", maxEntries: number): string {
  switch (reason) {
    case "entries":
      return `Zip container exceeds ${maxEntries} entries`;
    case "entry":
      return "A part of this file is too large to read once decompressed - the model is more detailed than this service can process";
    case "total":
      return "This file's parts are too large to read once decompressed - the model is more detailed than this service can process";
  }
}

export function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}
