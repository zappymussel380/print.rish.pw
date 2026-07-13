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
  attemptId: string;
  modelId: string;
  fileHash: string;
  settingsKey: string;
  settings: SliceSettings;
}

/** Deterministic BullMQ job id for one database attempt. Requests for the same
 * attempt dedupe, while a retry gets a distinct id so it cannot be swallowed
 * by an older job that is still leaving BullMQ's active state. Must be
 * colon-free because BullMQ uses `:` as a Redis key separator. */
export function sliceJobId(fileHash: string, key: string, attemptId: string): string {
  return `slice_${fileHash}_${key.replace(/:/g, "-")}_${attemptId}`;
}

export function sliceJobIdFor(
  fileHash: string,
  format: ModelFormat,
  settings: SliceSettings,
  attemptId: string,
): string {
  return sliceJobId(fileHash, sliceArtifactKey(format, settings), attemptId);
}
