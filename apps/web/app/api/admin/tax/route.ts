import { NextResponse, type NextRequest } from "next/server";
import { GSTIN_RE, HSN_RE, taxInputSchema, type TaxSettings } from "@print/shared";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { getTax, saveTax } from "@/lib/tax-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin: the GST added to quotations. */
export async function GET() {
  const auth = await requireAdminApi();
  if (auth) return auth;
  return NextResponse.json(await getTax());
}

/** Admin: switch GST on or off. On needs a rate, an HSN/SAC code and a valid
 *  GSTIN, all printed on each new quotation; issued ones keep what they had. */
export async function PUT(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  const body = await readJsonBody(request, 1024);
  if (!body.ok) return body.response;
  const parsed = taxInputSchema.safeParse(body.value);
  if (!parsed.success) return jsonError(422, "BAD_REQUEST", "Rate must be 0–28%.");
  const { enabled, ratePct, hsn, gstin } = parsed.data;
  const rateBp = Math.round(ratePct * 100);

  const issues: string[] = [];
  if (hsn !== "" && !HSN_RE.test(hsn)) issues.push("the HSN/SAC code (4–8 digits)");
  if (gstin !== "" && !GSTIN_RE.test(gstin)) issues.push("the GSTIN (15 characters, e.g. 18AABCU9603R1ZM)");
  if (enabled) {
    if (rateBp <= 0) issues.push("a rate above 0%");
    if (hsn === "") issues.push("an HSN/SAC code");
    if (gstin === "") issues.push("your GSTIN");
  }
  if (issues.length > 0) {
    return jsonError(422, "INVALID_FIELDS", `${enabled ? "To add GST, check" : "Check"} ${[...new Set(issues)].join(", ")}.`);
  }
  const next: TaxSettings = { enabled, rateBp, hsn, gstin };
  await saveTax(next);
  return NextResponse.json(next);
}
