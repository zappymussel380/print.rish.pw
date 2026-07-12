import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { jsonError } from "@/lib/api-util";
import { env } from "@/lib/env";
import { clientIp, rateLimitBytes, RATE_LIMITS } from "@/lib/security";
import { getQuoteSessionId, isAdmin } from "@/lib/session";
import { modelPath, openPrivateFile } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME_BY_FORMAT: Record<string, string> = {
  stl: "model/stl",
  "3mf": "model/3mf",
  obj: "model/obj",
  amf: "application/x-amf",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORMATS = new Set(["stl", "3mf", "obj", "amf"]);

function contentDispositionFilename(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "model";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Serve model bytes to the 3D viewer (session owner) or the admin. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return jsonError(404, "NOT_FOUND", "Model not found");

  const model = await prisma.uploadedModel.findUnique({ where: { id } });
  if (!model || !model.storedPath || !FORMATS.has(model.format)) {
    return jsonError(404, "NOT_FOUND", "Model not found");
  }

  const sessionId = await getQuoteSessionId();
  const authorised = model.sessionId === sessionId || (await isAdmin());
  if (!authorised) return jsonError(404, "NOT_FOUND", "Model not found");

  const budget = await rateLimitBytes(
    "model-download",
    clientIp(request),
    model.sizeBytes,
    env.downloadWindowBytes,
    RATE_LIMITS.upload.windowSeconds,
  );
  if (!budget.allowed) {
    const response = jsonError(429, "DOWNLOAD_BUDGET_EXCEEDED", "Download limit reached. Please try again later.");
    response.headers.set("Retry-After", String(budget.retryAfterSeconds));
    return response;
  }

  let opened: Awaited<ReturnType<typeof openPrivateFile>>;
  try {
    // Ignore the DB path after using its emptiness as the retention marker. The
    // actual path is derived from server-owned identifiers and opened no-follow.
    opened = await openPrivateFile(
      modelPath(model.id, model.format),
      env.maxUploadBytes,
      model.sizeBytes,
    );
  } catch {
    return jsonError(410, "FILE_EXPIRED", "The file has been removed by the retention policy");
  }

  const stream = Readable.toWeb(opened.handle.createReadStream()) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": MIME_BY_FORMAT[model.format] ?? "application/octet-stream",
      "Content-Length": String(opened.size),
      "Content-Disposition": contentDispositionFilename(model.originalName),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
