import type { SliceOutcome, OrcaProgress } from "./orca.js";

/** Deterministic, plausible measurements used only by the development/test
 * full-flow harness. The production guard lives in config.ts and fails worker
 * startup before any queue connection when STUB_SLICER is requested there. */
export async function runStubSlice(
  onProgress?: (progress: OrcaProgress) => void,
): Promise<SliceOutcome> {
  onProgress?.({ percent: 75, message: "Stub slicer produced test measurements" });
  return {
    ok: true,
    filamentGrams: 5,
    filamentMm: 1_670,
    printSeconds: 2_700,
    supportGrams: null,
    slicerVersion: "stub-slicer-v1",
    rawMeta: { stubSlicer: true },
  };
}
