import { NextResponse } from "next/server";
import { toPublicCatalog } from "@print/shared";
import { getCatalogAvailability } from "@/lib/catalog-availability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public: the material/colour options a customer may currently pick, with
 *  per-item enabled flags, names and swatches. Drives the quote settings UI. */
export async function GET() {
  const avail = await getCatalogAvailability();
  return NextResponse.json(toPublicCatalog(avail), {
    headers: { "Cache-Control": "public, max-age=30, s-maxage=30" },
  });
}
