import { NextResponse, type NextRequest } from "next/server";
import { CUSTOM_MATERIAL_NAME_MAX, customMaterialNamesInputSchema, materialName, toPublicCatalog } from "@print/shared";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { getReadyCustomMaterials, saveCustomMaterialNames } from "@/lib/catalog-availability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

/** Admin: name (or clear) the shop's own materials. Only the names change —
 *  availability and colours are the Catalog editor's. */
export async function PUT(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = customMaterialNamesInputSchema.safeParse(body.value);
  if (!parsed.success) return jsonError(422, "BAD_REQUEST", "Invalid material names payload");

  const saved = await saveCustomMaterialNames(parsed.data.names);
  if ("invalid" in saved) {
    const which = saved.invalid.map((id) => materialName(id)).join(", ");
    return jsonError(
      422,
      "BAD_NAME",
      `${which}: use 1–${CUSTOM_MATERIAL_NAME_MAX} letters, numbers, spaces and . , + - / ( ) % &, starting with a letter or number.`,
    );
  }
  return NextResponse.json(toPublicCatalog(saved, await getReadyCustomMaterials()));
}
