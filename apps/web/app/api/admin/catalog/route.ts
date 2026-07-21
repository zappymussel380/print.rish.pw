import { NextResponse, type NextRequest } from "next/server";
import { availabilitySchema, toPublicCatalog } from "@print/shared";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { getCatalogAvailability, saveCatalogAvailability } from "@/lib/catalog-availability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

/** Admin: current availability with the full palette + enabled flags. */
export async function GET() {
  const auth = await requireAdminApi();
  if (auth) return auth;
  const avail = await getCatalogAvailability();
  return NextResponse.json(toPublicCatalog(avail));
}

/** Admin: replace material/colour availability. Body is normalized on save, so
 *  unknown materials and colours outside a material's palette are dropped. */
export async function PUT(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;

  const parsed = availabilitySchema.safeParse(body.value);
  if (!parsed.success) {
    return jsonError(422, "BAD_REQUEST", "Invalid catalog availability payload");
  }

  const saved = await saveCatalogAvailability(parsed.data);
  return NextResponse.json(toPublicCatalog(saved));
}
