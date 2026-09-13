import { z } from "zod";
import { MATERIAL_IDS, type MaterialId } from "./quote-types";

/**
 * The printer this shop quotes for. print.rish.pw runs a Bambu Lab A1 with the
 * committed, hand-tuned profiles (the default below); a self-hosted shop picks
 * any printer OrcaSlicer ships and the installer generates its profile set plus
 * this description as `printer.json` (apps/worker/src/profile-gen.ts), which
 * the worker and web both read.
 */
export interface PrinterProfileSpec {
  /** Stable id; part of the slice cache key for anything but the default. */
  id: string;
  /** Orca machine preset the profiles were generated from. */
  machine: string;
  /** Customer-facing name, e.g. "Prusa MK4". */
  name: string;
  vendor: string;
  nozzleMm: number;
  bedMm: [number, number, number];
  /** Has an AMS/MMU/toolchanger for automatic multicolour (the owner says so). */
  multiMaterial: boolean;
  /** Build plate each material tier prints on (its filament has a temperature for it). */
  plates: Record<MaterialId, string>;
  /** Orca preset each tier's filament profile came from — for the record. */
  filamentPresets?: Partial<Record<MaterialId, string>>;
  generated: boolean;
}

export const DEFAULT_PRINTER_ID = "bbl-a1";

export const DEFAULT_PRINTER_SPEC: PrinterProfileSpec = {
  id: DEFAULT_PRINTER_ID,
  machine: "Bambu Lab A1 0.4 nozzle",
  name: "Bambu Lab A1",
  vendor: "BBL",
  nozzleMm: 0.4,
  bedMm: [256, 256, 256],
  multiMaterial: false,
  // Pinned since PETG was found invalid on Orca's default Cool Plate.
  plates: Object.fromEntries(MATERIAL_IDS.map((m) => [m, "Textured PEI Plate"])) as Record<MaterialId, string>,
  generated: false,
};

const dim = z.number().positive().max(2000);
export const printerSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,120}$/),
  machine: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
  vendor: z.string().max(80),
  nozzleMm: z.number().positive().max(2),
  bedMm: z.tuple([dim, dim, dim]),
  multiMaterial: z.boolean(),
  plates: z.record(z.string(), z.string()),
  filamentPresets: z.record(z.string(), z.string()).optional(),
  generated: z.boolean(),
});

/** Parse printer.json; anything invalid or missing falls back to the default,
 *  with plates filled per material so a partial file can't leave one unset. */
export function parsePrinterSpec(raw: unknown): PrinterProfileSpec {
  const parsed = printerSpecSchema.safeParse(raw);
  if (!parsed.success) return DEFAULT_PRINTER_SPEC;
  const plates = { ...DEFAULT_PRINTER_SPEC.plates };
  for (const m of MATERIAL_IDS) {
    const plate = parsed.data.plates[m];
    if (plate) plates[m] = plate;
  }
  return { ...parsed.data, plates };
}
