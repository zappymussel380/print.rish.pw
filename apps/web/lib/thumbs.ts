import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { prisma } from "@print/db";
import { openPrivateFile, readPrivateFile, removeQuietly, thumbPath } from "@/lib/storage";

export const MAX_THUMB_BYTES = 5 * 1024 * 1024;

async function isRegularThumb(path: string): Promise<boolean> {
  try {
    const { handle } = await openPrivateFile(path, MAX_THUMB_BYTES);
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

/** Resolve a servable thumbnail for a model, preferring one this model *owns*.
 *  Thumbnails are file-geometry (fileHash) derived, so a model with none of its
 *  own can borrow a same-hash sibling's — but it takes an OWNED COPY rather than
 *  persisting the sibling's path, so per-model delete/retention can never unlink
 *  another row's real thumbnail. Returns an existing, stat-able path or null. */
export async function resolveThumb(
  modelId: string,
  fileHash: string,
  storedPath: string | null,
): Promise<string | null> {
  const owned = thumbPath(modelId);
  if (storedPath) {
    if (await isRegularThumb(owned)) return owned;
    try {
      // File vanished (e.g. an old shared path that got unlinked). Drop the
      // stale pointer and fall through to a fresh copy from a sibling.
      await prisma.uploadedModel
        .update({ where: { id: modelId }, data: { thumbPath: null } })
        .catch(() => {});
    } catch {
      // The missing/stale path is handled by the sibling lookup below.
    }
  }

  const sibling = await prisma.uploadedModel.findFirst({
    where: { fileHash, thumbPath: { not: null }, id: { not: modelId } },
    select: { id: true, thumbPath: true },
  });
  if (!sibling?.thumbPath) return null;

  const siblingPath = thumbPath(sibling.id);
  try {
    const data = await readPrivateFile(siblingPath, MAX_THUMB_BYTES);
    await mkdir(dirname(owned), { recursive: true });
    try {
      await writeFile(owned, data, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || !(await isRegularThumb(owned))) {
        throw err;
      }
    }
    try {
      await prisma.uploadedModel.update({ where: { id: modelId }, data: { thumbPath: owned } });
    } catch (err) {
      await removeQuietly(owned).catch(() => {});
      throw err;
    }
    return owned;
  } catch {
    // Copy failed (source missing mid-flight, disk error). Serve the sibling
    // directly this once WITHOUT persisting a shared path.
    try {
      return (await isRegularThumb(siblingPath)) ? siblingPath : null;
    } catch {
      return null;
    }
  }
}

/** Thumbnail bytes for embedding (e.g. into the quotation PDF); null on any
 *  failure — a missing preview must never fail the caller's document. */
export async function readThumbPng(
  modelId: string,
  fileHash: string,
  storedThumbPath: string | null,
): Promise<Buffer | null> {
  try {
    const path = await resolveThumb(modelId, fileHash, storedThumbPath);
    if (!path) return null;
    return await readPrivateFile(path, MAX_THUMB_BYTES);
  } catch {
    return null;
  }
}
