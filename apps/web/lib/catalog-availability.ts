import { cache } from "react";
import { Prisma, prisma } from "@print/db";
import {
  CUSTOM_FILAMENT_SLOTS,
  CUSTOM_MATERIAL_IDS,
  cleanCustomGuide,
  cleanCustomMaterialName,
  effectiveAvailability,
  normalizeAvailability,
  slotMaterial,
  type Availability,
  type AvailabilityInput,
  type CustomMaterialGuide,
  type CustomMaterialId,
  type ProfileSlot,
} from "@print/shared";

/** Key of the single JSON row in `AppSetting` that stores catalog availability. */
export const CATALOG_AVAILABILITY_KEY = "catalogAvailability";

/** Availability exactly as the owner saved it (the admin editors' view).
 *  `cache()` dedupes the read within a single request (page + its API calls). */
export const getStoredCatalogAvailability = cache(async (): Promise<Availability> => {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: CATALOG_AVAILABILITY_KEY } });
    return normalizeAvailability(row?.value ?? null);
  } catch {
    // A read failure must never take the quote/pricing pages down — fall back to
    // the safe defaults (all materials on, black/white only).
    return normalizeAvailability(null);
  }
});

/** The shop's own materials that have a live, test-sliced filament profile. */
export const getReadyCustomMaterials = cache(async (): Promise<ReadonlySet<CustomMaterialId>> => {
  try {
    const rows = await prisma.slicerProfileUpload.findMany({
      where: { status: "ACTIVE", slot: { in: [...CUSTOM_FILAMENT_SLOTS] } },
      select: { slot: true },
    });
    return new Set(rows.flatMap((r) => (r.slot ? [slotMaterial(r.slot as ProfileSlot) as CustomMaterialId] : [])));
  } catch {
    // Unknown means not ready: a custom material is never offered on a guess.
    return new Set();
  }
});

/** Current material/colour availability as customers get it: stored, with the
 *  shop's own materials off until they're named and have a live profile. */
export const getCatalogAvailability = cache(async (): Promise<Availability> => {
  const [stored, ready] = await Promise.all([getStoredCatalogAvailability(), getReadyCustomMaterials()]);
  return effectiveAvailability(stored, ready);
});

async function writeAvailability(normalized: Availability): Promise<Availability> {
  const value = normalized as unknown as Prisma.InputJsonObject;
  await prisma.appSetting.upsert({
    where: { key: CATALOG_AVAILABILITY_KEY },
    create: { key: CATALOG_AVAILABILITY_KEY, value },
    update: { value },
  });
  return normalized;
}

/** Persist a new availability blob (admin only). Input is normalized before
 *  storage so the stored row is always valid and free of stray colours. The
 *  names of the shop's own materials have their own editor, so they're always
 *  kept from what's stored — a Catalog save can't undo a rename. */
export async function saveCatalogAvailability(input: AvailabilityInput): Promise<Availability> {
  const stored = await getStoredCatalogAvailability();
  const normalized = normalizeAvailability(input);
  return writeAvailability({ ...normalized, customMaterials: stored.customMaterials });
}

/** Rename the shop's own materials, or change the copy /materials shows for
 *  them (admin only). An empty name clears one, which also takes it off sale
 *  and drops its copy; a guide of blanks clears the copy. When a name or guide
 *  isn't usable nothing is saved and the offending slots come back as
 *  `invalid` (a guide needs its material named first). Both land in one write:
 *  the stored read is cached per request, so two saves would lose the first. */
export async function saveCustomMaterials(input: {
  names?: Partial<Record<CustomMaterialId, string>>;
  guides?: Partial<Record<CustomMaterialId, CustomMaterialGuide>>;
}): Promise<Availability | { invalid: CustomMaterialId[] }> {
  const stored = await getStoredCatalogAvailability();
  const next: Availability = { ...stored, materials: { ...stored.materials }, customMaterials: { ...stored.customMaterials } };
  const invalid: CustomMaterialId[] = [];
  for (const id of CUSTOM_MATERIAL_IDS) {
    const raw = input.names?.[id];
    if (raw === undefined) continue;
    if (raw.trim() === "") {
      delete next.customMaterials[id];
      next.materials[id] = false;
      continue;
    }
    const name = cleanCustomMaterialName(raw);
    if (!name) invalid.push(id);
    else next.customMaterials[id] = { ...next.customMaterials[id], name };
  }
  for (const id of CUSTOM_MATERIAL_IDS) {
    const raw = input.guides?.[id];
    if (raw === undefined) continue;
    const current = next.customMaterials[id];
    const blank = Object.values(raw).every((v) => typeof v !== "string" || v.trim() === "");
    if (blank) {
      if (current) next.customMaterials[id] = { name: current.name };
      continue;
    }
    const guide = cleanCustomGuide(raw);
    if (!current || !guide) invalid.push(id);
    else next.customMaterials[id] = { name: current.name, guide };
  }
  if (invalid.length) return { invalid: [...new Set(invalid)] };
  return writeAvailability(next);
}
