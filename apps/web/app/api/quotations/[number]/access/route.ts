import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { guardMutation, jsonError, readJsonBody } from "@/lib/api-util";
import {
  quotationAccessMatches,
  setQuotationAccessCookie,
} from "@/lib/quotation-access";
import { RATE_LIMITS } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NUMBER_RE = /^RSP-\d{4}-\d{4,}$/;
const DUMMY_VERIFIER = `sha256:${"0".repeat(64)}`;
const DUMMY_EXPIRY = new Date("2000-01-01T00:00:00.000Z");

/** Redeem a capability carried in a URL fragment for a host-only HttpOnly
 * cookie. The fragment never reaches HTTP logs/referrers; client JS sends it
 * once through this bounded, rate-limited same-origin endpoint. */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ number: string }> },
) {
  const guard = await guardMutation(
    request,
    "quotationAccess",
    RATE_LIMITS.quotationAccess,
  );
  if (guard) return guard;

  const parsedBody = await readJsonBody(request, 4 * 1024);
  if (!parsedBody.ok) return parsedBody.response;
  const token = (parsedBody.value as { token?: unknown })?.token;
  const { number } = await ctx.params;

  const quotation = NUMBER_RE.test(number)
    ? await prisma.quotation.findUnique({
        where: { number },
        select: { accessToken: true, accessTokenExpiresAt: true },
      })
    : null;
  const valid = quotationAccessMatches(
    typeof token === "string" ? token : "",
    quotation?.accessToken ?? DUMMY_VERIFIER,
    quotation?.accessTokenExpiresAt ?? DUMMY_EXPIRY,
  );
  if (!quotation || !valid) {
    return jsonError(404, "NOT_FOUND", "Quotation not found");
  }

  const response = NextResponse.json({ ok: true });
  response.headers.set("Cache-Control", "no-store");
  setQuotationAccessCookie(response, number, token as string, quotation.accessTokenExpiresAt);
  return response;
}
