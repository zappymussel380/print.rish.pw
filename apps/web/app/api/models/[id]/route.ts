import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { guardMutation, jsonError } from "@/lib/api-util";
import { RATE_LIMITS } from "@/lib/security";
import { getQuoteSessionId } from "@/lib/session";
import { modelPath, removeQuietly, thumbPath } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Remove a model from the current quote session (only if it never became
 *  part of a submitted quotation). */
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await guardMutation(request, "modelMutation", RATE_LIMITS.modelMutation);
  if (guard) return guard;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return jsonError(404, "NOT_FOUND", "Model not found in this session");
  const sessionId = await getQuoteSessionId();
  if (!sessionId) return jsonError(401, "NO_SESSION", "No quote session");

  const model = await prisma.uploadedModel.findFirst({
    where: { id, sessionId },
  });
  if (!model) return jsonError(404, "NOT_FOUND", "Model not found in this session");
  const { count } = await prisma.uploadedModel.deleteMany({
    where: { id: model.id, sessionId, items: { none: {} } },
  });
  if (count === 0) {
    return jsonError(409, "IN_QUOTATION", "Model already belongs to a submitted quotation");
  }

  await removeQuietly(modelPath(model.id, model.format));
  await removeQuietly(thumbPath(model.id));

  return NextResponse.json({ deleted: true });
}
