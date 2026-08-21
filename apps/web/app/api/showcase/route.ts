import { NextResponse } from "next/server";
import { toPublicRecentPrints } from "@print/shared";
import { getRecentPrints } from "@/lib/recent-prints";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public: the curated showcase of recent prints, in display order. */
export async function GET() {
  const prints = await getRecentPrints();
  return NextResponse.json(
    { prints: toPublicRecentPrints(prints) },
    { headers: { "Cache-Control": "public, max-age=30, s-maxage=30" } },
  );
}
