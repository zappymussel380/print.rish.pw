import { cache } from "react";
import { type Prisma, prisma } from "@print/db";
import { normalizeRetention, toRetentionPolicy, type RetentionPolicy, type RetentionSettings } from "@print/shared";
import { env } from "./env";

/** Key of the JSON row in `AppSetting` the worker's sweep reads too. */
export const RETENTION_KEY = "retention";

/** The environment's policy, in days: what applies until admin saves one. */
export function envRetention(): RetentionSettings {
  return {
    uploadRetentionDays: Math.max(1, Math.round(env.uploadRetentionHours / 24)),
    fileRetentionDays: env.fileRetentionDays,
    quotationRetentionDays: env.quotationRetentionDays,
  };
}

/** The environment's policy in the sweep's own units (hours for uploads). */
function envPolicy(): RetentionPolicy {
  return {
    uploadRetentionHours: env.uploadRetentionHours,
    fileRetentionDays: env.fileRetentionDays,
    quotationRetentionDays: env.quotationRetentionDays,
  };
}

/** The policy in force, where it comes from, and in the sweep's units (so the
 *  FAQ says exactly what the worker does). */
export const getRetention = cache(
  async (): Promise<{ settings: RetentionSettings; saved: boolean; policy: RetentionPolicy }> => {
    const fallback = envRetention();
    try {
      const row = await prisma.appSetting.findUnique({ where: { key: RETENTION_KEY } });
      const saved = normalizeRetention(row?.value ?? null, fallback);
      return saved
        ? { settings: saved, saved: true, policy: toRetentionPolicy(saved) }
        : { settings: fallback, saved: false, policy: envPolicy() };
    } catch {
      return { settings: fallback, saved: false, policy: envPolicy() };
    }
  },
);

export async function saveRetention(settings: RetentionSettings): Promise<void> {
  const value = settings as unknown as Prisma.InputJsonObject;
  await prisma.appSetting.upsert({
    where: { key: RETENTION_KEY },
    create: { key: RETENTION_KEY, value },
    update: { value },
  });
}

const FINISHED = ["COMPLETED", "DELIVERED", "CANCELLED"] as const;

/** What a purge of everything older than `days` would remove — the same
 *  selection the worker's purge makes (uploads never quoted; files of models
 *  whose every quotation finished more than `days` ago). */
export async function purgePreview(days: number): Promise<{ uploads: number; finishedFiles: number }> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const [uploads, finishedFiles] = await Promise.all([
    prisma.uploadedModel.count({ where: { createdAt: { lt: cutoff }, items: { none: {} } } }),
    prisma.uploadedModel.count({
      where: {
        storedPath: { not: "" },
        items: { some: {}, every: { quotation: { status: { in: [...FINISHED] }, updatedAt: { lt: cutoff } } } },
      },
    }),
  ]);
  return { uploads, finishedFiles };
}
