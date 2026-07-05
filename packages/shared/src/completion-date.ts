import type { Catalog } from "./catalog";

/**
 * Estimated completion date: raw print time spread over the configured
 * effective printing hours per day, plus a fixed buffer for prep, cooling,
 * QC and packing. Deliberately conservative — it is a promise to a customer.
 */
export function estimateCompletionDate(
  totalPrintSeconds: number,
  leadTime: Catalog["leadTime"],
  from: Date = new Date(),
): Date {
  const printDays = Math.ceil(totalPrintSeconds / 3600 / leadTime.printHoursPerDay);
  const days = Math.max(printDays, 1) + leadTime.bufferDays;
  const result = new Date(from);
  result.setDate(result.getDate() + days);
  return result;
}
