import type { SliceSettings } from "./quote-types";
import { settingsKey } from "./settings-key";

/** BullMQ queue name shared by the web enqueuer and the worker consumer. */
export const SLICE_QUEUE = "slice";

/** Payload handed to the worker. `storedPath` is resolved on the shared uploads
 *  volume, which both containers mount at the same path. */
export interface SliceJobData {
  sliceResultId: string;
  modelId: string;
  fileHash: string;
  settingsKey: string;
  storedPath: string;
  format: string;
  settings: SliceSettings;
}

/** Deterministic BullMQ job id → identical (file, settings) requests dedupe to
 *  one job. Must be colon-free: BullMQ uses `:` as a Redis key separator, so we
 *  flatten the settings key's colons to dashes. */
export function sliceJobId(fileHash: string, key: string): string {
  return `slice_${fileHash}_${key.replace(/:/g, "-")}`;
}

export function sliceJobIdFor(fileHash: string, settings: SliceSettings): string {
  return sliceJobId(fileHash, settingsKey(settings));
}
