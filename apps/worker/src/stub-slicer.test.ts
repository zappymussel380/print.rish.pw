import { describe, expect, it, vi } from "vitest";
import { runStubSlice } from "./stub-slicer";

describe("runStubSlice", () => {
  it("returns deterministic plausible measurements without invoking Orca", async () => {
    const onProgress = vi.fn();

    await expect(runStubSlice(onProgress)).resolves.toEqual({
      ok: true,
      filamentGrams: 5,
      filamentMm: 1_670,
      printSeconds: 2_700,
      supportGrams: null,
      slicerVersion: "stub-slicer-v1",
      rawMeta: { stubSlicer: true },
    });
    expect(onProgress).toHaveBeenCalledWith({
      percent: 75,
      message: "Stub slicer produced test measurements",
    });
  });
});
