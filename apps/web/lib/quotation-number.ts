import type { Prisma } from "@print/db";

/** Allocate the next sequential quotation number for the current year within a
 *  transaction: RSP-2026-0001, RSP-2026-0002, … The per-year counter row is
 *  created on demand and incremented atomically. */
export async function nextQuotationNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const row = await tx.quotationCounter.upsert({
    where: { year },
    create: { year, counter: 1 },
    update: { counter: { increment: 1 } },
  });
  return `RSP-${year}-${String(row.counter).padStart(4, "0")}`;
}
