import { cache } from "react";
import { getPrinterProfile, getPrinterSpec } from "./printer";
import { Prisma, prisma } from "@print/db";
import {
  type PricingInput,
  type PrinterProfileSpec,
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
  const printer = await getPrinterProfile().catch(() => getPrinterSpec());
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: PRICING_KEY } });
    return withPrinter(normalizePricing(row?.value ?? null), printer);
  } catch {
    // Pricing must never take the site down: fall back to the code defaults,
    // which are what every shop runs on until its admin saves new rates.
    return withPrinter(normalizePricing(null), printer);
  }
});

/** The catalog's printer is the shop's real one (name, build volume, multicolour);
 *  its power draw stays the admin-editable rate. */
function withPrinter(settings: PricingSettings, spec: PrinterProfileSpec): PricingSettings {
  const { catalog } = settings;
  const current = catalog.printers[catalog.defaultPrinterId]!;
  catalog.printers[catalog.defaultPrinterId] = {
    ...current,
    name: spec.name,
    nozzleMm: spec.nozzleMm,
    bedMm: spec.bedMm,
    multiMaterial: spec.multiMaterial,
  };
  return settings;
}

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
