import { NextResponse } from "next/server";
import { prisma } from "@print/db";
import { redis } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness/readiness probe: verifies Postgres and Redis are reachable. */
export async function GET() {
  const [db, cache] = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    redis.ping(),
  ]);

  const dbOk = db.status === "fulfilled";
  const redisOk = cache.status === "fulfilled" && cache.value === "PONG";
  const ok = dbOk && redisOk;

  return NextResponse.json(
    { ok, db: dbOk, redis: redisOk },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
