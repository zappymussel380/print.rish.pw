import bcrypt from "bcryptjs";
import { NextResponse, type NextRequest } from "next/server";
import { guardMutation, jsonError } from "@/lib/api-util";
import { env } from "@/lib/env";
import { RATE_LIMITS } from "@/lib/security";
import { createAdminSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "adminLogin", RATE_LIMITS.adminLogin);
  if (guard) return guard;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "BAD_JSON", "Request body must be JSON");
  }
  const password = (body as { password?: unknown })?.password;
  if (typeof password !== "string" || password.length === 0) {
    return jsonError(422, "MISSING_PASSWORD", "Enter the admin password");
  }

  const ok = await bcrypt.compare(password, env.adminPasswordHash).catch(() => false);
  if (!ok) return jsonError(401, "INVALID_CREDENTIALS", "Incorrect password");

  await createAdminSession();
  return NextResponse.json({ ok: true });
}
