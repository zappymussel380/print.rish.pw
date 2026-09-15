import { NextResponse, type NextRequest } from "next/server";
import { materialHelperInputSchema, normalizeMaterialHelper, OWN_NEED_LIMITS } from "@print/shared";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { getMaterialHelper, saveMaterialHelper } from "@/lib/material-helper";
import { assertSameOrigin } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

/** Admin: the "Help me choose" picker's needs and ratings. */
export async function GET() {
  const auth = await requireAdminApi();
  if (auth) return auth;
  return NextResponse.json(await getMaterialHelper());
}

/** Admin: replace the whole helper — on/off, which needs, the shop's own
 *  needs, and every material's rating on each. */
export async function PUT(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = materialHelperInputSchema.safeParse(body.value);
  if (!parsed.success) {
    return jsonError(
      422,
      "BAD_REQUEST",
      `Check your own needs: each needs a name of up to ${OWN_NEED_LIMITS.label} characters, and a description of up to ${OWN_NEED_LIMITS.description}.`,
    );
  }
  // Stored normalized, like every other setting, so what's read back is what's saved.
  const next = normalizeMaterialHelper(parsed.data);
  await saveMaterialHelper(next);
  return NextResponse.json(next);
}
