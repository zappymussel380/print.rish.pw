import type { ModelFormat } from "./filename";
import type { SliceSettings } from "./quote-types";
import { sliceArtifactKey } from "./settings-key";

/** BullMQ queue name shared by the web enqueuer and the worker consumer. */
export const SLICE_QUEUE = "slice";

/** Payload handed to the worker. Paths and formats are deliberately absent:
 * the worker resolves those from the database and validates the generated path
 * before invoking the untrusted slicer. */
export interface SliceJobData {
  sliceResultId: string;
  modelId: string;
  fileHash: string;
  settingsKey: string;
  settings: SliceSettings;
}

/** Deterministic BullMQ job id → identical (file, settings) requests dedupe to
 *  one job. Must be colon-free: BullMQ uses `:` as a Redis key separator, so we
 *  flatten the settings key's colons to dashes. */
export function sliceJobId(fileHash: string, key: string): string {
  return `slice_${fileHash}_${key.replace(/:/g, "-")}`;
}

export function sliceJobIdFor(
  fileHash: string,
  format: ModelFormat,
  settings: SliceSettings,
): string {
  return sliceJobId(fileHash, sliceArtifactKey(format, settings));
}
