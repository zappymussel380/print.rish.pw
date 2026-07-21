import { describe, expect, it } from "vitest";
import { COLOUR_IDS, MATERIAL_IDS } from "./quote-types";
import { MASTER_COLOURS, MATERIAL_COLOURS, DEFAULT_ENABLED_COLOURS } from "./colours";
import {
  assertConfigAvailable,
  defaultAvailability,
  firstEnabledColour,
  isColourEnabled,
  normalizeAvailability,
  toPublicCatalog,
} from "./catalog-availability";

describe("colour palette integrity", () => {
  it("has a MASTER_COLOURS entry for every COLOUR_ID and vice versa", () => {
    expect(new Set(Object.keys(MASTER_COLOURS))).toEqual(new Set(COLOUR_IDS));
    for (const def of Object.values(MASTER_COLOURS)) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("PETG palette is a subset of PLA's, and defaults are within each palette", () => {
    const pla = new Set(MATERIAL_COLOURS.PLA);
    for (const id of MATERIAL_COLOURS.PETG) expect(pla.has(id)).toBe(true);
    for (const m of MATERIAL_IDS) {
      const universe = new Set(MATERIAL_COLOURS[m]);
      for (const id of DEFAULT_ENABLED_COLOURS[m]) expect(universe.has(id)).toBe(true);
    }
  });

  it("legacy black/white are accepted ids but offered in no material", () => {
    expect(MASTER_COLOURS.black.materials).toHaveLength(0);
    expect(MATERIAL_COLOURS.PLA).not.toContain("black");
  });
});

describe("normalizeAvailability", () => {
  it("returns the safe default for missing/garbage input", () => {
    const def = defaultAvailability();
    expect(normalizeAvailability(null)).toEqual(def);
    expect(normalizeAvailability("nonsense")).toEqual(def);
    expect(def.materials.PLA).toBe(true);
    expect(def.colours.PLA).toEqual(["pitch-black", "pure-white"]);
  });

  it("keeps only real colours for a material and dedupes", () => {
    const norm = normalizeAvailability({
      materials: { PLA: false, PETG: true },
      colours: { PLA: ["pitch-black", "pitch-black", "not-a-colour", "royal-blue"] },
    });
    expect(norm.materials.PLA).toBe(false);
    expect(norm.colours.PLA).toEqual(["pitch-black", "royal-blue"]);
  });
});

describe("assertConfigAvailable", () => {
  const avail = normalizeAvailability({
    materials: { PLA: true, PETG: false },
    colours: { PLA: ["pitch-black", "royal-blue"] },
  });

  it("rejects a disabled material", () => {
    const r = assertConfigAvailable({ material: "PETG", colour: "pitch-black" }, avail);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MATERIAL_UNAVAILABLE");
  });

  it("rejects a colour not enabled for the material", () => {
    const r = assertConfigAvailable({ material: "PLA", colour: "magenta" }, avail);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("COLOUR_UNAVAILABLE");
  });

  it("accepts an enabled material+colour, and resolves legacy ids", () => {
    expect(assertConfigAvailable({ material: "PLA", colour: "royal-blue" }, avail).ok).toBe(true);
    // legacy "black" aliases to the enabled pitch-black
    expect(isColourEnabled(avail, "PLA", "black")).toBe(true);
    expect(assertConfigAvailable({ material: "PLA", colour: "black" }, avail).ok).toBe(true);
  });

  it("skips the colour check when no colour is supplied (slice settings)", () => {
    expect(assertConfigAvailable({ material: "PLA" }, avail).ok).toBe(true);
  });
});

describe("toPublicCatalog / firstEnabledColour", () => {
  it("exposes per-item enabled flags over the full palette", () => {
    const avail = normalizeAvailability({
      materials: { PLA: true, PETG: false },
      colours: { PLA: ["royal-blue"] },
    });
    const pub = toPublicCatalog(avail);
    const pla = pub.materials.find((m) => m.id === "PLA")!;
    expect(pla.enabled).toBe(true);
    expect(pla.colours.length).toBe(MATERIAL_COLOURS.PLA.length);
    expect(pla.colours.find((c) => c.id === "royal-blue")!.enabled).toBe(true);
    expect(pla.colours.find((c) => c.id === "magenta")!.enabled).toBe(false);
    expect(pub.materials.find((m) => m.id === "PETG")!.enabled).toBe(false);
    expect(firstEnabledColour(avail, "PLA")).toBe("royal-blue");
  });
});
