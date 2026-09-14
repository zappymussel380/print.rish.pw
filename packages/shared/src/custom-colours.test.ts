import { describe, expect, it } from "vitest";
import { COLOUR_IDS, MATERIAL_IDS, DEFAULT_MODEL_CONFIG } from "./quote-types";
import { modelConfigSchema } from "./quote-schema";
import { MAX_CUSTOM_COLOURS, isCustomColourId, newCustomColourId } from "./custom-colours";
import { normalizeCustomColours } from "./custom-colours-schema";
import { assertConfigAvailable, resolveColourName, toPublicCatalog } from "./catalog-availability";
import { normalizeAvailability } from "./catalog-availability-schema";
import { MATERIAL_COLOURS } from "./colours";
import { filamentLine } from "./costs";
import { materialFamily } from "./catalog";
import { summariseItems } from "./order-summary";

const orange = { id: "custom-abs-signal-orange", name: "Signal Orange", hex: "#ff6a00", material: "ABS" };

describe("normalizeCustomColours", () => {
  it("keeps valid entries, upper-cases the hex and drops everything else", () => {
    const out = normalizeCustomColours([
      orange,
      { ...orange }, // duplicate id
      { id: "pitch-black", name: "Hijack", hex: "#000000", material: "PLA" }, // not a custom id
      { id: "custom-abs-bad", name: "Bad hex", hex: "orange", material: "ABS" },
      { id: "custom-nylon-x", name: "Nylon", hex: "#FFFFFF", material: "NYLON" },
      { id: "custom-abs-blank", name: "   ", hex: "#FFFFFF", material: "ABS" },
      "junk",
    ]);
    expect(out).toEqual([{ ...orange, hex: "#FF6A00" }]);
  });

  it("caps the list and survives non-array input", () => {
    const many = Array.from({ length: MAX_CUSTOM_COLOURS + 5 }, (_, i) => ({
      id: `custom-pla-c${i}`,
      name: `C${i}`,
      hex: "#123456",
      material: "PLA",
    }));
    expect(normalizeCustomColours(many)).toHaveLength(MAX_CUSTOM_COLOURS);
    expect(normalizeCustomColours({ nope: true })).toEqual([]);
    expect(normalizeCustomColours(undefined)).toEqual([]);
  });

  it("can never collide with a palette id", () => {
    expect(COLOUR_IDS.some((id) => isCustomColourId(id))).toBe(false);
  });
});

describe("newCustomColourId", () => {
  it("builds a readable id and suffixes it when taken", () => {
    expect(newCustomColourId("ABS", "Signal Orange!", [])).toBe("custom-abs-signal-orange");
    expect(newCustomColourId("PLA_AESTHETIC", "Rosé", [])).toBe("custom-pla-aesthetic-rose");
    expect(
      newCustomColourId("ABS", "Signal Orange", ["custom-abs-signal-orange", "custom-abs-signal-orange-2"]),
    ).toBe("custom-abs-signal-orange-3");
    expect(newCustomColourId("ASA", "✨", [])).toBe("custom-asa-colour");
  });

  it("always produces an id the schema accepts", () => {
    for (const material of MATERIAL_IDS) {
      const id = newCustomColourId(material, "A very long colour name that goes on and on", []);
      expect(normalizeCustomColours([{ id, name: "x", hex: "#000000", material }])).toHaveLength(1);
      expect(modelConfigSchema.safeParse({ ...DEFAULT_MODEL_CONFIG, colour: id }).success).toBe(true);
    }
  });
});

describe("custom colours in availability", () => {
  const blob = {
    materials: { ABS: true },
    colours: { ABS: [orange.id, "pitch-black"], PLA: [orange.id, "pitch-black"] },
    customColours: [orange],
  };

  it("offers a custom colour only in its own material", () => {
    const avail = normalizeAvailability(blob);
    expect(avail.colours.ABS).toEqual([orange.id]);
    expect(avail.colours.PLA).toEqual(["pitch-black"]);
    expect(assertConfigAvailable({ material: "ABS", colour: orange.id }, avail).ok).toBe(true);
    expect(assertConfigAvailable({ material: "PLA", colour: orange.id }, avail).ok).toBe(false);
  });

  it("drops the enabled flag of a deleted custom colour", () => {
    const avail = normalizeAvailability({ ...blob, customColours: [] });
    expect(avail.colours.ABS).toEqual([]);
    expect(assertConfigAvailable({ material: "ABS", colour: orange.id }, avail).ok).toBe(false);
  });

  it("publishes customs after the palette, headed only where a palette exists", () => {
    const pla = { id: "custom-pla-baby-blue", name: "Baby Blue", hex: "#89CFF0", material: "PLA" };
    const pub = toPublicCatalog(normalizeAvailability({ ...blob, customColours: [orange, pla] }));
    const abs = pub.materials.find((m) => m.id === "ABS")!;
    expect(abs.colours).toEqual([
      { id: orange.id, name: "Signal Orange", hex: "#FF6A00", custom: true, enabled: true },
    ]);
    const plaColours = pub.materials.find((m) => m.id === "PLA")!.colours;
    expect(plaColours).toHaveLength(MATERIAL_COLOURS.PLA.length + 1);
    expect(plaColours.at(-1)).toMatchObject({ id: pla.id, group: "Custom", custom: true, enabled: false });
  });

  it("resolves names for custom, palette and unknown ids", () => {
    const customs = normalizeCustomColours([orange]);
    expect(resolveColourName(orange.id, customs)).toBe("Signal Orange");
    expect(resolveColourName("pitch-black", customs)).toBe("Pitch Black");
    expect(resolveColourName("custom-abs-gone", customs)).toBe("custom-abs-gone");
  });
});

describe("wire schema", () => {
  it("accepts palette and custom ids but rejects anything else", () => {
    const parse = (colour: unknown) =>
      modelConfigSchema.safeParse({ ...DEFAULT_MODEL_CONFIG, colour }).success;
    expect(parse("pitch-black")).toBe(true);
    expect(parse(orange.id)).toBe(true);
    expect(parse("Pitch Black")).toBe(false);
    expect(parse("a--b")).toBe(false);
    expect(parse("x".repeat(65))).toBe(false);
    expect(parse(42)).toBe(false);
  });
});

describe("ABS / ASA", () => {
  it("are their own families with their own filament lines", () => {
    expect(materialFamily("ABS")).toBe("ABS");
    expect(materialFamily("ASA")).toBe("ASA");
    expect(materialFamily("PETG_PREMIUM")).toBe("PETG");
    expect(materialFamily("PLA_CF")).toBe("PLA");
    expect(filamentLine("ABS", orange.id)).toBe("abs");
    expect(filamentLine("ASA", "custom-asa-white")).toBe("asa");
  });

  it("cost custom colours in other tiers at the tier's own line", () => {
    expect(filamentLine("PLA", "custom-pla-baby-blue")).toBe("plaPlus");
    expect(filamentLine("PETG", "custom-petg-mint")).toBe("petgHs");
    expect(filamentLine("PETG_PREMIUM", "custom-petg-premium-smoke")).toBe("translucent");
  });

  it("summarise with the snapshotted name when there is one", () => {
    expect(
      summariseItems([
        { material: "ABS", colour: orange.id, colourName: "Signal Orange", quantity: 2 },
        { material: "PLA", colour: "pitch-black", quantity: 1 },
      ]),
    ).toBe("2× ABS (Signal Orange), 1× PLA (Pitch Black)");
  });
});
