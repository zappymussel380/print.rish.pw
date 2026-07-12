import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAdminApi } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { destroyAdminSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  await destroyAdminSession();
  return NextResponse.json({ ok: true });
}
