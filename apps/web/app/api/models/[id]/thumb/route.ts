import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { jsonError } from "@/lib/api-util";
import { getQuoteSessionId, isAdmin } from "@/lib/session";
import { thumbPath } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  if (storedPath) {
    try {
      await stat(storedPath);
      return storedPath;
    } catch {
      // File vanished (e.g. an old shared path that got unlinked). Drop the
      // stale pointer and fall through to a fresh copy from a sibling.
      await prisma.uploadedModel
        .update({ where: { id: modelId }, data: { thumbPath: null } })
        .catch(() => {});
    }
  }

  const sibling = await prisma.uploadedModel.findFirst({
    where: { fileHash, thumbPath: { not: null }, id: { not: modelId } },
    select: { thumbPath: true },
  });
  if (!sibling?.thumbPath) return null;

  const owned = thumbPath(modelId);
  try {
    await mkdir(dirname(owned), { recursive: true });
    await copyFile(sibling.thumbPath, owned);
    await prisma.uploadedModel
      .update({ where: { id: modelId }, data: { thumbPath: owned } })
      .catch(() => {});
    return owned;
  } catch {
    // Copy failed (source missing mid-flight, disk error). Serve the sibling
    // directly this once WITHOUT persisting a shared path.
    try {
      await stat(sibling.thumbPath);
      return sibling.thumbPath;
    } catch {
      return null;
    }
  }
}

/** Serve the worker-rendered thumbnail PNG. */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const model = await prisma.uploadedModel.findUnique({ where: { id } });
  if (!model) return jsonError(404, "NOT_FOUND", "No thumbnail");

  const sessionId = await getQuoteSessionId();
  const authorised = model.sessionId === sessionId || (await isAdmin());
  if (!authorised) return jsonError(404, "NOT_FOUND", "No thumbnail");

  const path = await resolveThumb(model.id, model.fileHash, model.thumbPath);
  if (!path) return jsonError(404, "NOT_FOUND", "No thumbnail");

  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return jsonError(404, "NOT_FOUND", "No thumbnail");
  }

  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(size),
      "Cache-Control": "private, max-age=86400",
    },
  });
}
