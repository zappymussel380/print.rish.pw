import { describe, expect, it } from "vitest";
import {
  MIN_PRINTABLE_DIMENSION_MM,
  WRONG_SCALE_MAX_DIMENSION_MM,
  WRONG_SCALE_TRIANGLE_COUNT,
  looksWrongScale,
} from "@print/shared";

describe("looksWrongScale", () => {
  it("rejects a model below the minimum printable size regardless of detail", () => {
    expect(looksWrongScale({ x: 2.8, y: 4.2, z: 2.6 }, 393_540)).toBe(true);
    expect(looksWrongScale({ x: 1.4, y: 2.8, z: 1.8 }, 12)).toBe(true);
  });

  it("rejects a charm-sized model carrying sculpt-level triangle counts", () => {
    // Real wrong-scale exports observed in production (2026-07-14).
    expect(looksWrongScale({ x: 7.5, y: 9.6, z: 2.8 }, 785_538)).toBe(true);
    expect(looksWrongScale({ x: 4.8, y: 6.6, z: 3.6 }, 1_100_798)).toBe(true);
  });

  it("accepts a small but plausibly intentional part", () => {
    // Sliced successfully in production despite its high triangle count.
    expect(looksWrongScale({ x: 17.8, y: 33.4, z: 27.2 }, 467_120)).toBe(false);
    // A simple 5 mm spacer-style part.
    expect(looksWrongScale({ x: 5, y: 5, z: 2 }, 200)).toBe(false);
  });

  it("accepts ordinary models", () => {
    expect(looksWrongScale({ x: 20, y: 20, z: 20 }, 12)).toBe(false);
    expect(looksWrongScale({ x: 120, y: 90, z: 150 }, 800_000)).toBe(false);
  });

  it("treats the documented thresholds as exclusive bounds", () => {
    const atMinimum = { x: MIN_PRINTABLE_DIMENSION_MM, y: 1, z: 1 };
    expect(looksWrongScale(atMinimum, WRONG_SCALE_TRIANGLE_COUNT)).toBe(false);
    const underDetailCap = { x: WRONG_SCALE_MAX_DIMENSION_MM - 0.1, y: 1, z: 1 };
    expect(looksWrongScale(underDetailCap, WRONG_SCALE_TRIANGLE_COUNT + 1)).toBe(true);
    const atDetailCap = { x: WRONG_SCALE_MAX_DIMENSION_MM, y: 1, z: 1 };
    expect(looksWrongScale(atDetailCap, WRONG_SCALE_TRIANGLE_COUNT + 1)).toBe(false);
  });
});
