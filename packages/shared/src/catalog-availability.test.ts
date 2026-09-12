import { describe, expect, it } from "vitest";
import { COLOUR_IDS, MATERIAL_IDS } from "./quote-types";
import {
  MASTER_COLOURS,
  MATERIAL_COLOURS,
  DEFAULT_ENABLED_COLOURS,
  DEFAULT_ENABLED_MATERIALS,
  swatchBackground,
} from "./colours";
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

  it("carries the full Numakers range in each tier", () => {
    // A regression anchor for the catalogue itself (vendor snapshot 2026-09-12).
    expect(MATERIAL_COLOURS.PLA).toHaveLength(40);
    expect(MATERIAL_COLOURS.PLA_AESTHETIC).toHaveLength(70);
    expect(MATERIAL_COLOURS.PLA_CF).toHaveLength(4);
    expect(MATERIAL_COLOURS.PETG).toHaveLength(17);
    expect(MATERIAL_COLOURS.PETG_PREMIUM).toHaveLength(19);
  });

  it("PETG basics are a subset of PLA's; premium tiers share no id with any other tier", () => {
    const pla = new Set(MATERIAL_COLOURS.PLA);
    for (const id of MATERIAL_COLOURS.PETG) expect(pla.has(id)).toBe(true);
    for (const premium of ["PLA_AESTHETIC", "PLA_CF", "PETG_PREMIUM"] as const) {
      for (const id of MATERIAL_COLOURS[premium]) {
        expect(MASTER_COLOURS[id].materials).toEqual([premium]);
      }
    }
  });

  it("defaults are within each palette", () => {
    for (const m of MATERIAL_IDS) {
      const universe = new Set(MATERIAL_COLOURS[m]);
      for (const id of DEFAULT_ENABLED_COLOURS[m]) expect(universe.has(id)).toBe(true);
    }
  });

  it("multi-colour stops are real hexes that start at the swatch colour", () => {
    const multi = Object.values(MASTER_COLOURS).filter((c) => c.stops);
    expect(multi).toHaveLength(14);
    for (const c of multi) {
      expect(c.stops!.length).toBeGreaterThanOrEqual(2);
      for (const s of c.stops!) expect(s).toMatch(/^#[0-9A-F]{6}$/);
      expect(c.stops![0]).toBe(c.hex);
    }
    expect(swatchBackground(MASTER_COLOURS["dual-red-gold"])).toBe(
      "linear-gradient(135deg, #A4403E, #D4AF37)",
    );
    expect(swatchBackground(MASTER_COLOURS["silk-copper"])).toBe("#CA7031");
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

  it("ships the premium tiers switched off with no colours", () => {
    const def = defaultAvailability();
    for (const m of ["PLA_AESTHETIC", "PLA_CF", "PETG_PREMIUM"] as const) {
      expect(DEFAULT_ENABLED_MATERIALS[m]).toBe(false);
      expect(def.materials[m]).toBe(false);
      expect(def.colours[m]).toEqual([]);
    }
  });

  it("leaves new tiers off, and the operator's picks intact, for a blob saved before they existed", () => {
    // The exact shape production has stored since the catalog editor shipped.
    const norm = normalizeAvailability({
      materials: { PLA: true, PETG: true },
      colours: { PLA: ["royal-blue", "magenta"], PETG: ["pitch-black"] },
    });
    expect(norm.materials).toEqual({
      PLA: true,
      PLA_AESTHETIC: false,
      PLA_CF: false,
      PETG: true,
      PETG_PREMIUM: false,
    });
    expect(norm.colours.PLA).toEqual(["royal-blue", "magenta"]);
    expect(norm.colours.PETG).toEqual(["pitch-black"]);
    expect(norm.colours.PLA_AESTHETIC).toEqual([]);
  });

  it("keeps a premium colour only in its own tier", () => {
    const norm = normalizeAvailability({
      materials: { PLA_AESTHETIC: true },
      colours: { PLA_AESTHETIC: ["silk-copper", "pitch-black"], PLA: ["silk-copper"] },
    });
    expect(norm.materials.PLA_AESTHETIC).toBe(true);
    expect(norm.colours.PLA_AESTHETIC).toEqual(["silk-copper"]);
    expect(norm.colours.PLA).toEqual([]);
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

  it("labels materials for humans and sends gradient stops only where they exist", () => {
    const pub = toPublicCatalog(defaultAvailability());
    expect(pub.materials.map((m) => m.name)).toEqual([
      "PLA",
      "Aesthetic PLA",
      "PLA-CF",
      "PETG",
      "PETG Premium",
    ]);
    const aesthetic = pub.materials.find((m) => m.id === "PLA_AESTHETIC")!;
    expect(aesthetic.colours.find((c) => c.id === "tri-red-orange-gold")!.stops).toHaveLength(3);
    expect(aesthetic.colours.find((c) => c.id === "silk-copper")).not.toHaveProperty("stops");
  });
});
