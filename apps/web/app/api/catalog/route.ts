import { NextResponse } from "next/server";
import { toPublicCatalog } from "@print/shared";
import { getCatalogAvailability } from "@/lib/catalog-availability";
import { getMaterialHelper, toPublicHelper } from "@/lib/material-helper";
import { getPricing } from "@/lib/pricing-settings";
import { getTax, toPublicTax } from "@/lib/tax-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public: the material/colour options a customer may currently pick, with
 *  per-item enabled flags, names and swatches, plus the customer-facing rates
 *  the quote is priced with. Internal cost figures are never included. */
export async function GET() {
  const [avail, pricing, tax, helper] = await Promise.all([getCatalogAvailability(), getPricing(), getTax(), getMaterialHelper()]);
  return NextResponse.json({ ...toPublicCatalog(avail), pricing: pricing.catalog, tax: toPublicTax(tax), helper: toPublicHelper(helper, avail) }, {
    headers: { "Cache-Control": "public, max-age=30, s-maxage=30" },
  });
}
