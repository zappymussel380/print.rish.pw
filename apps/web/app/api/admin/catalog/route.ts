import { NextResponse, type NextRequest } from "next/server";
import { CUSTOM_MATERIAL_IDS, availabilitySchema, customMaterialProblem, normalizeAvailability, toPublicCatalog } from "@print/shared";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { getReadyCustomMaterials, getStoredCatalogAvailability, saveCatalogAvailability } from "@/lib/catalog-availability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

/** Admin: availability as saved, with the full palette, enabled flags, and
 *  what each of the shop's own materials still needs before it can be offered. */
export async function GET() {
  const auth = await requireAdminApi();
  if (auth) return auth;
  const [avail, ready] = await Promise.all([getStoredCatalogAvailability(), getReadyCustomMaterials()]);
  return NextResponse.json(toPublicCatalog(avail, ready));
}

/** Admin: replace material/colour availability. Body is normalized on save, so
 *  unknown materials and colours outside a material's palette are dropped. One
 *  of the shop's own materials can only be switched on once it's named and has
 *  a live OrcaSlicer profile. */
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

  const [stored, ready] = await Promise.all([getStoredCatalogAvailability(), getReadyCustomMaterials()]);
  // Judge the switch-on against the names as stored: this editor never sets them.
  const wanted = { ...normalizeAvailability(parsed.data), customMaterials: stored.customMaterials };
  const problems = CUSTOM_MATERIAL_IDS.flatMap((id) => {
    if (!wanted.materials[id] || stored.materials[id]) return [];
    const problem = customMaterialProblem(wanted, id, ready);
    return problem ? [problem] : [];
  });
  if (problems.length) return jsonError(422, "MATERIAL_NOT_READY", problems.join(" "));

  const saved = await saveCatalogAvailability(parsed.data);
  return NextResponse.json(toPublicCatalog(saved, ready));
}
