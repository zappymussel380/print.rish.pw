import type { SliceResult } from "@print/db";
import type { SliceJobStage } from "@print/shared";

export interface SliceStatusDto {
  sliceId: string;
  status: SliceJobStage;
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

/** Map a SliceResult cache row into the client-facing polling shape. */
export function serializeSlice(row: SliceResult): SliceStatusDto {
  const done = row.status === "DONE" && row.filamentGrams != null;
  return {
    sliceId: row.id,
    status: STAGE[row.status],
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
