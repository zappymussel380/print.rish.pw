import { NextResponse, type NextRequest } from "next/server";
import { findPricingIssues, pricingInputSchema, toPricingInput } from "@print/shared";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { getPricing, savePricing } from "@/lib/pricing-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

/** Admin: every rate, customer-facing and internal, in storable form. */
export async function GET() {
  const auth = await requireAdminApi();
  if (auth) return auth;
  return NextResponse.json(toPricingInput(await getPricing()));
}

/** Admin: replace the rates. Any out-of-range or malformed field refuses the
 *  whole save (422, naming the fields) rather than being quietly replaced. */
export async function PUT(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;

  const parsed = pricingInputSchema.safeParse(body.value);
  if (!parsed.success) return jsonError(422, "BAD_REQUEST", "Invalid pricing payload");
  const issues = findPricingIssues(parsed.data);
  if (issues.length > 0) {
    return jsonError(422, "OUT_OF_RANGE", `Check these rates: ${issues.join(", ")}`);
  }

  return NextResponse.json(toPricingInput(await savePricing(parsed.data)));
}
