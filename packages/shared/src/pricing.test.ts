import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog";
import { priceQuote } from "./pricing";
import type { QuoteLineInput } from "./pricing";
import { DEFAULT_MODEL_CONFIG } from "./quote-types";

function line(overrides: Partial<QuoteLineInput> = {}): QuoteLineInput {
  return {
    modelId: "m1",
    config: {
      material: "PLA",
      colour: "black",
      layerHeightUm: 200,
      infillPct: 15,
      supports: "auto",
      quantity: 1,
    },
    stats: {
      filamentGrams: 10,
      filamentMm: 3300,
      printSeconds: 3600,
      supportGrams: null,
    },
    ...overrides,
  };
}

describe("priceQuote", () => {
  it("charges PLA at ₹2.00/g plus the ₹150 setup fee", () => {
    const quote = priceQuote([line()], CATALOG);
    expect(quote.setupFeePaise).toBe(15000);
    expect(quote.lines[0]!.materialPaise).toBe(10 * 200);
    expect(quote.lines[0]!.subtotalPaise).toBe(2000);
    expect(quote.totalPaise).toBe(15000 + 2000);
  });

  it("charges PETG at ₹2.50/g", () => {
    const quote = priceQuote(
      [line({ config: { ...line().config, material: "PETG" } })],
      CATALOG,
    );
    expect(quote.lines[0]!.materialPaise).toBe(10 * 250);
  });

  it.each([
    ["PLA_AESTHETIC", 300],
    ["PLA_CF", 350],
    ["PETG_PREMIUM", 350],
  ] as const)("charges %s at its own premium rate (%i paise/g)", (material, rate) => {
    const quote = priceQuote([line({ config: { ...line().config, material } })], CATALOG);
    expect(quote.lines[0]!.materialPaise).toBe(10 * rate);
    expect(quote.totalPaise).toBe(15000 + 10 * rate);
  });

  it("rounds a line priced at a fractional per-gram rate to whole paise", () => {
    const catalog = { ...CATALOG, materials: { ...CATALOG.materials, PLA: { ...CATALOG.materials.PLA, sellPerGramPaise: 349.9 } } };
    const q = priceQuote([{ modelId: "m", config: { ...DEFAULT_MODEL_CONFIG, material: "PLA" }, stats: { filamentGrams: 10, filamentMm: 3000, printSeconds: 600, supportGrams: null } }], catalog);
    expect(q.lines[0]!.subtotalPaise).toBe(3499);
    expect(Number.isInteger(q.totalPaise)).toBe(true);
  });

  it("applies the setup fee once regardless of file count", () => {
    const quote = priceQuote([line(), line({ modelId: "m2" }), line({ modelId: "m3" })], CATALOG);
    expect(quote.setupFeePaise).toBe(15000);
    expect(quote.totalPaise).toBe(15000 + 3 * 2000);
  });

  it("multiplies material, time and informational costs by quantity", () => {
    const quote = priceQuote([line({ config: { ...line().config, quantity: 4 } })], CATALOG);
    const l = quote.lines[0]!;
    expect(l.materialPaise).toBe(4 * 10 * 200);
    expect(l.totalGrams).toBe(40);
    expect(l.totalPrintSeconds).toBe(4 * 3600);
    // electricity: 1h × 0.09 kWh × ₹10/kWh = ₹0.90/unit → ₹3.60 for 4
    expect(l.electricityPaise).toBe(360);
    // maintenance: 10 g × ₹0.20/g = ₹2/unit → ₹8 for 4
    expect(l.maintenancePaise).toBe(800);
  });

  it("keeps electricity and maintenance informational (not added to the total)", () => {
    const quote = priceQuote([line()], CATALOG);
    const l = quote.lines[0]!;
    expect(l.electricityPaise).toBe(90);
    expect(l.maintenancePaise).toBe(200);
    expect(l.subtotalPaise).toBe(l.materialPaise);
    expect(quote.totalPaise).toBe(quote.setupFeePaise + l.subtotalPaise);
  });

  it("computes internal filament cost from the per-kg rate", () => {
    const quote = priceQuote([line()], CATALOG);
    // 10 g of PLA at ₹600/kg = ₹6.00
    expect(quote.lines[0]!.filamentCostPaise).toBe(600);
    const petg = priceQuote(
      [line({ config: { ...line().config, material: "PETG" } })],
      CATALOG,
    );
    // 10 g of PETG at ₹800/kg = ₹8.00
    expect(petg.lines[0]!.filamentCostPaise).toBe(800);
  });

  it("rounds fractional grams half-up at line level, once", () => {
    const quote = priceQuote(
      [line({ stats: { ...line().stats, filamentGrams: 3.333 } })],
      CATALOG,
    );
    // 3.333 g × 200 paise = 666.6 → 667 paise
    expect(quote.lines[0]!.materialPaise).toBe(667);
  });

  it("aggregates totals across lines including quantity", () => {
    const quote = priceQuote(
      [
        line({ config: { ...line().config, quantity: 2 } }),
        line({
          modelId: "m2",
          config: { ...line().config, material: "PETG" },
          stats: { filamentGrams: 25, filamentMm: 8000, printSeconds: 7200, supportGrams: 1.5 },
        }),
      ],
      CATALOG,
    );
    expect(quote.totals.grams).toBe(2 * 10 + 25);
    expect(quote.totals.printSeconds).toBe(2 * 3600 + 7200);
    expect(quote.totals.electricityPaise).toBe(
      quote.lines.reduce((s, l) => s + l.electricityPaise, 0),
    );
    expect(quote.totalPaise).toBe(
      quote.setupFeePaise + quote.lines.reduce((s, l) => s + l.subtotalPaise, 0),
    );
  });

  it("rejects an empty quote", () => {
    expect(() => priceQuote([], CATALOG)).toThrow();
  });

  it("rejects non-positive slice stats", () => {
    expect(() =>
      priceQuote([line({ stats: { ...line().stats, filamentGrams: 0 } })], CATALOG),
    ).toThrow();
  });
});
