import { NextResponse } from "next/server";
import { prisma } from "@print/db";
import { redis } from "@/lib/redis";
import { sendOperatorAlert } from "@/lib/telegram";
import { createWorkerHeartbeatAlertMonitor } from "@/lib/worker-heartbeat-alert";

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
const workerHeartbeatMonitor = createWorkerHeartbeatAlertMonitor((message) =>
  sendOperatorAlert("worker_heartbeat", message),
);

async function checkHealth(): Promise<HealthSnapshot> {
  const [db, cache, workerHeartbeat] = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    redis.ping(),
    redis.exists("worker:heartbeat"),
  ]);
  const dbOk = db.status === "fulfilled";
  const redisOk = cache.status === "fulfilled" && cache.value === "PONG";
  workerHeartbeatMonitor.observe(
    redisOk && workerHeartbeat.status === "fulfilled" && workerHeartbeat.value === 1,
  );
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
