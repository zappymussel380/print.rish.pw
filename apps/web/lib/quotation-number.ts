import type { Prisma } from "@print/db";
import { formatQuotationNumber } from "@print/shared";

/** Allocate the next sequential quotation number for the current year within a
 *  transaction, under the shop's initials: RSP-2026-0001, RSP-2026-0002, … The
 *  per-year counter row is created on demand and incremented atomically, and is
 *  shared by every prefix, so changing initials never reuses a number. */
export async function nextQuotationNumber(
  tx: Prisma.TransactionClient,
  prefix: string,
): Promise<string> {
  const year = new Date().getFullYear();
  const row = await tx.quotationCounter.upsert({
    where: { year },
    create: { year, counter: 1 },
    update: { counter: { increment: 1 } },
  });
  return formatQuotationNumber(prefix, year, row.counter);
}
