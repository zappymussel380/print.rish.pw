import { cache } from "react";
import { Prisma, prisma } from "@print/db";
import {
  MATERIAL_IDS,
  buildFaq,
  composeFaq,
  materialName,
  normalizeFaqSettings,
  type FaqEntry,
  type FaqSettings,
} from "@print/shared";
import { getCatalogAvailability } from "./catalog-availability";
import { getPricing } from "./pricing-settings";
import { getRetention } from "./retention-settings";
import { getShippingConfig } from "./shipping-settings";
import { getSiteProfile } from "./site-profile";

/** Key of the AppSetting row holding the shop's own FAQ entries and hides. */
export const FAQ_KEY = "faq";

export const getFaqSettings = cache(async (): Promise<FaqSettings> => {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: FAQ_KEY } });
    return normalizeFaqSettings(row?.value ?? null);
  } catch {
    return normalizeFaqSettings(null);
  }
});

export async function saveFaqSettings(settings: FaqSettings): Promise<FaqSettings> {
  const normalized = normalizeFaqSettings(settings);
  const value = normalized as unknown as Prisma.InputJsonObject;
  await prisma.appSetting.upsert({
    where: { key: FAQ_KEY },
    create: { key: FAQ_KEY, value },
    update: { value },
  });
  return normalized;
}

/** The generated FAQ, answered from this shop's live settings. */
export const getGeneratedFaq = cache(async (): Promise<FaqEntry[]> => {
  const [availability, { catalog }, profile, shipping, retention] = await Promise.all([
    getCatalogAvailability(),
    getPricing(),
    getSiteProfile(),
    getShippingConfig(),
    getRetention(),
  ]);
  const printer = catalog.printers[catalog.defaultPrinterId]!;
  const offered = MATERIAL_IDS.filter((m) => availability.materials[m]);
  return buildFaq({
    materials: offered.map((m) => ({ id: m, name: materialName(m, availability.customMaterials) })),
    colourCount: new Set(offered.flatMap((m) => availability.colours[m] ?? [])).size,
    printer: { name: printer.name, bedMm: printer.bedMm, multiMaterial: printer.multiMaterial ?? false },
    city: profile.city,
    leadTime: catalog.leadTime,
    courierQuotes: shipping.live,
    retention: {
      uploadHours: retention.policy.uploadRetentionHours,
      fileDays: retention.policy.fileRetentionDays,
      quotationDays: retention.policy.quotationRetentionDays,
    },
    contactChannel: profile.contact.whatsappNumber ? "WhatsApp" : "the contact page",
    layerHeights: availability.layerHeights,
  });
});

/** What /faq shows. */
export async function getFaq(): Promise<FaqEntry[]> {
  const [generated, settings] = await Promise.all([getGeneratedFaq(), getFaqSettings()]);
  return composeFaq(generated, settings);
}
