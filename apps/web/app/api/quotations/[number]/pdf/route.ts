import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { jsonError } from "@/lib/api-util";
import {
  getQuotationAccessCookie,
  quotationAccessMatches,
  setQuotationAccessCookie,
} from "@/lib/quotation-access";
import { RATE_LIMITS, clientIp, rateLimit } from "@/lib/security";
import { isAdmin } from "@/lib/session";
import { openPrivateFile, pdfPath } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NUMBER_RE = /^RSP-\d{4}-\d{4,}$/;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const DUMMY_EXPIRY = new Date("2000-01-01T00:00:00.000Z");
const DUMMY_VERIFIER = `sha256:${"0".repeat(64)}`;

/** Serve a quotation PDF. Access via the customer's access token or an admin
 *  session. For non-admins every failure — unknown number, missing PDF, bad or
 *  absent token — collapses into one identical 404, so quotation numbers
 *  (which are sequential) cannot be enumerated by probing this endpoint. */
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
  const legacyQueryToken = request.nextUrl.searchParams.get("token") ?? "";
  const cookieToken = await getQuotationAccessCookie(number);
  const notFound = () => jsonError(404, "NOT_FOUND", "Quotation not found");

  const quotation = NUMBER_RE.test(number)
    ? await prisma.quotation.findUnique({ where: { number } })
    : null;
  const admin = await isAdmin();

  // Always run both comparisons against dummies for missing rows, keeping
  // sequential quotation-number probes on the same authorization path.
  const verifier = quotation?.accessToken ?? DUMMY_VERIFIER;
  const expiresAt = quotation?.accessTokenExpiresAt ?? DUMMY_EXPIRY;
  const cookieOk = quotationAccessMatches(cookieToken, verifier, expiresAt);
  const legacyQueryOk = quotationAccessMatches(legacyQueryToken, verifier, expiresAt);
  const tokenOk = quotation !== null && (cookieOk || legacyQueryOk);
  if (!admin && !tokenOk) return notFound();
  if (!quotation?.pdfPath) return notFound();

  let opened: Awaited<ReturnType<typeof openPrivateFile>>;
  try {
    opened = await openPrivateFile(pdfPath(quotation.number), MAX_PDF_BYTES);
  } catch {
    return notFound();
  }

  const stream = Readable.toWeb(opened.handle.createReadStream()) as ReadableStream;
  const response = new NextResponse(stream, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(opened.size),
      "Content-Disposition": `inline; filename="${number}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
  if (legacyQueryOk) {
    setQuotationAccessCookie(
      response,
      quotation.number,
      legacyQueryToken,
      quotation.accessTokenExpiresAt,
    );
  }
  return response;
}
