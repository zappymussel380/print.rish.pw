import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { jsonError } from "@/lib/api-util";
import { getQuoteSessionId, isAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serve the worker-rendered thumbnail PNG. */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const model = await prisma.uploadedModel.findUnique({ where: { id } });
  if (!model?.thumbPath) return jsonError(404, "NOT_FOUND", "No thumbnail");

  const sessionId = await getQuoteSessionId();
  const authorised = model.sessionId === sessionId || (await isAdmin());
  if (!authorised) return jsonError(404, "NOT_FOUND", "No thumbnail");

  let size: number;
  try {
    size = (await stat(model.thumbPath)).size;
  } catch {
    return jsonError(404, "NOT_FOUND", "No thumbnail");
  }

  const stream = Readable.toWeb(createReadStream(model.thumbPath)) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(size),
      "Cache-Control": "private, max-age=86400",
    },
  });
}
