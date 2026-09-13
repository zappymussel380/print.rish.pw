import { NextResponse } from "next/server";
import { toPublicCatalog } from "@print/shared";
import { getCatalogAvailability } from "@/lib/catalog-availability";
import { getPricing } from "@/lib/pricing-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public: the material/colour options a customer may currently pick, with
 *  per-item enabled flags, names and swatches, plus the customer-facing rates
 *  the quote is priced with. Internal cost figures are never included. */
export async function GET() {
  const [avail, pricing] = await Promise.all([getCatalogAvailability(), getPricing()]);
  return NextResponse.json({ ...toPublicCatalog(avail), pricing: pricing.catalog }, {
    headers: { "Cache-Control": "public, max-age=30, s-maxage=30" },
  });
}
