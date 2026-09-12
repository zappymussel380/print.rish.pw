import { describe, expect, it } from "vitest";
import numakers from "../../../docs/numakers/catalogue-2026-09-12.json";
import {
  INTERNAL_COST,
  estimateItemCostPaise,
  estimateOrderCostPaise,
  estimateOrderProfitPaise,
  filamentCostPerKgPaise,
  filamentLine,
  spoolCostPerKgPaise,
} from "./costs";
import { MATERIAL_COLOURS } from "./colours";
import { MATERIAL_IDS, type MaterialId } from "./quote-types";

const pla = (totalGrams: number, totalPrintSeconds: number) => ({
  material: "PLA" as const,
  colour: "pitch-black",
  totalGrams,
  totalPrintSeconds,
});

describe("spool cost", () => {
  it("is the list price plus 18% GST plus ₹90 shipping, per 1 kg spool", () => {
    expect(spoolCostPerKgPaise(600)).toBe(798_00); // 600 × 1.18 = 708, + 90
    expect(spoolCostPerKgPaise(565)).toBe(756_70); // 666.70 + 90
    expect(spoolCostPerKgPaise(1499)).toBe(1858_82); // 1768.82 + 90
  });

  it("costs each colour at its own filament line, not a flat tier rate", () => {
    expect(filamentCostPerKgPaise("PLA", "pitch-black")).toBe(798_00); // PLA+
    expect(filamentCostPerKgPaise("PLA", "ivory")).toBe(756_70); // plain PLA only
    expect(filamentCostPerKgPaise("PLA", "baby-pink")).toBe(798_00); // other supplier, PLA+ basis
    expect(filamentCostPerKgPaise("PLA_AESTHETIC", "matte-ruby-red")).toBe(855_82); // ₹649
    expect(filamentCostPerKgPaise("PLA_AESTHETIC", "glow-green")).toBe(1240_50); // ₹975
    expect(filamentCostPerKgPaise("PLA_AESTHETIC", "wood-natural")).toBe(1386_82); // ₹1099
    expect(filamentCostPerKgPaise("PETG_PREMIUM", "translucent-pink")).toBe(796_82); // ₹599
    expect(filamentCostPerKgPaise("PETG_PREMIUM", "translucent-pink-glitter")).toBe(914_82); // ₹699
    expect(filamentCostPerKgPaise("PETG_PREMIUM", "petg-cf-purple")).toBe(1445_82); // ₹1149
  });

  it("falls back to the tier's own line for legacy ids", () => {
    expect(filamentLine("PLA", "black")).toBe("plaPlus");
    expect(filamentLine("PETG", "white")).toBe("petgHs");
  });

  it("matches the Numakers price list for every colour we stock from them", () => {
    // Snapshot of india.numakers.com taken when the catalogue was added. Where a
    // colour is sold in two lines, the operator buys PLA+ over plain PLA, and the
    // current silk line over the clearance one — so the first listed line wins.
    const snapshot = numakers as {
      lines: { handle: string; tier: MaterialId; colours: { id: string; priceInr: number }[] }[];
    };
    const preferred = ["pla-filament", "pla", "silk-pla", "pla-silk"];
    const lines = [...snapshot.lines].sort(
      (a, b) =>
        (preferred.indexOf(a.handle) + 1 || 99) - (preferred.indexOf(b.handle) + 1 || 99),
    );
    const expected = new Map<string, number>();
    for (const line of lines) {
      for (const c of line.colours) {
        const key = `${line.tier}:${c.id}`;
        if (!expected.has(key)) expected.set(key, spoolCostPerKgPaise(c.priceInr));
      }
    }

    for (const [key, cost] of expected) {
      const [tier, id] = key.split(":") as [MaterialId, string];
      expect(filamentCostPerKgPaise(tier, id), key).toBe(cost);
    }
    // …and every orderable colour is either in that list or a known exception.
    const elsewhere = new Set(["PLA:baby-pink"]);
    for (const m of MATERIAL_IDS) {
      for (const id of MATERIAL_COLOURS[m]) {
        const key = `${m}:${id}`;
        expect(expected.has(key) || elsewhere.has(key), key).toBe(true);
      }
    }
  });
});

describe("estimateItemCostPaise", () => {
  it("costs filament at the line's real spool cost", () => {
    // 100 g of PLA+ at ₹798/kg = ₹79.80; the same 100 g of glow PLA = ₹124.05
    expect(estimateItemCostPaise(pla(100, 0)).filamentPaise).toBe(7980);
    expect(
      estimateItemCostPaise({ ...pla(100, 0), material: "PLA_AESTHETIC", colour: "glow-green" })
        .filamentPaise,
    ).toBe(12405);
  });

  it("costs electricity at 200 W (0.2 kWh/h) × ₹11/unit", () => {
    // 1 hour × 0.2 kWh × ₹11 = ₹2.20
    expect(estimateItemCostPaise(pla(0, 3600)).electricityPaise).toBe(220);
  });

  it("costs maintenance at ₹5 per print-hour", () => {
    // 2 hours × ₹5 = ₹10.00
    expect(estimateItemCostPaise(pla(0, 7200)).maintenancePaise).toBe(1000);
  });

  it("sums the three components into the line total", () => {
    const c = estimateItemCostPaise(pla(48.27, 6120));
    // filament ₹38.52 + electricity ₹3.74 + maintenance ₹8.50 = ₹50.76
    expect(c.filamentPaise).toBe(3852);
    expect(c.electricityPaise).toBe(374);
    expect(c.maintenancePaise).toBe(850);
    expect(c.totalPaise).toBe(3852 + 374 + 850);
  });
});

describe("estimateOrderProfitPaise", () => {
  it("treats the setup fee as pure profit (revenue minus production cost)", () => {
    // one ₹96.53 line + ₹150 setup = ₹246.53 revenue; cost ≈ ₹50.76
    const items = [pla(48.27, 6120)];
    const cost = estimateOrderCostPaise(items);
    expect(cost).toBe(5076);
    expect(estimateOrderProfitPaise(24653, items)).toBe(24653 - 5076);
  });

  it("uses the documented internal rates", () => {
    expect(INTERNAL_COST.gstRate).toBe(0.18);
    expect(INTERNAL_COST.spoolShippingPaise).toBe(90_00);
    expect(INTERNAL_COST.maintenancePerHourPaise).toBe(500);
  });
});
