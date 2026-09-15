import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog";
import { INTERNAL_COST } from "./costs";
import { MATERIAL_IDS } from "./quote-types";
import {
  defaultPricing,
  findPricingIssues,
  normalizePricing,
  toPricingInput,
} from "./pricing-settings";

describe("normalizePricing", () => {
  it("is exactly today's code rates when nothing is stored", () => {
    for (const raw of [null, undefined, {}, "junk", 42]) {
      const p = normalizePricing(raw);
      expect(p.catalog).toEqual(CATALOG);
      expect(p.costBasis).toEqual(INTERNAL_COST);
    }
  });

  it("overrides only what a blob names", () => {
    const p = normalizePricing({
      setupFeePaise: 200_00,
      materials: { ABS: { sellPerGramPaise: 275 } },
      internal: { spoolListPriceInr: { abs: 700 }, gstRate: 0.12 },
    });
    expect(p.catalog.setupFeePaise).toBe(200_00);
    expect(p.catalog.materials.ABS.sellPerGramPaise).toBe(275);
    expect(p.catalog.materials.ABS.costPerKgPaise).toBe(CATALOG.materials.ABS.costPerKgPaise);
    expect(p.catalog.materials.PLA).toEqual(CATALOG.materials.PLA);
    expect(p.costBasis.spoolListPriceInr.abs).toBe(700);
    expect(p.costBasis.spoolListPriceInr.plaPlus).toBe(INTERNAL_COST.spoolListPriceInr.plaPlus);
    expect(p.costBasis.gstRate).toBe(0.12);
  });

  it("falls back per field on anything out of range or malformed", () => {
    const p = normalizePricing({
      setupFeePaise: -1,
      materials: { PLA: { sellPerGramPaise: 0 }, PETG: { sellPerGramPaise: 2.55 }, NYLON: { sellPerGramPaise: 300 } },
      kwhPerHour: "0.1",
      leadTime: { printHoursPerDay: 25, bufferDays: 3 },
      internal: { gstRate: 1.5 },
    });
    expect(p.catalog.setupFeePaise).toBe(CATALOG.setupFeePaise);
    expect(p.catalog.materials.PLA.sellPerGramPaise).toBe(CATALOG.materials.PLA.sellPerGramPaise);
    expect(p.catalog.materials.PETG.sellPerGramPaise).toBe(CATALOG.materials.PETG.sellPerGramPaise);
    expect(p.catalog.printers[CATALOG.defaultPrinterId]!.kwhPerHour).toBe(0.09);
    expect(p.catalog.leadTime).toEqual({ printHoursPerDay: 8, bufferDays: 3 });
    expect(p.costBasis.gstRate).toBe(INTERNAL_COST.gstRate);
    expect(Object.keys(p.catalog.materials)).toEqual([...MATERIAL_IDS]);
  });

  it("never mutates the code defaults", () => {
    normalizePricing({ setupFeePaise: 1, materials: { PLA: { sellPerGramPaise: 999 } } });
    expect(CATALOG.setupFeePaise).toBe(150_00);
    expect(CATALOG.materials.PLA.sellPerGramPaise).toBe(200);
    expect(defaultPricing().catalog).not.toBe(CATALOG);
  });

  it("round-trips through its storable form, naming every field", () => {
    const edited = normalizePricing({ setupFeePaise: 99_00, internal: { maintenancePerHourPaise: 7_00 } });
    const stored = toPricingInput(edited);
    expect(Object.keys(stored.materials!)).toEqual([...MATERIAL_IDS]);
    expect(normalizePricing(JSON.parse(JSON.stringify(stored)))).toEqual(edited);
    expect(findPricingIssues(stored)).toEqual([]);
  });
});

describe("findPricingIssues", () => {
  it("takes a price per gram to a tenth of a paisa, so any whole ₹/kg is exact", () => {
    // ₹3,499/kg typed in admin → 349.9 paise/g.
    expect(normalizePricing({ materials: { PLA: { sellPerGramPaise: 349.9 } } }).catalog.materials.PLA.sellPerGramPaise).toBe(349.9);
    expect(findPricingIssues({ materials: { PLA: { sellPerGramPaise: 349.9 } } })).toEqual([]);
    expect(findPricingIssues({ materials: { PLA: { sellPerGramPaise: 349.95 } } })).toEqual(["materials.PLA.sellPerGramPaise"]);
  });

  it("names each bad field and ignores absent ones", () => {
    expect(findPricingIssues({})).toEqual([]);
    expect(
      findPricingIssues({
        setupFeePaise: "150",
        materials: { ABS: { sellPerGramPaise: 0, costPerKgPaise: 650_00 }, NYLON: {} },
        leadTime: { bufferDays: 1.5 },
        internal: { spoolListPriceInr: { abs: 650, nylon: 900 }, gstRate: -0.1 },
      }),
    ).toEqual([
      "setupFeePaise",
      "materials.ABS.sellPerGramPaise",
      "materials.NYLON",
      "leadTime.bufferDays",
      "internal.spoolListPriceInr.nylon",
      "internal.gstRate",
    ]);
  });

  it("refuses a payload that is not an object at all", () => {
    expect(findPricingIssues([1, 2])).toEqual(["(payload)"]);
  });
});
