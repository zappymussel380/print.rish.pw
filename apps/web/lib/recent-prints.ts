import { cache } from "react";
import { Prisma, prisma } from "@print/db";
import {
  normalizeRecentPrints,
  type RecentPrint,
  type RecentPrintsInput,
} from "@print/shared";

/** Key of the single JSON row in `AppSetting` that stores the showcase. */
export const RECENT_PRINTS_KEY = "recentPrints";

/** The current showcase, hardened against missing/invalid data. `cache()`
 *  dedupes the read within a single request (page + its API calls). */
export const getRecentPrints = cache(async (): Promise<RecentPrint[]> => {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: RECENT_PRINTS_KEY } });
    return normalizeRecentPrints(row?.value ?? null);
  } catch {
    // A gallery is decoration. A read failure must never take the homepage
    // down with it — show nothing and carry on.
    return [];
  }
});

/** Persist a new showcase (admin only). Normalized before storage, so the
 *  stored row is always valid and free of unusable entries. */
export async function saveRecentPrints(input: RecentPrintsInput): Promise<RecentPrint[]> {
  const normalized = normalizeRecentPrints(input);
  const value = { prints: normalized } as unknown as Prisma.InputJsonObject;
  await prisma.appSetting.upsert({
    where: { key: RECENT_PRINTS_KEY },
    create: { key: RECENT_PRINTS_KEY, value },
    update: { value },
  });
  return normalized;
}
