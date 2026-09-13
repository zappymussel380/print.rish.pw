import { NextResponse, type NextRequest } from "next/server";
import { findSiteProfileIssues, siteProfileInputSchema } from "@print/shared";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { getStoredSiteProfile, saveSiteProfile } from "@/lib/site-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

/** Admin: the shop profile as stored (env fallbacks not applied). */
export async function GET() {
  const auth = await requireAdminApi();
  if (auth) return auth;
  return NextResponse.json(await getStoredSiteProfile());
}

/** Admin: replace the shop profile. Any invalid field refuses the whole save
 *  (422, naming the fields) rather than being quietly replaced. */
export async function PUT(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;

  const parsed = siteProfileInputSchema.safeParse(body.value);
  if (!parsed.success) return jsonError(422, "BAD_REQUEST", "Invalid site profile payload");
  const issues = findSiteProfileIssues(parsed.data);
  if (issues.length > 0) {
    return jsonError(422, "INVALID_FIELDS", `Check these fields: ${issues.join(", ")}`);
  }
  return NextResponse.json(await saveSiteProfile(parsed.data));
}
