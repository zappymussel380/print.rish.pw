import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { jsonError } from "@/lib/api-util";
import { clientIp, rateLimit, RATE_LIMITS } from "@/lib/security";
import { getQuoteSessionId } from "@/lib/session";
import { serializeSlice } from "@/lib/slice-serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Poll a slice by its result-row id. The id is an unguessable uuid handed to
 *  the client by POST /api/slices; the stats it exposes are non-sensitive. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return jsonError(404, "NOT_FOUND", "Unknown slice");
  const sessionId = await getQuoteSessionId();
  if (!sessionId) return jsonError(404, "NOT_FOUND", "Unknown slice");
  const limit = await rateLimit(
    "slicePoll",
    `${clientIp(request)}:${sessionId}`,
    RATE_LIMITS.slicePoll.max,
    RATE_LIMITS.slicePoll.windowSeconds,
  );
  if (!limit.allowed) {
    const response = jsonError(429, "RATE_LIMITED", "Too many polling requests");
    response.headers.set("Retry-After", String(limit.retryAfterSeconds));
    return response;
  }
  const row = await prisma.sliceResult.findUnique({ where: { id } });
  if (!row) return jsonError(404, "NOT_FOUND", "Unknown slice");
  const ownsMatchingModel = await prisma.uploadedModel.count({
    where: { sessionId, fileHash: row.fileHash },
  });
  if (ownsMatchingModel === 0) return jsonError(404, "NOT_FOUND", "Unknown slice");
  return NextResponse.json(serializeSlice(row));
}
