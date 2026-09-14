import type { ReactNode } from "react";
import { toPublicCatalog } from "@print/shared";
import { getCatalogAvailability } from "@/lib/catalog-availability";
import { getPricing } from "@/lib/pricing-settings";
import { getTax, toPublicTax } from "@/lib/tax-settings";
import { CatalogProvider } from "@/lib/use-catalog";

// Rates and colours are live admin settings, so every quote page is rendered
// per request with the values it will be priced at.
export const dynamic = "force-dynamic";

export default async function QuoteLayout({ children }: { children: ReactNode }) {
  const [availability, pricing, tax] = await Promise.all([getCatalogAvailability(), getPricing(), getTax()]);
  return (
    <CatalogProvider value={{ ...toPublicCatalog(availability), pricing: pricing.catalog, tax: toPublicTax(tax) }}>
      {children}
    </CatalogProvider>
  );
}
