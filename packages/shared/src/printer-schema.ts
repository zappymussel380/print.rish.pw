import { z } from "zod";
import { MATERIAL_IDS } from "./quote-types";
import { DEFAULT_PRINTER_SPEC, type PrinterProfileSpec } from "./printer";

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
