// Zod-free: the admin editor, the worker and the FAQ all use it.

/**
 * How long the shop keeps customer files and finished quotations — admin →
 * Settings → File clean-up, stored as one JSON app setting. Until it's saved
 * the environment (UPLOAD_RETENTION_HOURS, FILE_RETENTION_DAYS,
 * QUOTATION_RETENTION_DAYS) decides, as before.
 */
export interface RetentionSettings {
  /** Uploads never turned into a quotation are deleted after this many days. */
  uploadRetentionDays: number;
  /** Model files of finished (completed, delivered, cancelled) quotations are
   *  deleted this many days after they finished; the quotation stays. */
  fileRetentionDays: number;
  /** Finished quotations themselves are deleted after this many days; null
   *  keeps them for good. */
  quotationRetentionDays: number | null;
}

export const RETENTION_BOUNDS = {
  uploadRetentionDays: { min: 1, max: 365 },
  fileRetentionDays: { min: 1, max: 3650 },
  quotationRetentionDays: { min: 7, max: 3650 },
  purgeOlderThanDays: { min: 1, max: 3650 },
} as const;

/** What the sweep needs, in the units it works in. */
export interface RetentionPolicy {
  uploadRetentionHours: number;
  fileRetentionDays: number;
  quotationRetentionDays: number | null;
}

/** The maintenance queue: the daily sweep and the admin's "purge now". */
export const MAINTENANCE_QUEUE = "maintenance";

/** A purge the admin asked for: only uploads and finished quotations' files,
 *  older than the given days. Quotation records are never touched. */
export interface PurgeJobData {
  kind: "purge";
  olderThanDays: number;
}

const int = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;

/** A stored blob, hardened against `fallback` (the environment's policy):
 *  null when nothing is stored. A field that doesn't validate keeps the
 *  fallback's value. */
export function normalizeRetention(raw: unknown, fallback: RetentionSettings): RetentionSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const B = RETENTION_BOUNDS;
  return {
    uploadRetentionDays: int(r.uploadRetentionDays, B.uploadRetentionDays.min, B.uploadRetentionDays.max) ?? fallback.uploadRetentionDays,
    fileRetentionDays: int(r.fileRetentionDays, B.fileRetentionDays.min, B.fileRetentionDays.max) ?? fallback.fileRetentionDays,
    quotationRetentionDays:
      r.quotationRetentionDays === null
        ? null
        : (int(r.quotationRetentionDays, B.quotationRetentionDays.min, B.quotationRetentionDays.max) ?? fallback.quotationRetentionDays),
  };
}

/** Admin-facing days → the sweep's units. */
export function toRetentionPolicy(settings: RetentionSettings): RetentionPolicy {
  return {
    uploadRetentionHours: settings.uploadRetentionDays * 24,
    fileRetentionDays: settings.fileRetentionDays,
    quotationRetentionDays: settings.quotationRetentionDays,
  };
}
