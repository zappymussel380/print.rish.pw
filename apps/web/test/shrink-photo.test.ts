import { describe, expect, it } from "vitest";
import { KEEP_PNG_UNDER_BYTES, SHOWCASE_MAX_EDGE_PX, fitWithin, needsReencode } from "@/lib/shrink-photo";

describe("fitWithin", () => {
  it("scales a portrait phone photo to the max edge, keeping the aspect ratio", () => {
    expect(fitWithin(1440, 2560, 1600)).toEqual({ width: 900, height: 1600 });
  });

  it("scales landscape by its width", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
  });

  it("leaves a photo that already fits alone", () => {
    expect(fitWithin(1200, 1600, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(640, 480, 1600)).toEqual({ width: 640, height: 480 });
  });

  it("never rounds a side down to zero", () => {
    expect(fitWithin(10000, 2, 1600)).toEqual({ width: 1600, height: 1 });
  });
});

describe("needsReencode", () => {
  it("always re-encodes JPEGs, so the camera's rotation is baked in", () => {
    expect(needsReencode("image/jpeg", 50_000, 800, 600)).toBe(true);
  });

  it("keeps a small PNG that already fits (transparency survives)", () => {
    expect(needsReencode("image/png", 200_000, 1200, 900)).toBe(false);
  });

  it("re-encodes a PNG that is too big in bytes or pixels", () => {
    expect(needsReencode("image/png", KEEP_PNG_UNDER_BYTES + 1, 1200, 900)).toBe(true);
    expect(needsReencode("image/png", 200_000, SHOWCASE_MAX_EDGE_PX + 1, 900)).toBe(true);
  });
});
