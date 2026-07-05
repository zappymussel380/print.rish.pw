import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { jsonError } from "@/lib/api-util";
import { RATE_LIMITS, clientIp, rateLimit } from "@/lib/security";
import { isAdmin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tokenMatches(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Serve a quotation PDF. Access via the customer's access token or an admin
 *  session. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ number: string }> }) {
  const limit = await rateLimit(
    "pdf",
    clientIp(request),
    RATE_LIMITS.pdf.max,
    RATE_LIMITS.pdf.windowSeconds,
  );
  if (!limit.allowed) {
    const res = jsonError(429, "RATE_LIMITED", "Too many requests — please slow down");
    res.headers.set("Retry-After", String(limit.retryAfterSeconds));
    return res;
  }

  const { number } = await ctx.params;
  const token = request.nextUrl.searchParams.get("token") ?? "";

  const quotation = await prisma.quotation.findUnique({ where: { number } });
  if (!quotation?.pdfPath) return jsonError(404, "NOT_FOUND", "Quotation PDF not found");

  const authorised = (token && tokenMatches(token, quotation.accessToken)) || (await isAdmin());
  if (!authorised) return jsonError(403, "FORBIDDEN", "Invalid or missing access token");

  let size: number;
  try {
    size = (await stat(quotation.pdfPath)).size;
  } catch {
    return jsonError(404, "NOT_FOUND", "Quotation PDF not found");
  }

  const stream = Readable.toWeb(createReadStream(quotation.pdfPath)) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(size),
      "Content-Disposition": `inline; filename="${number}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
