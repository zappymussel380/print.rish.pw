import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { jsonError } from "@/lib/api-util";
import { getQuoteSessionId, isAdmin } from "@/lib/session";
import { openPrivateFile, readPrivateFile, removeQuietly, thumbPath } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_THUMB_BYTES = 5 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
async function resolveThumb(
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

/** Serve the worker-rendered thumbnail PNG. */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return jsonError(404, "NOT_FOUND", "No thumbnail");

  const model = await prisma.uploadedModel.findUnique({ where: { id } });
  if (!model) return jsonError(404, "NOT_FOUND", "No thumbnail");

  const sessionId = await getQuoteSessionId();
  const authorised = model.sessionId === sessionId || (await isAdmin());
  if (!authorised) return jsonError(404, "NOT_FOUND", "No thumbnail");

  const path = await resolveThumb(model.id, model.fileHash, model.thumbPath);
  if (!path) return jsonError(404, "NOT_FOUND", "No thumbnail");

  let opened: Awaited<ReturnType<typeof openPrivateFile>>;
  try {
    opened = await openPrivateFile(path, MAX_THUMB_BYTES);
  } catch {
    return jsonError(404, "NOT_FOUND", "No thumbnail");
  }

  const stream = Readable.toWeb(opened.handle.createReadStream()) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(opened.size),
      "Cache-Control": "private, no-store",
    },
  });
}
