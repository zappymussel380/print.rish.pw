import type { CustomMaterialId, MaterialId } from "./quote-types";

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

/** Filament product lines we buy, each with its own spool price. A material
 *  tier spans several (Aesthetic PLA is matte, silk, glow, wood …), so cost is
 *  resolved per colour — see `filamentLine`. */
export type FilamentLine =
  | "plaPlus"
  | "pla"
  | "matte"
  | "silk"
  | "silkClearance"
  | "dualTriSilk"
  | "metallic"
  | "stone"
  | "starlight"
  | "glow"
  | "wood"
  | "plaCf"
  | "petgHs"
  | "translucent"
  | "translucentGlitter"
  | "petgCf"
  | "abs"
  | "asa"
  // The shop's own materials (CUSTOM_MATERIAL_IDS), one spool line each.
  | "other1"
  | "other2"
  | "other3"
  | "other4";

/** How each line is named in the admin rates editor. A Record, so a new line
 *  cannot ship without a label. */
export const FILAMENT_LINE_LABELS: Record<FilamentLine, string> = {
  plaPlus: "PLA+ (basic PLA colours)",
  pla: "PLA (Ivory)",
  matte: "Matte PLA",
  silk: "Silk PLA",
  silkClearance: "Silk PLA (clearance colours)",
  dualTriSilk: "Dual / tri-colour silk",
  metallic: "Metallic PLA",
  stone: "Stone PLA",
  starlight: "Starlight PLA",
  glow: "Glow PLA",
  wood: "Wood PLA",
  plaCf: "PLA-CF",
  petgHs: "PETG HS",
  translucent: "Translucent PETG",
  translucentGlitter: "Glitter PETG",
  petgCf: "PETG-CF",
  abs: "ABS",
  asa: "ASA",
  // Shown under the shop's own name for the material where it has one.
  other1: "Other material 1",
  other2: "Other material 2",
  other3: "Other material 3",
  other4: "Other material 4",
};

export interface InternalCostBasis {
  /** Supplier list price per 1 kg spool, in whole rupees, before GST. */
  spoolListPriceInr: Record<FilamentLine, number>;
  /** GST charged on top of the list price. */
  gstRate: number;
  /** Shipping paid per 1 kg spool. */
  spoolShippingPaise: number;
  /** Average printer power draw while printing, in kWh per hour of print time. */
  electricityKwhPerHour: number;
  /** What we pay per kWh of electricity. */
  electricityPerKwhPaise: number;
  /** Machine-wear allocation (nozzles, plates, belts) per hour of print time. */
  maintenancePerHourPaise: number;
}

/** india.numakers.com list prices, 1 kg / 1.75 mm, as of 2026-09-12 (snapshot in
 *  docs/numakers/). Filament costs list + 18% GST + ₹90 shipping per spool; 200 W
 *  draw at ₹11/unit; ₹5/hour maintenance. */
export const INTERNAL_COST: InternalCostBasis = {
  spoolListPriceInr: {
    plaPlus: 600,
    pla: 565,
    matte: 649,
    silk: 749,
    silkClearance: 699,
    dualTriSilk: 749,
    metallic: 849,
    stone: 649,
    starlight: 849,
    glow: 975,
    wood: 1099,
    plaCf: 1499,
    petgHs: 599,
    translucent: 599,
    translucentGlitter: 699,
    petgCf: 1149,
    // Placeholders until the operator enters real spool prices in admin → Rates.
    abs: 650,
    asa: 900,
    other1: 1500,
    other2: 1500,
    other3: 1500,
    other4: 1500,
  },
  gstRate: 0.18,
  spoolShippingPaise: 90_00,
  electricityKwhPerHour: 0.2,
  electricityPerKwhPaise: 11_00,
  maintenancePerHourPaise: 5_00,
};

