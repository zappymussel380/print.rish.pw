import { readFileSync } from "node:fs";
import { cache } from "react";
import { prisma } from "@print/db";
import { DEFAULT_PRINTER_SPEC, applyActiveProfiles, parsePrinterSpec, type PrinterProfileSpec } from "@print/shared";

let cached: PrinterProfileSpec | null = null;

/** The printer this shop quotes for as installed: the `printer.json` the
 *  self-host installer generated beside the worker's profiles
 *  (PRINTER_SPEC_FILE), or the Bambu Lab A1 when unset — print.rish.pw's own
 *  setup. Read once per process; changing printer restarts the containers.
 *  Its name is what customers see; for anything slicing depends on (build
 *  volume, cache keys) use getPrinterProfile. */
export function getPrinterSpec(): PrinterProfileSpec {
  if (cached) return cached;
  const file = process.env.PRINTER_SPEC_FILE;
  if (!file) return (cached = DEFAULT_PRINTER_SPEC);
  try {
    cached = parsePrinterSpec(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    cached = DEFAULT_PRINTER_SPEC;
  }
  return cached;
}

/** Advanced mode (self-host installer): the owner uploads OrcaSlicer presets. */
export function advancedProfilesEnabled(): boolean {
  return process.env.ADVANCED_PROFILES === "1";
}

/** The printer as slices see it: the installed one with the owner's live
 *  uploads applied in advanced mode — their build volume, the plates their
 *  filaments print on, and the upload revision in the id that every slice
 *  cache key carries. The worker derives the same from the same rows. */
export const getPrinterProfile = cache(async (): Promise<PrinterProfileSpec> => {
  const base = getPrinterSpec();
  if (!advancedProfilesEnabled()) return base;
  const rows = await prisma.slicerProfileUpload.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, slot: true, meta: true },
  });
  return applyActiveProfiles(base, rows.flatMap((r) => (r.slot ? [{ ...r, slot: r.slot }] : [])));
});
