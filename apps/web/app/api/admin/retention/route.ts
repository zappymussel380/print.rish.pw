import { NextResponse, type NextRequest } from "next/server";
import { retentionInputSchema } from "@print/shared";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { envRetention, getRetention, saveRetention } from "@/lib/retention-settings";
import { assertSameOrigin } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin: the file clean-up policy in force, and the environment's default. */
export async function GET() {
  const auth = await requireAdminApi();
  if (auth) return auth;
  return NextResponse.json({ ...(await getRetention()), defaults: envRetention() });
}

/** Admin: save the policy. The worker's daily sweep reads it from then on. */
export async function PUT(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  const body = await readJsonBody(request, 1024);
  if (!body.ok) return body.response;
  const parsed = retentionInputSchema.safeParse(body.value);
  if (!parsed.success) {
    return jsonError(
      422,
      "INVALID_FIELDS",
      "Keep uploads 1–365 days, finished quotations' files 1–3650 days, and finished quotations 7–3650 days (or for good).",
    );
  }
  await saveRetention(parsed.data);
  return NextResponse.json({ settings: parsed.data, saved: true, defaults: envRetention() });
}
