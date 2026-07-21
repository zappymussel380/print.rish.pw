import { describe, expect, it } from "vitest";
import {
  INTERNAL_COST,
  estimateItemCostPaise,
  estimateOrderCostPaise,
  estimateOrderProfitPaise,
} from "./costs";

describe("estimateItemCostPaise", () => {
  it("costs filament at ₹770/kg", () => {
    // 100 g at ₹770/kg = ₹77.00
    expect(estimateItemCostPaise({ totalGrams: 100, totalPrintSeconds: 0 }).filamentPaise).toBe(7700);
  });

  it("costs electricity at 200 W (0.2 kWh/h) × ₹11/unit", () => {
    // 1 hour × 0.2 kWh × ₹11 = ₹2.20
    expect(
      estimateItemCostPaise({ totalGrams: 0, totalPrintSeconds: 3600 }).electricityPaise,
    ).toBe(220);
  });

  it("costs maintenance at ₹5 per print-hour", () => {
    // 2 hours × ₹5 = ₹10.00
    expect(
      estimateItemCostPaise({ totalGrams: 0, totalPrintSeconds: 7200 }).maintenancePaise,
    ).toBe(1000);
  });

  it("sums the three components into the line total", () => {
    const c = estimateItemCostPaise({ totalGrams: 48.27, totalPrintSeconds: 6120 });
    // filament ₹37.17 + electricity ₹3.74 + maintenance ₹8.50 = ₹49.41
    expect(c.filamentPaise).toBe(3717);
    expect(c.electricityPaise).toBe(374);
    expect(c.maintenancePaise).toBe(850);
    expect(c.totalPaise).toBe(3717 + 374 + 850);
  });
});

describe("estimateOrderProfitPaise", () => {
  it("treats the setup fee as pure profit (revenue minus production cost)", () => {
    // one ₹96.53 line + ₹150 setup = ₹246.53 revenue; cost ≈ ₹49.41
    const items = [{ totalGrams: 48.27, totalPrintSeconds: 6120 }];
    const cost = estimateOrderCostPaise(items);
    expect(cost).toBe(4941);
    expect(estimateOrderProfitPaise(24653, items)).toBe(24653 - 4941);
  });

  it("uses the documented internal rates", () => {
    expect(INTERNAL_COST.filamentPerKgPaise).toBe(77000);
    expect(INTERNAL_COST.maintenancePerHourPaise).toBe(500);
  });
});
