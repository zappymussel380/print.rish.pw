import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { jsonError } from "@/lib/api-util";
import { getQuoteSessionId, isAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME_BY_FORMAT: Record<string, string> = {
  stl: "model/stl",
  "3mf": "model/3mf",
  obj: "model/obj",
  amf: "application/x-amf",
};

/** Serve model bytes to the 3D viewer (session owner) or the admin. */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const model = await prisma.uploadedModel.findUnique({ where: { id } });
  if (!model || !model.storedPath) return jsonError(404, "NOT_FOUND", "Model not found");

  const sessionId = await getQuoteSessionId();
  const authorised = model.sessionId === sessionId || (await isAdmin());
  if (!authorised) return jsonError(404, "NOT_FOUND", "Model not found");

  let size: number;
  try {
    size = (await stat(model.storedPath)).size;
  } catch {
    return jsonError(410, "FILE_EXPIRED", "The file has been removed by the retention policy");
  }

  const stream = Readable.toWeb(createReadStream(model.storedPath)) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": MIME_BY_FORMAT[model.format] ?? "application/octet-stream",
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${model.id}.${model.format}"`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
