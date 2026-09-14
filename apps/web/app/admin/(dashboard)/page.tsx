import type { Metadata } from "next";
import { type Prisma, prisma } from "@print/db";
import {
  estimateOrderProfitPaise,
  materialFamily,
  type CostItem,
  type MaterialFamily,
  type MaterialId,
  type InternalCostBasis,
} from "@print/shared";
import { AdminDashboard, type AdminStats, type QuotationRow } from "@/components/admin/admin-dashboard";
import { requireAdminPage } from "@/lib/admin-page";
import { getPricing } from "@/lib/pricing-settings";

export const metadata: Metadata = { title: "Admin" };

export const dynamic = "force-dynamic";

/** Admin home: the numbers and every quotation. */
export default async function AdminPage() {
  await requireAdminPage();

  const quotations = await prisma.quotation.findMany({
    orderBy: { createdAt: "desc" },
    take: 1000,
    include: { items: true },
  });

  const pricing = await getPricing();
  const costBasis = pricing.costBasis;

  const rows: QuotationRow[] = quotations.map((q) => ({
    id: q.id,
    number: q.number,
    createdAt: q.createdAt.toISOString(),
    status: q.status,
    customerName: q.customerName,
    customerEmail: q.customerEmail,
    customerPhone: q.customerPhone,
    customerCity: q.customerCity,
    notes: q.notes,
    models: q.items.length,
    grams: q.items.reduce((s, i) => s + Number(i.unitGrams) * i.quantity, 0),
    printSeconds: q.items.reduce((s, i) => s + i.unitPrintSeconds * i.quantity, 0),
    totalPaise: q.totalPaise,
    // Profit = what the customer pays for printing (setup fee included, pure
    // margin; prepaid shipping excluded, it is the courier's) minus our
    // production cost. Recomputed from stored grams/seconds and each line's
    // material + colour, so every order reflects the current spool costs.
    profitPaise: estimateOrderProfitPaise(q, orderCostItems(q), costBasis),
  }));

  const stats = computeStats(quotations, costBasis);

  return <AdminDashboard quotations={rows} stats={stats} />;
}

type QuotationWithItems = Prisma.QuotationGetPayload<{ include: { items: true } }>;

/** Quantity-multiplied physical quantities per line, for the cost estimate. The
 *  colour picks the filament line (matte, glow, CF …) and so the spool cost. */
function orderCostItems(q: QuotationWithItems): CostItem[] {
  return q.items.map((item) => ({
    material: item.material as MaterialId,
    colour: item.colour,
    totalGrams: Number(item.unitGrams) * item.quantity,
    totalPrintSeconds: item.unitPrintSeconds * item.quantity,
  }));
}

function computeStats(quotations: QuotationWithItems[], costBasis: InternalCostBasis): AdminStats {
  const statusCounts: Record<string, number> = {};
  let revenuePaise = 0;
  let profitPaise = 0;
  let billableCount = 0;
  let printSeconds = 0;
  const familyGrams: Record<MaterialFamily, number> = { PLA: 0, PETG: 0, ABS: 0, ASA: 0, Other: 0 };

  for (const q of quotations) {
    statusCounts[q.status] = (statusCounts[q.status] ?? 0) + 1;
    if (q.status === "CANCELLED") continue;
    revenuePaise += q.totalPaise;
    profitPaise += estimateOrderProfitPaise(q, orderCostItems(q), costBasis);
    billableCount += 1;
    for (const item of q.items) {
      const grams = Number(item.unitGrams) * item.quantity;
      printSeconds += item.unitPrintSeconds * item.quantity;
      // Split by family: the premium tiers are still PLA or PETG on the spool.
      familyGrams[materialFamily(item.material as MaterialId)] += grams;
    }
  }

  return {
    total: quotations.length,
    revenuePaise,
    profitPaise,
    aovPaise: billableCount > 0 ? Math.round(revenuePaise / billableCount) : 0,
    printHours: printSeconds / 3600,
    filamentKg: Object.values(familyGrams).reduce((a, b) => a + b, 0) / 1000,
    familyGrams,
    statusCounts,
  };
}
