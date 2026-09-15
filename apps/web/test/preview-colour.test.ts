import { describe, expect, it } from "vitest";
import { previewColour, tintThumbPixels } from "@/lib/preview-colour";

describe("previewColour", () => {
  it("keeps mid colours, lifts near-black and tames white so shading still shows", () => {
    expect(previewColour("#2360c4")).toBe("#2360c4");
    const black = previewColour("#141414")!;
    expect(black).toBe("#383838");
    expect(previewColour("#ffffff")).toBe("#e0e0e0");
    // Hue survives the lift: a dark red stays red.
    const darkRed = previewColour("#300000")!;
    expect(Number.parseInt(darkRed.slice(1, 3), 16)).toBeGreaterThan(Number.parseInt(darkRed.slice(3, 5), 16));
  });

  it("refuses what isn't a colour", () => {
    expect(previewColour(undefined)).toBeNull();
    expect(previewColour("red")).toBeNull();
  });
});

describe("tintThumbPixels", () => {
  it("turns the renderer's grey into the colour, shaded the same, and leaves the background", () => {
    const px = new Uint8ClampedArray([205, 209, 214, 255, 102, 104, 107, 255, 0, 0, 0, 0]);
    tintThumbPixels(px, "#2360c4");
    expect([...px.slice(0, 3)]).toEqual([35, 96, 196]);
    expect([...px.slice(4, 7)]).toEqual([17, 48, 98]);
    expect([...px.slice(8, 12)]).toEqual([0, 0, 0, 0]);
  });
});
