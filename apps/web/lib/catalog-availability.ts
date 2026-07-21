import { cache } from "react";
import { Prisma, prisma } from "@print/db";
import {
  type Availability,
  type AvailabilityInput,
  normalizeAvailability,
} from "@print/shared";

/** Key of the single JSON row in `AppSetting` that stores catalog availability. */
export const CATALOG_AVAILABILITY_KEY = "catalogAvailability";

/** Current material/colour availability, hardened against missing/invalid data.
 *  `cache()` dedupes the read within a single request (page + its API calls). */
export const getCatalogAvailability = cache(async (): Promise<Availability> => {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: CATALOG_AVAILABILITY_KEY } });
    return normalizeAvailability(row?.value ?? null);
  } catch {
    // A read failure must never take the quote/pricing pages down — fall back to
    // the safe defaults (all materials on, black/white only).
    return normalizeAvailability(null);
  }
});

/** Persist a new availability blob (admin only). Input is normalized before
 *  storage so the stored row is always valid and free of stray colours. */
export async function saveCatalogAvailability(input: AvailabilityInput): Promise<Availability> {
  const normalized = normalizeAvailability(input);
  const value = normalized as unknown as Prisma.InputJsonObject;
  await prisma.appSetting.upsert({
    where: { key: CATALOG_AVAILABILITY_KEY },
    create: { key: CATALOG_AVAILABILITY_KEY, value },
    update: { value },
  });
  return normalized;
}
