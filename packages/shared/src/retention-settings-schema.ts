import { z } from "zod";
import { RETENTION_BOUNDS } from "./retention-settings";

const B = RETENTION_BOUNDS;
const days = (b: { min: number; max: number }) => z.number().int().min(b.min).max(b.max);

/** What admin → Settings → File clean-up sends. */
export const retentionInputSchema = z.object({
  uploadRetentionDays: days(B.uploadRetentionDays),
  fileRetentionDays: days(B.fileRetentionDays),
  quotationRetentionDays: days(B.quotationRetentionDays).nullable(),
});

export const purgeInputSchema = z.object({ olderThanDays: days(B.purgeOlderThanDays) });
