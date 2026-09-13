import { cache } from "react";
import { Prisma, prisma } from "@print/db";
import {
  type PricingInput,
  type PricingSettings,
  normalizePricing,
  toPricingInput,
} from "@print/shared";

/** Key of the single JSON row in `AppSetting` that stores admin-edited rates. */
export const PRICING_KEY = "pricing";

/** Current rates: code defaults overlaid with whatever the admin has saved.
 *  `cache()` dedupes the read within a request, so a page and the pricing it
 *  hands the client always agree. */
export const getPricing = cache(async (): Promise<PricingSettings> => {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: PRICING_KEY } });
    return normalizePricing(row?.value ?? null);
  } catch {
    // Pricing must never take the site down: fall back to the code defaults,
    // which are what every shop runs on until its admin saves new rates.
    return normalizePricing(null);
  }
});

/** Persist new rates (admin only). Normalized first, and stored complete, so a
 *  later change to a code default never silently reprices a shop. */
export async function savePricing(input: PricingInput): Promise<PricingSettings> {
  const normalized = normalizePricing(input);
  const value = toPricingInput(normalized) as unknown as Prisma.InputJsonObject;
  await prisma.appSetting.upsert({
    where: { key: PRICING_KEY },
    create: { key: PRICING_KEY, value },
    update: { value },
  });
  return normalized;
}
