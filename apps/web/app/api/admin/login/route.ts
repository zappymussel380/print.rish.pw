import bcrypt from "bcryptjs";
import { NextResponse, type NextRequest } from "next/server";
import { guardMutation, jsonError, readJsonBody } from "@/lib/api-util";
import { env } from "@/lib/env";
import { RATE_LIMITS, withRedisLock } from "@/lib/security";
import { createAdminSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A password in a JSON wrapper — anything bigger is abuse.
const MAX_BODY_BYTES = 4 * 1024;

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "adminLogin", RATE_LIMITS.adminLogin);
  if (guard) return guard;

  const parsedBody = await readJsonBody(request, MAX_BODY_BYTES);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;
  const password = (body as { password?: unknown })?.password;
  if (
    typeof password !== "string" ||
    password.length === 0 ||
    Buffer.byteLength(password, "utf8") > 72
  ) {
    return jsonError(422, "MISSING_PASSWORD", "Enter the admin password");
  }

  // bcryptjs is intentionally expensive and CPU-bound. Serialize verifications
  // across replicas so a distributed source cannot run many hashes in parallel.
  const ok = await withRedisLock(
    "admin-password-verify",
    () => bcrypt.compare(password, env.adminPasswordHash).catch(() => false),
    { leaseMs: 5_000, waitMs: 1_000 },
  );
  if (ok === null) return jsonError(503, "LOGIN_BUSY", "Login is busy. Please retry.");
  if (!ok) return jsonError(401, "INVALID_CREDENTIALS", "Incorrect password");

  await createAdminSession();
  return NextResponse.json({ ok: true });
}
