import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { jsonError } from "@/lib/api-util";
import { serializeSlice } from "@/lib/slice-serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Poll a slice by its result-row id. The id is an unguessable uuid handed to
 *  the client by POST /api/slices; the stats it exposes are non-sensitive. */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const row = await prisma.sliceResult.findUnique({ where: { id } });
  if (!row) return jsonError(404, "NOT_FOUND", "Unknown slice");
  return NextResponse.json(serializeSlice(row));
}
