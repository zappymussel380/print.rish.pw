import { z } from "zod";
import { CATALOG, type Catalog } from "./catalog";
import { INTERNAL_COST, type FilamentLine, type InternalCostBasis } from "./costs";
import { MATERIAL_IDS } from "./quote-types";

/**
 * Admin-editable rates, overlaid on the code defaults (`CATALOG` for everything
 * customers see, `INTERNAL_COST` for profit reporting). Stored as one JSON app
 * setting; this module is the pure half — no DB — so the admin form, the API
 * and the tests all harden values the same way.
 *
 * A stored blob only overrides what it names, and every value is range-checked:
 * an out-of-range or malformed field falls back to its default rather than
 * pricing an order at ₹0 or ₹1,00,000/g.
 */
export interface PricingSettings {
  catalog: Catalog;
  costBasis: InternalCostBasis;
}

const RUPEE = 100;
/** Integer paise within [min, max]. */
const paise = (min: number, max: number) => z.number().int().min(min).max(max);
const ratio = (max: number) => z.number().finite().min(0).max(max);

/** Bounds per field. Generous enough for any real filament shop, tight enough
 *  that a typo (an extra zero or two) cannot silently reprice everything. */
export const PRICING_BOUNDS = {
  setupFeePaise: paise(0, 1_00_000 * RUPEE),
  sellPerGramPaise: paise(1, 1_000 * RUPEE),
  costPerKgPaise: paise(0, 1_00_000 * RUPEE),
  electricityPerKwhPaise: paise(0, 1_000 * RUPEE),
  maintenancePerGramPaise: paise(0, 100 * RUPEE),
  kwhPerHour: ratio(10),
  printHoursPerDay: z.number().int().min(1).max(24),
  bufferDays: z.number().int().min(0).max(60),
  spoolListPriceInr: z.number().int().min(0).max(1_00_000),
  gstRate: ratio(1),
  spoolShippingPaise: paise(0, 10_000 * RUPEE),
  electricityKwhPerHour: ratio(10),
  maintenancePerHourPaise: paise(0, 1_000 * RUPEE),
} as const;

/** Wire/storage shape: every field optional, validated field by field in
 *  `normalizePricing` so one bad value never discards the rest. */
export const pricingInputSchema = z.object({
  setupFeePaise: z.unknown().optional(),
  materials: z
    .record(
      z.string(),
      z.object({ sellPerGramPaise: z.unknown().optional(), costPerKgPaise: z.unknown().optional() }),
    )
    .optional(),
  electricityPerKwhPaise: z.unknown().optional(),
  maintenancePerGramPaise: z.unknown().optional(),
  kwhPerHour: z.unknown().optional(),
  leadTime: z
    .object({ printHoursPerDay: z.unknown().optional(), bufferDays: z.unknown().optional() })
    .optional(),
  internal: z
    .object({
      spoolListPriceInr: z.record(z.string(), z.unknown()).optional(),
      gstRate: z.unknown().optional(),
      spoolShippingPaise: z.unknown().optional(),
      electricityKwhPerHour: z.unknown().optional(),
      electricityPerKwhPaise: z.unknown().optional(),
      maintenancePerHourPaise: z.unknown().optional(),
    })
    .optional(),
});
export type PricingInput = z.infer<typeof pricingInputSchema>;

function pick<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/** Plain JSON data only — a deep copy so normalising never mutates the defaults. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function defaultPricing(): PricingSettings {
  return { catalog: clone(CATALOG), costBasis: clone(INTERNAL_COST) };
}

/** Harden a stored/submitted blob into complete, in-range settings. Never throws. */
export function normalizePricing(raw: unknown): PricingSettings {
  const out = defaultPricing();
  const parsed = pricingInputSchema.safeParse(raw ?? {});
  if (!parsed.success) return out;
  const input = parsed.data;
  const { catalog, costBasis } = out;
  const B = PRICING_BOUNDS;

  catalog.setupFeePaise = pick(B.setupFeePaise, input.setupFeePaise, catalog.setupFeePaise);
  for (const m of MATERIAL_IDS) {
    const given = input.materials?.[m];
    if (!given) continue;
    const spec = catalog.materials[m];
    spec.sellPerGramPaise = pick(B.sellPerGramPaise, given.sellPerGramPaise, spec.sellPerGramPaise);
    spec.costPerKgPaise = pick(B.costPerKgPaise, given.costPerKgPaise, spec.costPerKgPaise);
  }
  catalog.electricityPerKwhPaise = pick(
    B.electricityPerKwhPaise,
    input.electricityPerKwhPaise,
    catalog.electricityPerKwhPaise,
  );
  catalog.maintenancePerGramPaise = pick(
    B.maintenancePerGramPaise,
    input.maintenancePerGramPaise,
    catalog.maintenancePerGramPaise,
  );
  const printer = catalog.printers[catalog.defaultPrinterId]!;
  printer.kwhPerHour = pick(B.kwhPerHour, input.kwhPerHour, printer.kwhPerHour);
  catalog.leadTime.printHoursPerDay = pick(
    B.printHoursPerDay,
    input.leadTime?.printHoursPerDay,
    catalog.leadTime.printHoursPerDay,
  );
  catalog.leadTime.bufferDays = pick(
    B.bufferDays,
    input.leadTime?.bufferDays,
    catalog.leadTime.bufferDays,
  );

  const internal = input.internal;
  if (internal) {
    for (const line of Object.keys(costBasis.spoolListPriceInr) as FilamentLine[]) {
      costBasis.spoolListPriceInr[line] = pick(
        B.spoolListPriceInr,
        internal.spoolListPriceInr?.[line],
        costBasis.spoolListPriceInr[line],
      );
    }
    costBasis.gstRate = pick(B.gstRate, internal.gstRate, costBasis.gstRate);
    costBasis.spoolShippingPaise = pick(
      B.spoolShippingPaise,
      internal.spoolShippingPaise,
      costBasis.spoolShippingPaise,
    );
    costBasis.electricityKwhPerHour = pick(
      B.electricityKwhPerHour,
      internal.electricityKwhPerHour,
      costBasis.electricityKwhPerHour,
    );
    costBasis.electricityPerKwhPaise = pick(
      B.electricityPerKwhPaise,
      internal.electricityPerKwhPaise,
      costBasis.electricityPerKwhPaise,
    );
    costBasis.maintenancePerHourPaise = pick(
      B.maintenancePerHourPaise,
      internal.maintenancePerHourPaise,
      costBasis.maintenancePerHourPaise,
    );
  }
  return out;
}

