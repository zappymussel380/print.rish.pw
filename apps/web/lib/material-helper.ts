import { cache } from "react";
import { type Prisma, prisma } from "@print/db";
import {
  defaultMaterialHelper,
  normalizeMaterialHelper,
  toPublicMaterialHelper,
  type Availability,
  type MaterialHelperSettings,
  type MaterialId,
  type PublicMaterialHelper,
} from "@print/shared";

/** Key of the JSON row in `AppSetting` holding admin → Filament → Material helper. */
export const MATERIAL_HELPER_KEY = "materialHelper";

/** The helper's settings; the defaults when nothing is saved or it can't be read. */
export const getMaterialHelper = cache(async (): Promise<MaterialHelperSettings> => {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: MATERIAL_HELPER_KEY } });
    return row ? normalizeMaterialHelper(row.value) : defaultMaterialHelper();
  } catch {
    return defaultMaterialHelper();
  }
});

/** What the quote page gets, for the materials customers can pick right now. */
export function toPublicHelper(settings: MaterialHelperSettings, availability: Availability): PublicMaterialHelper | null {
  const offered = (Object.keys(availability.materials) as MaterialId[]).filter((id) => availability.materials[id]);
  return toPublicMaterialHelper(settings, offered);
}

export async function saveMaterialHelper(settings: MaterialHelperSettings): Promise<void> {
  const value = settings as unknown as Prisma.InputJsonObject;
  await prisma.appSetting.upsert({
    where: { key: MATERIAL_HELPER_KEY },
    create: { key: MATERIAL_HELPER_KEY, value },
    update: { value },
  });
}
