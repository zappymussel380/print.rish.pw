import { NextResponse } from "next/server";
import { prisma } from "@print/db";
import { redis } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface HealthSnapshot {
  ok: boolean;
  db: boolean;
  redis: boolean;
  checkedAt: number;
}

let cached: HealthSnapshot | null = null;
let pending: Promise<HealthSnapshot> | null = null;
const CACHE_MS = 5_000;

async function checkHealth(): Promise<HealthSnapshot> {
  const [db, cache] = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    redis.ping(),
  ]);
  const dbOk = db.status === "fulfilled";
  const redisOk = cache.status === "fulfilled" && cache.value === "PONG";
  return { ok: dbOk && redisOk, db: dbOk, redis: redisOk, checkedAt: Date.now() };
}

/** Liveness/readiness probe: verifies Postgres and Redis are reachable. */
export async function GET() {
  if (!cached || Date.now() - cached.checkedAt >= CACHE_MS) {
    pending ??= checkHealth().finally(() => {
      pending = null;
    });
    cached = await pending;
  }

  return NextResponse.json(
    { ok: cached.ok, db: cached.db, redis: cached.redis },
    { status: cached.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
