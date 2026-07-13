import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_CONFIG, settingsKey } from "@print/shared";
import { computePricing } from "@/lib/pricing-client";
import { type QuoteModel, sliceCacheKey } from "@/lib/quote-store";

const READY_ID = "11111111-1111-4111-8111-111111111111";

function pending(status: "uploading" | "queued" | "processing" | "error"): QuoteModel {
  return {
    key: `client-${status}`,
    fileName: `${status}.stl`,
    sizeBytes: 84,
    status,
    progress: status === "uploading" ? 0.5 : 1,
    ...(status === "queued" || status === "processing"
      ? { ticket: "22222222-2222-4222-8222-222222222222" }
      : {}),
    ...(status === "error" ? { error: "Could not inspect model" } : {}),
    config: { ...DEFAULT_MODEL_CONFIG },
  };
}

const ready: QuoteModel = {
  key: READY_ID,
  fileName: "ready.stl",
  sizeBytes: 84,
  status: "ready",
  progress: 1,
  config: { ...DEFAULT_MODEL_CONFIG },
  server: {
    id: READY_ID,
    originalName: "ready.stl",
    format: "stl",
    sizeBytes: 84,
    bboxMm: { x: 10, y: 10, z: 10 },
    volumeCm3: 1,
    fitsBed: true,
  },
};

const slices = {
  [sliceCacheKey(READY_ID, settingsKey(DEFAULT_MODEL_CONFIG))]: {
    status: "done" as const,
    result: {
      filamentGrams: 10,
      filamentMm: 3000,
      printSeconds: 3600,
      supportGrams: null,
    },
  },
};

describe("pricing while upload ingest is pending", () => {
  it.each(["uploading", "queued", "processing"] as const)(
    "reports %s separately even when another model already has a price",
    (status) => {
      const result = computePricing([ready, pending(status)], slices);

      expect(result.breakdown).not.toBeNull();
      expect(result.priced).toBe(1);
      expect(result.ingesting).toBe(1);
    },
  );

  it("does not keep checkout blocked for a terminal upload error", () => {
    const result = computePricing([ready, pending("error")], slices);

    expect(result.breakdown).not.toBeNull();
    expect(result.ingesting).toBe(0);
  });
});
