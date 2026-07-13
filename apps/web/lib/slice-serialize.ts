import type { SliceResult } from "@print/db";
import {
  sliceProgressStages,
  type SliceJobStage,
  type SliceProgress,
  type SliceProgressStage,
} from "@print/shared";

export interface SliceStatusDto {
  sliceId: string;
  status: SliceJobStage;
  progress: SliceProgress;
  result: {
    filamentGrams: number;
    filamentMm: number;
    printSeconds: number;
    supportGrams: number | null;
  } | null;
  error: { code: string; message: string } | null;
}

const STAGE: Record<SliceResult["status"], SliceJobStage> = {
  QUEUED: "queued",
  RUNNING: "slicing",
  DONE: "done",
  FAILED: "failed",
};

const PROGRESS_STAGES = new Set<string>(sliceProgressStages);

function serializeProgress(row: SliceResult): SliceProgress {
  if (row.status === "DONE") {
    return { percent: 100, stage: "complete", message: "Quote data ready" };
  }
  if (row.status === "FAILED") {
    return { percent: Math.min(99, Math.max(0, row.progressPct)), stage: "failed", message: "Slicing failed" };
  }
  const fallbackStage: SliceProgressStage = row.status === "QUEUED" ? "queued" : "slicing";
  const stage = PROGRESS_STAGES.has(row.progressStage)
    ? (row.progressStage as SliceProgressStage)
    : fallbackStage;
  // eslint-disable-next-line no-control-regex
  const rawMessage = row.progressMessage.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return {
    percent: Math.min(99, Math.max(0, Math.round(row.progressPct))),
    stage,
    message: (rawMessage || (row.status === "QUEUED" ? "Waiting for a slicer" : "Slicing model")).slice(0, 120),
  };
}

/** Map a SliceResult cache row into the client-facing polling shape. */
export function serializeSlice(row: SliceResult): SliceStatusDto {
  const done = row.status === "DONE" && row.filamentGrams != null;
  return {
    sliceId: row.id,
    status: STAGE[row.status],
    progress: serializeProgress(row),
    result: done
      ? {
          filamentGrams: Number(row.filamentGrams),
          filamentMm: Number(row.filamentMm),
          printSeconds: row.printSeconds ?? 0,
          supportGrams: row.supportGrams != null ? Number(row.supportGrams) : null,
        }
      : null,
    error:
      row.status === "FAILED"
        ? { code: row.errorCode ?? "SLICE_FAILED", message: row.errorMessage ?? "Slicing failed" }
        : null,
  };
}
