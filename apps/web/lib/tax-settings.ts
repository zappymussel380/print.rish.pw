import { cache } from "react";
import { type Prisma, prisma } from "@print/db";
import { DEFAULT_TAX, normalizeTax, type PublicTax, type TaxSettings } from "@print/shared";

/** Key of the JSON row in `AppSetting` holding admin → Settings → GST. */
export const TAX_KEY = "tax";

/** The GST settings in force; off when nothing is saved or it can't be read. */
export const getTax = cache(async (): Promise<TaxSettings> => {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: TAX_KEY } });
    return row ? normalizeTax(row.value) : { ...DEFAULT_TAX };
  } catch {
    return { ...DEFAULT_TAX };
  }
});

/** What the quote UI needs to show GST. */
export function toPublicTax(tax: TaxSettings): PublicTax {
  return { enabled: tax.enabled, rateBp: tax.rateBp };
}

export async function saveTax(settings: TaxSettings): Promise<void> {
  const value = settings as unknown as Prisma.InputJsonObject;
  await prisma.appSetting.upsert({ where: { key: TAX_KEY }, create: { key: TAX_KEY, value }, update: { value } });
}
