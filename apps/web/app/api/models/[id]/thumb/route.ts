import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { UUID_RE } from "@print/shared";
import { jsonError } from "@/lib/api-util";
import { getQuoteSessionId, isAdmin } from "@/lib/session";
import { openPrivateFile } from "@/lib/storage";
import { MAX_THUMB_BYTES, resolveThumb } from "@/lib/thumbs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
