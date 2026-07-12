import { NextResponse, type NextRequest } from "next/server";
import { type QuotationStatus, prisma } from "@print/db";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { modelPath, pdfPath, removeQuietly, thumbPath } from "@/lib/storage";

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
const TERMINAL_STATUSES = new Set<QuotationStatus>(["COMPLETED", "DELIVERED", "CANCELLED"]);

/** Update a quotation's status, recording the transition in StatusHistory. */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  const { id } = await ctx.params;

  const parsedBody = await readJsonBody(request, 8 * 1024);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;
  const status = (body as { status?: unknown })?.status as QuotationStatus;
  const note =
    typeof (body as { note?: unknown })?.note === "string"
      ? (body as { note: string }).note.trim().slice(0, 2000)
      : "";
  if (!STATUSES.includes(status)) {
    return jsonError(422, "BAD_STATUS", "Unknown status");
  }

  const current = await prisma.quotation.findUnique({ where: { id }, select: { status: true } });
  if (!current) return jsonError(404, "NOT_FOUND", "Quotation not found");

  // Terminal status is immutable. Retention is allowed to purge its model
  // files after the age threshold; permitting a concurrent reopen would make
  // it impossible to establish a safe file-lifetime boundary.
  if (TERMINAL_STATUSES.has(current.status) && current.status !== status) {
    return jsonError(409, "TERMINAL_STATUS", "A terminal quotation cannot be reopened");
  }

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
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  const { id } = await ctx.params;

  const quotation = await prisma.quotation.findUnique({
    where: { id },
    include: { items: { select: { modelId: true } } },
  });
  if (!quotation) return jsonError(404, "NOT_FOUND", "Quotation not found");

  const modelIds = [...new Set(quotation.items.map((i) => i.modelId))];

  await prisma.quotation.delete({ where: { id } }); // cascades items + history
  await removeQuietly(pdfPath(quotation.number));

  for (const modelId of modelIds) {
    const model = await prisma.uploadedModel.findUnique({ where: { id: modelId } });
    if (!model) continue;
    // Claim deletion atomically before touching files. A concurrent checkout
    // that attached this model after the quotation delete wins the race and
    // makes count=0, so its durable model can never be unlinked underneath it.
    const { count } = await prisma.uploadedModel.deleteMany({
      where: { id: modelId, items: { none: {} } },
    });
    if (count === 0) continue;
    await removeQuietly(modelPath(model.id, model.format));
    await removeQuietly(thumbPath(model.id));
  }

  return NextResponse.json({ deleted: true });
}