/** What one spool of a line lands at: list price + GST + shipping. */
export function spoolCostPerKgPaise(
  listPriceInr: number,
  basis: InternalCostBasis = INTERNAL_COST,
): number {
  return Math.round(listPriceInr * 100 * (1 + basis.gstRate)) + basis.spoolShippingPaise;
}

// Colours that exist only in a cheaper line than the rest of their tier.
const PLA_LINE_ONLY = new Set(["ivory"]);
const SILK_CLEARANCE_ONLY = new Set([
  "silk-gold",
  "silk-enchanted-gold",
  "silk-bronze",
  "silk-molten-sol",
  "silk-forest-green",
  "silk-obsidian-night",
]);
const AESTHETIC_PREFIX: [string, FilamentLine][] = [
  ["matte-", "matte"],
  ["dual-", "dualTriSilk"],
  ["tri-", "dualTriSilk"],
  ["metallic-", "metallic"],
  ["stone-", "stone"],
  ["starlight-", "starlight"],
  ["glow-", "glow"],
  ["wood-", "wood"],
];

/** The product line a quoted colour is bought as. Colour ids carry their line
 *  as a prefix within the premium tiers; basic PLA is bought as PLA+ (what the
 *  tier slices with), including baby pink from another supplier, which the
 *  operator costs on the same basis. Unknown, legacy and admin-defined custom
 *  colour ids fall back to the tier's own line. */
export function filamentLine(material: MaterialId, colour: string): FilamentLine {
  switch (material) {
    case "PLA":
      return PLA_LINE_ONLY.has(colour) ? "pla" : "plaPlus";
    case "PLA_AESTHETIC": {
      if (colour.startsWith("silk-")) {
        return SILK_CLEARANCE_ONLY.has(colour) ? "silkClearance" : "silk";
      }
      const hit = AESTHETIC_PREFIX.find(([prefix]) => colour.startsWith(prefix));
      return hit ? hit[1] : "silk";
    }
    case "PLA_CF":
      return "plaCf";
    case "PETG":
      return "petgHs";
    case "PETG_PREMIUM":
      if (colour.startsWith("petg-cf-")) return "petgCf";
      return colour.endsWith("-glitter") ? "translucentGlitter" : "translucent";
    case "ABS":
      return "abs";
    case "ASA":
      return "asa";
    case "OTHER_1":
      return "other1";
    case "OTHER_2":
      return "other2";
    case "OTHER_3":
      return "other3";
    case "OTHER_4":
      return "other4";
  }
}

/** The spool line each of the shop's own materials is costed as. */
export const CUSTOM_MATERIAL_LINE = {
  OTHER_1: "other1",
  OTHER_2: "other2",
  OTHER_3: "other3",
  OTHER_4: "other4",
} as const satisfies Record<CustomMaterialId, FilamentLine>;

/** What a kilogram of this material+colour actually costs us. */
export function filamentCostPerKgPaise(
  material: MaterialId,
  colour: string,
  basis: InternalCostBasis = INTERNAL_COST,
): number {
  return spoolCostPerKgPaise(basis.spoolListPriceInr[filamentLine(material, colour)], basis);
}

/** Quantity-multiplied physical quantities for one quotation line. */
export interface CostItem {
  material: MaterialId;
  colour: string;
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
  const filamentPaise = Math.round(
    (item.totalGrams / 1000) * filamentCostPerKgPaise(item.material, item.colour, basis),
  );
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
 * Estimated profit for an order: what the customer pays for printing minus our
 * production cost. Prepaid courier shipping is collected on the courier's
 * behalf and passed straight on, so it is never profit. The setup fee carries
 * no cost of its own and flows entirely into profit.
 */
export function estimateOrderProfitPaise(
  order: { totalPaise: number; shippingPaise: number },
  items: CostItem[],
  basis: InternalCostBasis = INTERNAL_COST,
): number {
  return order.totalPaise - order.shippingPaise - estimateOrderCostPaise(items, basis);
}
