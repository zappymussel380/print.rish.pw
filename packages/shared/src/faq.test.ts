import { describe, expect, it } from "vitest";
import { buildFaq, composeFaq, normalizeFaqSettings, type FaqContext } from "./faq";

const ctx: FaqContext = {
  materials: [
    { id: "PLA", name: "PLA" },
    { id: "PETG", name: "PETG" },
  ],
  colourCount: 12,
  printer: { name: "Bambu Lab A1", bedMm: [256, 256, 256], multiMaterial: false },
  city: "Guwahati",
  leadTime: { printHoursPerDay: 8, bufferDays: 2 },
  courierQuotes: true,
  retention: { uploadHours: 48, fileDays: 30 },
  contactChannel: "WhatsApp",
  layerHeights: [120, 160, 200],
};
const answer = (c: FaqContext, id: string) => buildFaq(c).find((e) => e.id === id)?.a ?? "";

describe("buildFaq", () => {
  it("talks only about the layer heights on offer, and reads as before with all three", () => {
    expect(answer(ctx, "layer-lines")).toBe(
      "Yes — every FDM print has them; they're the nature of the process. At 0.12 mm layer height they're subtle and mostly disappear at arm's length. Choose 0.12 mm for display pieces and 0.20 mm for functional parts where speed and price matter more.",
    );
    expect(answer({ ...ctx, layerHeights: [160, 200] }, "layer-lines")).toContain("Choose 0.16 mm for display pieces and 0.20 mm");
    const one = answer({ ...ctx, layerHeights: [200] }, "layer-lines");
    expect(one).toContain("Every part is printed at 0.20 mm layers.");
    expect(one).not.toMatch(/0\.12|0\.16/);
  });

  it("answers from the shop's own settings", () => {
    expect(answer(ctx, "materials")).toContain("Right now: PLA and PETG.");
    expect(answer(ctx, "colours")).toContain("12 colours across PLA and PETG");
    expect(answer(ctx, "max-size")).toContain("256 × 256 × 256 mm — the full build volume of the Bambu Lab A1");
    expect(answer(ctx, "accuracy")).toContain("same Bambu Lab A1 profile");
    expect(answer(ctx, "turnaround")).toContain("about 8 printing hours a day, plus 2 days");
    expect(answer(ctx, "turnaround")).toContain("Pickup in Guwahati");
    expect(answer(ctx, "shipping")).toContain("live estimate");
    expect(answer(ctx, "retention")).toContain("within 48 hours");
    expect(answer(ctx, "durability")).toContain("PLA handles static indoor loads");
    expect(answer(ctx, "durability")).not.toContain("ABS");
  });

  it("follows a different shop: other printer, materials, no courier, no city", () => {
    const other: FaqContext = {
      ...ctx,
      materials: [{ id: "ABS", name: "ABS" }, { id: "ASA", name: "ASA" }],
      colourCount: 1,
      printer: { name: "Prusa MK4", bedMm: [250, 210, 220], multiMaterial: true },
      city: "",
      leadTime: { printHoursPerDay: 1, bufferDays: 1 },
      courierQuotes: false,
      contactChannel: "the contact page",
    };
    expect(answer(other, "materials")).toContain("ABS and ASA");
    expect(answer(other, "colours")).toContain("1 colour across ABS and ASA");
    expect(answer(other, "max-size")).toContain("250 × 210 × 220 mm — the full build volume of the Prusa MK4");
    expect(answer(other, "multicolour")).toContain("can switch between several filaments");
    expect(answer(other, "turnaround")).toContain("about 1 printing hour a day, plus 1 day");
    expect(answer(other, "turnaround")).not.toContain("Pickup");
    expect(answer(other, "shipping")).toContain("ask us on the contact page");
    expect(answer(other, "durability")).toContain("ASA adds long-term sun");
  });

  it("drops entries that would be empty", () => {
    const bare = buildFaq({ ...ctx, materials: [], colourCount: 0 }).map((e) => e.id);
    expect(bare).not.toContain("materials");
    expect(bare).not.toContain("colours");
  });

  it("never states another shop's policies", () => {
    const all = buildFaq(ctx).map((e) => e.a).join(" ");
    for (const shopSpecific of ["800 g", "AMS", "UPI", "rish", "we don't take on custom modeling"]) {
      expect(all).not.toContain(shopSpecific);
    }
  });
});

describe("FAQ settings", () => {
  it("keeps valid custom entries in order and hides chosen generated ones", () => {
    const settings = normalizeFaqSettings({
      custom: [
        { id: "custom-colours", q: " Custom colours? ", a: "For 800 g+ jobs." },
        { id: "custom-colours", q: "dup", a: "dup" },
        { id: "not-custom", q: "x", a: "y" },
        { id: "custom-empty", q: "", a: "y" },
      ],
      hidden: ["payment", "payment", 7],
    });
    expect(settings).toEqual({
      custom: [{ id: "custom-colours", q: "Custom colours?", a: "For 800 g+ jobs." }],
      hidden: ["payment"],
    });
    const shown = composeFaq(buildFaq(ctx), settings).map((e) => e.id);
    expect(shown).not.toContain("payment");
    expect(shown.at(-1)).toBe("custom-colours");
  });

  it("survives junk", () => {
    expect(normalizeFaqSettings(null)).toEqual({ custom: [], hidden: [] });
    expect(normalizeFaqSettings("x")).toEqual({ custom: [], hidden: [] });
  });
});
