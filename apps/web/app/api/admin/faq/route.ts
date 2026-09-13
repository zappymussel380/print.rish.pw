import { NextResponse, type NextRequest } from "next/server";
import { faqSettingsSchema } from "@print/shared";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { getFaqSettings, saveFaqSettings } from "@/lib/faq";
import { assertSameOrigin } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 128 * 1024;

export async function GET() {
  const auth = await requireAdminApi();
  if (auth) return auth;
  return NextResponse.json(await getFaqSettings());
}

/** Admin: replace the shop's own FAQ entries and the generated ones it hides.
 *  Anything malformed or over the limits refuses the whole save. */
export async function PUT(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;

  const parsed = faqSettingsSchema.safeParse(body.value);
  if (!parsed.success) {
    return jsonError(422, "BAD_REQUEST", "Check the FAQ entries: every question and answer needs text, within the length limits.");
  }
  return NextResponse.json(await saveFaqSettings(parsed.data));
}
