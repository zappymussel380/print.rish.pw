import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { type Prisma, prisma } from "@print/db";
import {
  AdminDashboard,
  type AdminStats,
  type QuotationRow,
} from "@/components/admin/admin-dashboard";
import { isAdmin } from "@/lib/session";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  // Keep the PII query independently protected even if middleware matching or
  // framework behavior changes. API routes apply the same defense in depth.
  if (!(await isAdmin())) redirect("/admin/login");

  const quotations = await prisma.quotation.findMany({
    orderBy: { createdAt: "desc" },
    take: 1000,
    include: { items: true },
  });

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
  }));

  const stats = computeStats(quotations);

  return <AdminDashboard quotations={rows} stats={stats} />;
}

type QuotationWithItems = Prisma.QuotationGetPayload<{ include: { items: true } }>;

function computeStats(quotations: QuotationWithItems[]): AdminStats {
  const statusCounts: Record<string, number> = {};
  let revenuePaise = 0;
  let billableCount = 0;
  let printSeconds = 0;
  let plaGrams = 0;
  let petgGrams = 0;

  for (const q of quotations) {
    statusCounts[q.status] = (statusCounts[q.status] ?? 0) + 1;
    if (q.status === "CANCELLED") continue;
    revenuePaise += q.totalPaise;
    billableCount += 1;
    for (const item of q.items) {
      const grams = Number(item.unitGrams) * item.quantity;
      printSeconds += item.unitPrintSeconds * item.quantity;
      if (item.material === "PETG") petgGrams += grams;
      else plaGrams += grams;
    }
  }

  return {
    total: quotations.length,
    revenuePaise,
    aovPaise: billableCount > 0 ? Math.round(revenuePaise / billableCount) : 0,
    printHours: printSeconds / 3600,
    filamentKg: (plaGrams + petgGrams) / 1000,
    plaGrams,
    petgGrams,
    statusCounts,
  };
}
