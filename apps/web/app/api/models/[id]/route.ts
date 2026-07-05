import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { jsonError } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { getQuoteSessionId } from "@/lib/session";
import { removeQuietly } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Remove a model from the current quote session (only if it never became
 *  part of a submitted quotation). */
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");

  const { id } = await ctx.params;
  const sessionId = await getQuoteSessionId();
  if (!sessionId) return jsonError(401, "NO_SESSION", "No quote session");

  const model = await prisma.uploadedModel.findFirst({
    where: { id, sessionId },
    include: { _count: { select: { items: true } } },
  });
  if (!model) return jsonError(404, "NOT_FOUND", "Model not found in this session");
  if (model._count.items > 0) {
    return jsonError(409, "IN_QUOTATION", "Model already belongs to a submitted quotation");
  }

  await prisma.uploadedModel.delete({ where: { id: model.id } });
  await removeQuietly(model.storedPath);
  await removeQuietly(model.thumbPath);

  return NextResponse.json({ deleted: true });
}
