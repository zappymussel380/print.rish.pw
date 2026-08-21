import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RecentPrint } from "@print/shared";
import { removeQuietly, showcasePath, uploadRoot } from "./storage";

/** A photo that has been uploaded but never appeared in the list must survive
 *  long enough for the admin to finish writing its caption and save. */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const SHOWCASE_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/;

/**
 * Delete showcase photos no saved entry points at.
 *
 * This is how removing a print from the gallery deletes its file. A photo the
 * previous list referenced and the new one does not was removed deliberately,
 * so it goes immediately; a photo neither list ever mentioned is an abandoned
 * upload and gets the grace period, in case its caption is still being typed.
 *
 * The daily retention sweep deliberately does not walk this directory — it
 * reaps by model row, and these files have no model row — so the cleanup lives
 * with the writer instead.
 */
export async function pruneUnreferencedShowcasePhotos(
  saved: readonly RecentPrint[],
  previous: readonly RecentPrint[] = [],
): Promise<number> {
  const keep = new Set(saved.map((print) => showcasePath(print.id, print.photoExt)));
  const removedDeliberately = new Set(
    previous
      .map((print) => showcasePath(print.id, print.photoExt))
      .filter((path) => !keep.has(path)),
  );
  const dir = join(uploadRoot(), "showcase");
  const cutoff = Date.now() - ORPHAN_GRACE_MS;
  let removed = 0;

  try {
    const entries = await opendir(dir);
    for await (const entry of entries) {
      if (!entry.isFile() || !SHOWCASE_FILE_RE.test(entry.name)) continue;
      const path = join(dir, entry.name);
      if (keep.has(path)) continue;

      if (!removedDeliberately.has(path)) {
        try {
          if ((await stat(path)).mtimeMs >= cutoff) continue;
        } catch {
          continue;
        }
      }
      await removeQuietly(path);
      removed += 1;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return removed;
}
