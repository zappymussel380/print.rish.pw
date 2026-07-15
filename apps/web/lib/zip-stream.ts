import type { FileHandle } from "node:fs/promises";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

const CHUNK_BYTES = 64 * 1024;

export interface ZipStreamEntry {
  /** Final name inside the archive (already sanitised and deduped). */
  name: string;
  handle: FileHandle;
  size: number;
  /** Store without recompressing — for containers that are already deflated
   *  (3MF is a zip itself; recompressing wastes CPU for ~0 gain). */
  store: boolean;
}

/** Strip path separators and control characters from a user-supplied filename
 *  so it can never escape the archive root or confuse extractors. */
export function sanitizeArchiveName(raw: string, fallback: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- stripping control chars is the goal
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || fallback;
}

/** Pick a unique archive name, appending " (n)" before the extension on
 *  case-insensitive collision (zip readers on Windows/macOS treat names
 *  case-insensitively). Mutates `taken` with the reserved lowercase key. */
export function uniqueArchiveName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    candidate = `${stem} (${n})${ext}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** Stream `entries` (open file handles) into a zip without buffering whole
 *  files: models can be hundreds of MB, so chunks are pumped 64 KB at a time
 *  and the pump pauses whenever the consumer stops draining. Cancelling the
 *  stream (abandoned download) closes every handle. If any expected files were
 *  unavailable, a MISSING_FILES.txt manifest is appended so the recipient
 *  knows the archive is intentionally incomplete rather than corrupt. */
export function createZipStream(
  entries: ZipStreamEntry[],
  missing: string[],
): ReadableStream<Uint8Array> {
  let aborted = false;
  let awaitDrain: (() => void) | null = null;

  const closeAll = async () => {
    await Promise.all(entries.map((entry) => entry.handle.close().catch(() => {})));
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const zip = new Zip((err, chunk, final) => {
        if (aborted) return;
        if (err) {
          aborted = true;
          controller.error(err);
          return;
        }
        controller.enqueue(chunk);
        if (final) controller.close();
      });

      const waitForDemand = () =>
        new Promise<void>((resolve) => {
          if (aborted || (controller.desiredSize ?? 1) > 0) return resolve();
          awaitDrain = resolve;
        });

      const pump = async () => {
        try {
          for (const entry of entries) {
            const file = entry.store
              ? new ZipPassThrough(entry.name)
              : new ZipDeflate(entry.name);
            zip.add(file);
            let offset = 0;
            while (offset < entry.size) {
              if (aborted) return;
              const length = Math.min(CHUNK_BYTES, entry.size - offset);
              // Fresh buffer per chunk: ZipPassThrough forwards the exact
              // Uint8Array it was pushed, so a reused buffer would corrupt
              // chunks still queued downstream.
              const chunk = Buffer.allocUnsafe(length);
              const { bytesRead } = await entry.handle.read(chunk, 0, length, offset);
              if (bytesRead <= 0) throw new Error(`Unexpected EOF in ${entry.name}`);
              offset += bytesRead;
              file.push(chunk.subarray(0, bytesRead), offset >= entry.size);
              await waitForDemand();
            }
          }
          if (aborted) return;
          if (missing.length > 0) {
            const note = new ZipDeflate("MISSING_FILES.txt");
            zip.add(note);
            const text = [
              "The following files could not be included in this archive:",
              "",
              ...missing.map((name) => `- ${name}`),
              "",
              "They may have been removed by the retention policy, or the PDF",
              "may not have been generated yet.",
              "",
            ].join("\n");
            note.push(new TextEncoder().encode(text), true);
          }
          zip.end();
        } catch (err) {
          if (!aborted) {
            aborted = true;
            controller.error(err);
          }
        } finally {
          await closeAll();
        }
      };
      void pump();
    },
    pull() {
      awaitDrain?.();
      awaitDrain = null;
    },
    cancel() {
      aborted = true;
      awaitDrain?.();
      awaitDrain = null;
    },
  });
}
