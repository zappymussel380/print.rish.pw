import { Unzip, UnzipInflate } from "fflate";
import { ModelParseError } from "./types";

/** Decompressed-size ceiling for any single entry we extract from an
 *  uploaded container (3MF / zipped AMF). Keeps zip bombs from exhausting
 *  memory: the input file itself is already capped by the upload limit
 *  (~100 MB), and the only entries we ever extract are model XML — anything
 *  expanding past this is hostile or unparseable in reasonable time anyway
 *  (it would blow the XML parser's own MAX_XML_BYTES cap next). */
export const MAX_ENTRY_BYTES = 128 * 1024 * 1024;

/**
 * Safely extract entries from an untrusted zip using fflate's streaming
 * decompressor, aborting the moment an entry exceeds MAX_ENTRY_BYTES.
 * Returns the concatenated bytes of the first entry whose name matches.
 */
export function extractZipEntry(buf: Buffer, match: (name: string) => boolean): Buffer | null {
  let result: Buffer | null = null;
  let bombed = false;

  const unzip = new Unzip((file) => {
    if (result !== null || bombed || !match(file.name)) return;
    const chunks: Uint8Array[] = [];
    let total = 0;
    file.ondata = (err, chunk, final) => {
      if (err) throw new ModelParseError(`Corrupt zip entry ${file.name}`);
      total += chunk.length;
      if (total > MAX_ENTRY_BYTES) {
        bombed = true;
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) result = Buffer.concat(chunks);
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  try {
    unzip.push(buf, true);
  } catch (err) {
    if (err instanceof ModelParseError) throw err;
    throw new ModelParseError("Not a valid zip container");
  }
  if (bombed) {
    throw new ModelParseError("Compressed entry expands beyond the allowed size", "ZIP_BOMB");
  }
  return result;
}

export function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}
