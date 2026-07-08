import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { csvCell } from "@/lib/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Export all quotations as CSV. Admin-gated by middleware. */
export async function GET(_request: NextRequest) {
  const quotations = await prisma.quotation.findMany({
    orderBy: { createdAt: "desc" },
    include: { items: true },
  });

  const header = [
    "Number",
    "Date",
    "Status",
    "Name",
    "Email",
    "Phone",
    "City",
    "Models",
    "Filament (g)",
    "Print hours",
    "Total (INR)",
    "Notes",
  ];

  const rows = quotations.map((q) => {
    const grams = q.items.reduce((sum, i) => sum + Number(i.unitGrams) * i.quantity, 0);
    const seconds = q.items.reduce((sum, i) => sum + i.unitPrintSeconds * i.quantity, 0);
    return [
      q.number,
      q.createdAt.toISOString().slice(0, 10),
      q.status,
      q.customerName,
      q.customerEmail,
      q.customerPhone,
      q.customerCity,
      q.items.length,
      grams.toFixed(1),
      (seconds / 3600).toFixed(2),
      (q.totalPaise / 100).toFixed(2),
      q.notes,
    ].map(csvCell).join(",");
  });

  const csv = [header.map(csvCell).join(","), ...rows].join("\n");
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="quotations-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
