/**
 * Internal cost basis for profit reporting.
 *
 * These are our real acquisition costs — filament price, electricity, machine
 * maintenance — and exist ONLY to estimate profit in the admin portal. They are
 * deliberately kept separate from the customer-facing catalog rates (which
 * describe, on the public pricing page, what the per-gram selling rate covers):
 * changing what a spool actually costs us must never alter customer-facing copy,
 * quotes, or the PDF. All money is integer paise (₹1 = 100 paise).
 */
export interface InternalCostBasis {
  /** What a kilogram of filament costs us. */
  filamentPerKgPaise: number;
  /** Average printer power draw while printing, in kWh per hour of print time. */
  electricityKwhPerHour: number;
  /** What we pay per kWh of electricity. */
  electricityPerKwhPaise: number;
  /** Machine-wear allocation (nozzles, plates, belts) per hour of print time. */
  maintenancePerHourPaise: number;
}

/** ₹770/kg filament, 200 W draw at ₹11/unit, ₹5/hour maintenance. */
export const INTERNAL_COST: InternalCostBasis = {
  filamentPerKgPaise: 770_00,
  electricityKwhPerHour: 0.2,
  electricityPerKwhPaise: 11_00,
  maintenancePerHourPaise: 5_00,
};

/** Quantity-multiplied physical quantities for one quotation line. */
export interface CostItem {
  totalGrams: number;
  totalPrintSeconds: number;
}

export interface CostBreakdown {
  filamentPaise: number;
  electricityPaise: number;
  maintenancePaise: number;
  totalPaise: number;
}

/** Our estimated cost to produce one quotation line. */
export function estimateItemCostPaise(
  item: CostItem,
  basis: InternalCostBasis = INTERNAL_COST,
): CostBreakdown {
  const hours = item.totalPrintSeconds / 3600;
  const filamentPaise = Math.round((item.totalGrams / 1000) * basis.filamentPerKgPaise);
  const electricityPaise = Math.round(hours * basis.electricityKwhPerHour * basis.electricityPerKwhPaise);
  const maintenancePaise = Math.round(hours * basis.maintenancePerHourPaise);
  return {
    filamentPaise,
    electricityPaise,
    maintenancePaise,
    totalPaise: filamentPaise + electricityPaise + maintenancePaise,
  };
}

/** Total estimated production cost across every line of an order. */
export function estimateOrderCostPaise(
  items: CostItem[],
  basis: InternalCostBasis = INTERNAL_COST,
): number {
  return items.reduce((sum, item) => sum + estimateItemCostPaise(item, basis).totalPaise, 0);
}

/**
 * Estimated profit for an order: everything the customer is charged
 * (`revenuePaise`, which already includes the ₹150 setup fee as pure margin)
 * minus our production cost. The setup fee carries no cost of its own, so it
 * flows entirely into profit.
 */
export function estimateOrderProfitPaise(
  revenuePaise: number,
  items: CostItem[],
  basis: InternalCostBasis = INTERNAL_COST,
): number {
  return revenuePaise - estimateOrderCostPaise(items, basis);
}
