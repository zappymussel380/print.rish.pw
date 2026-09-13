import { readFileSync } from "node:fs";
import { DEFAULT_PRINTER_SPEC, parsePrinterSpec, type PrinterProfileSpec } from "@print/shared";

let cached: PrinterProfileSpec | null = null;

/** The printer this shop quotes for: the `printer.json` the self-host installer
 *  generated beside the worker's profiles (PRINTER_SPEC_FILE), or the Bambu Lab
 *  A1 when unset — print.rish.pw's own setup. Read once per process; changing
 *  printer restarts the containers. */
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
