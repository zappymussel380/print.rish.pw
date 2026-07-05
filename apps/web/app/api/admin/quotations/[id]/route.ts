import { NextResponse, type NextRequest } from "next/server";
import { type QuotationStatus, prisma } from "@print/db";
import { jsonError } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { removeQuietly } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES: QuotationStatus[] = [
  "PENDING",
  "QUOTED",
  "APPROVED",
  "PRINTING",
  "COMPLETED",
  "DELIVERED",
  "CANCELLED",
];

/** Update a quotation's status, recording the transition in StatusHistory. */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "BAD_JSON", "Request body must be JSON");
  }
  const status = (body as { status?: unknown })?.status as QuotationStatus;
  const note = typeof (body as { note?: unknown })?.note === "string" ? (body as { note: string }).note : "";
  if (!STATUSES.includes(status)) {
    return jsonError(422, "BAD_STATUS", "Unknown status");
  }

  const current = await prisma.quotation.findUnique({ where: { id }, select: { status: true } });
  if (!current) return jsonError(404, "NOT_FOUND", "Quotation not found");

  if (current.status !== status) {
    await prisma.$transaction([
      prisma.quotation.update({ where: { id }, data: { status } }),
      prisma.statusHistory.create({
        data: { quotationId: id, fromStatus: current.status, toStatus: status, note },
      }),
    ]);
  }
  return NextResponse.json({ id, status });
}

/** Delete a quotation and its cascade, plus the PDF and any model files no
 *  longer referenced by another quotation. */
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  const { id } = await ctx.params;

  const quotation = await prisma.quotation.findUnique({
    where: { id },
    include: { items: { select: { modelId: true } } },
  });
  if (!quotation) return jsonError(404, "NOT_FOUND", "Quotation not found");

  await removeQuietly(quotation.pdfPath);
  const modelIds = [...new Set(quotation.items.map((i) => i.modelId))];

  await prisma.quotation.delete({ where: { id } }); // cascades items + history

  for (const modelId of modelIds) {
    const stillReferenced = await prisma.quotationItem.count({ where: { modelId } });
    if (stillReferenced > 0) continue;
    const model = await prisma.uploadedModel.findUnique({ where: { id: modelId } });
    if (!model) continue;
    await removeQuietly(model.storedPath);
    await removeQuietly(model.thumbPath);
    await prisma.uploadedModel.delete({ where: { id: modelId } });
  }

  return NextResponse.json({ deleted: true });
}