/** Fields present in `raw` whose value is out of range or malformed, as dotted
 *  paths ("materials.ABS.sellPerGramPaise"). Reads stay lenient (a bad stored
 *  value falls back to its default); a save with any issue is refused, so an
 *  admin's typo is reported instead of quietly replaced. */
export function findPricingIssues(raw: unknown): string[] {
  const parsed = pricingInputSchema.safeParse(raw ?? {});
  if (!parsed.success) return ["(payload)"];
  const input = parsed.data;
  const B = PRICING_BOUNDS;
  const issues: string[] = [];
  const check = (path: string, schema: z.ZodType, value: unknown) => {
    if (value !== undefined && !schema.safeParse(value).success) issues.push(path);
  };
  check("setupFeePaise", B.setupFeePaise, input.setupFeePaise);
  for (const [m, given] of Object.entries(input.materials ?? {})) {
    if (!(MATERIAL_IDS as readonly string[]).includes(m)) {
      issues.push(`materials.${m}`);
      continue;
    }
    check(`materials.${m}.sellPerGramPaise`, B.sellPerGramPaise, given.sellPerGramPaise);
    check(`materials.${m}.costPerKgPaise`, B.costPerKgPaise, given.costPerKgPaise);
  }
  check("electricityPerKwhPaise", B.electricityPerKwhPaise, input.electricityPerKwhPaise);
  check("maintenancePerGramPaise", B.maintenancePerGramPaise, input.maintenancePerGramPaise);
  check("kwhPerHour", B.kwhPerHour, input.kwhPerHour);
  check("leadTime.printHoursPerDay", B.printHoursPerDay, input.leadTime?.printHoursPerDay);
  check("leadTime.bufferDays", B.bufferDays, input.leadTime?.bufferDays);
  const internal = input.internal ?? {};
  const lines = Object.keys(INTERNAL_COST.spoolListPriceInr);
  for (const [line, value] of Object.entries(internal.spoolListPriceInr ?? {})) {
    if (!lines.includes(line)) issues.push(`internal.spoolListPriceInr.${line}`);
    else check(`internal.spoolListPriceInr.${line}`, B.spoolListPriceInr, value);
  }
  check("internal.gstRate", B.gstRate, internal.gstRate);
  check("internal.spoolShippingPaise", B.spoolShippingPaise, internal.spoolShippingPaise);
  check("internal.electricityKwhPerHour", B.electricityKwhPerHour, internal.electricityKwhPerHour);
  check("internal.electricityPerKwhPaise", B.electricityPerKwhPaise, internal.electricityPerKwhPaise);
  check("internal.maintenancePerHourPaise", B.maintenancePerHourPaise, internal.maintenancePerHourPaise);
  return issues;
}

/** The storable form of complete settings — what the admin form sends back and
 *  what `normalizePricing` reads. Names every field, so a later change to a
 *  code default never silently reprices a shop that has saved its own rates. */
export function toPricingInput(settings: PricingSettings): PricingInput {
  const { catalog, costBasis } = settings;
  return {
    setupFeePaise: catalog.setupFeePaise,
    materials: Object.fromEntries(
      MATERIAL_IDS.map((m) => [
        m,
        {
          sellPerGramPaise: catalog.materials[m].sellPerGramPaise,
          costPerKgPaise: catalog.materials[m].costPerKgPaise,
        },
      ]),
    ),
    electricityPerKwhPaise: catalog.electricityPerKwhPaise,
    maintenancePerGramPaise: catalog.maintenancePerGramPaise,
    kwhPerHour: catalog.printers[catalog.defaultPrinterId]!.kwhPerHour,
    leadTime: { ...catalog.leadTime },
    internal: {
      spoolListPriceInr: { ...costBasis.spoolListPriceInr },
      gstRate: costBasis.gstRate,
      spoolShippingPaise: costBasis.spoolShippingPaise,
      electricityKwhPerHour: costBasis.electricityKwhPerHour,
      electricityPerKwhPaise: costBasis.electricityPerKwhPaise,
      maintenancePerHourPaise: costBasis.maintenancePerHourPaise,
    },
  };
}
