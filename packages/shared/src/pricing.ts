import type { Catalog } from "./catalog";
import type { ModelConfig, SliceStats } from "./quote-types";

/**
 * Pure quotation pricing engine.
 *
 * All money is integer paise. Selling price = grams × per-gram material rate,
 * plus a one-time setup fee per order. Electricity, maintenance and raw
 * filament cost are computed as informational components — they are covered by
 * the per-gram rate and are never added to the customer total.
 *
 * Models are sliced once per (file, slice-settings); quantity is a multiplier
 * applied here, never re-sliced.
 */

export interface QuoteLineInput {
  modelId: string;
  config: ModelConfig;
  stats: SliceStats;
}

export interface QuoteLine {
  modelId: string;
  config: ModelConfig;
  /** Per-unit slice stats, straight from the slicer. */
  unitGrams: number;
  unitPrintSeconds: number;
  /** Quantity-multiplied totals. */
  totalGrams: number;
  totalPrintSeconds: number;
  /** Customer charge for this line (= subtotal). */
  materialPaise: number;
  /** Informational: estimated electricity cost included in the rate. */
  electricityPaise: number;
  /** Informational: maintenance allocation included in the rate. */
  maintenancePaise: number;
  /** Informational: raw filament cost at the internal per-kg rate. */
  filamentCostPaise: number;
  subtotalPaise: number;
}

export interface QuoteBreakdown {
  lines: QuoteLine[];
  setupFeePaise: number;
  totalPaise: number;
  totals: {
    grams: number;
    filamentMm: number;
    printSeconds: number;
    electricityPaise: number;
    maintenancePaise: number;
    filamentCostPaise: number;
  };
}

/** Half-up rounding to whole paise. */
function roundPaise(value: number): number {
  return Math.round(value);
}

export function priceLine(input: QuoteLineInput, catalog: Catalog): QuoteLine {
  const { config, stats } = input;
  const material = catalog.materials[config.material];
  if (!material) {
    throw new Error(`Unknown material: ${config.material}`);
  }
  if (!(stats.filamentGrams > 0) || !(stats.printSeconds > 0)) {
    throw new Error(`Invalid slice stats for model ${input.modelId}`);
  }
  if (!Number.isInteger(config.quantity) || config.quantity < 1) {
    throw new Error(`Invalid quantity for model ${input.modelId}`);
  }

  const printer = catalog.printers[catalog.defaultPrinterId];
  if (!printer) {
    throw new Error(`Catalog has no printer ${catalog.defaultPrinterId}`);
  }

  const totalGrams = stats.filamentGrams * config.quantity;
  const totalPrintSeconds = stats.printSeconds * config.quantity;

  const materialPaise = roundPaise(totalGrams * material.sellPerGramPaise);
  const electricityPaise = roundPaise(
    (totalPrintSeconds / 3600) * printer.kwhPerHour * catalog.electricityPerKwhPaise,
  );
  const maintenancePaise = roundPaise(totalGrams * catalog.maintenancePerGramPaise);
  const filamentCostPaise = roundPaise((totalGrams / 1000) * material.costPerKgPaise);

  return {
    modelId: input.modelId,
    config,
    unitGrams: stats.filamentGrams,
    unitPrintSeconds: stats.printSeconds,
    totalGrams,
    totalPrintSeconds,
    materialPaise,
    electricityPaise,
    maintenancePaise,
    filamentCostPaise,
    subtotalPaise: materialPaise,
  };
}

export function priceQuote(inputs: QuoteLineInput[], catalog: Catalog): QuoteBreakdown {
  if (inputs.length === 0) {
    throw new Error("Cannot price an empty quote");
  }

  const lines = inputs.map((input) => priceLine(input, catalog));

  const totals = lines.reduce(
    (acc, l, i) => ({
      grams: acc.grams + l.totalGrams,
      filamentMm: acc.filamentMm + inputs[i]!.stats.filamentMm * l.config.quantity,
      printSeconds: acc.printSeconds + l.totalPrintSeconds,
      electricityPaise: acc.electricityPaise + l.electricityPaise,
      maintenancePaise: acc.maintenancePaise + l.maintenancePaise,
      filamentCostPaise: acc.filamentCostPaise + l.filamentCostPaise,
    }),
    {
      grams: 0,
      filamentMm: 0,
      printSeconds: 0,
      electricityPaise: 0,
      maintenancePaise: 0,
      filamentCostPaise: 0,
    },
  );

  const subtotal = lines.reduce((sum, l) => sum + l.subtotalPaise, 0);

  return {
    lines,
    setupFeePaise: catalog.setupFeePaise,
    totalPaise: catalog.setupFeePaise + subtotal,
    totals,
  };
}
