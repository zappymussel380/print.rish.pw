import { describe, expect, it } from "vitest";
import {
  MAX_CAPTION_LENGTH,
  MAX_RECENT_PRINTS,
  normalizeRecentPrints,
} from "./recent-prints";

const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);

const print = (overrides: Record<string, unknown> = {}) => ({
  id: id(1),
  caption: "Cable clip",
  material: "PLA",
  photoExt: "jpg",
  createdAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

describe("normalizeRecentPrints", () => {
  it("returns nothing for absent or unparseable storage", () => {
    expect(normalizeRecentPrints(null)).toEqual([]);
    expect(normalizeRecentPrints({ prints: "not an array" })).toEqual([]);
    expect(normalizeRecentPrints(42)).toEqual([]);
  });

  it("keeps a well-formed entry intact and preserves list order", () => {
    const result = normalizeRecentPrints({
      prints: [print({ id: id(2), caption: "Second" }), print({ id: id(1), caption: "First" })],
    });
    expect(result.map((p) => p.caption)).toEqual(["Second", "First"]);
    expect(result[0]).toMatchObject({ material: "PLA", photoExt: "jpg" });
  });

  it("drops entries that could not address a real photo on disk", () => {
    const result = normalizeRecentPrints({
      prints: [
        print({ id: "../../etc/passwd" }),
        print({ id: id(2), photoExt: "svg" }),
        print({ id: id(3), material: "TITANIUM" }),
        print({ id: id(4) }),
      ],
    });
    expect(result.map((p) => p.id)).toEqual([id(4)]);
  });

  it("drops a duplicate id rather than serving one photo twice", () => {
    const result = normalizeRecentPrints({
      prints: [print({ caption: "Original" }), print({ caption: "Duplicate" })],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.caption).toBe("Original");
  });

  it("requires a caption, because it is the photo's alt text", () => {
    expect(normalizeRecentPrints({ prints: [print({ caption: "   " })] })).toEqual([]);
  });

  it("collapses whitespace and clamps an overlong caption", () => {
    const result = normalizeRecentPrints({
      prints: [print({ caption: `  spaced   out ${"x".repeat(400)}` })],
    });
    expect(result[0]!.caption).toHaveLength(MAX_CAPTION_LENGTH);
    expect(result[0]!.caption.startsWith("spaced out ")).toBe(true);
  });

  it("caps the list so the showcase stays a showcase", () => {
    const prints = Array.from({ length: MAX_RECENT_PRINTS + 10 }, (_, i) =>
      print({ id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000` }),
    );
    expect(normalizeRecentPrints({ prints })).toHaveLength(MAX_RECENT_PRINTS);
  });

  it("replaces an unusable createdAt rather than dropping the entry", () => {
    const result = normalizeRecentPrints({ prints: [print({ createdAt: "whenever" })] });
    expect(result).toHaveLength(1);
    expect(Number.isFinite(Date.parse(result[0]!.createdAt))).toBe(true);
  });
});
