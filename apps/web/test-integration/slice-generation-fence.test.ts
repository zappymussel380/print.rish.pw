import { randomBytes } from "node:crypto";
import type { Queue } from "bullmq";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../../packages/db/generated/client/index.js";
import {
  sliceArtifactKey,
  sliceJobId,
  type SliceJobData,
  type SliceSettings,
} from "@print/shared";
import {
  assertSameDatabaseEndpoint,
  integrationConnection,
} from "./support/connections";

const requestSession = vi.hoisted(() => ({
  id: "c316207c-a790-44ae-b769-5e97727f4b74",
}));

// Route handlers normally obtain this from Next's request-scoped cookie store.
// Keep every database, Redis, queue, and state-transition dependency real.
vi.mock("@/lib/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...original,
    getQuoteSessionId: async () => requestSession.id,
  };
});

function clearProcessSingletons(): void {
  const globals = globalThis as typeof globalThis & {
    prisma?: unknown;
    redis?: unknown;
    sliceQueue?: unknown;
  };
  delete globals.prisma;
  delete globals.redis;
  delete globals.sliceQueue;
}

describe("slice retry generation fence", () => {
  it("rejects a stale worker write after the retry route rotates attempt identity", async () => {
    const webConnection = integrationConnection("DATABASE_URL", "print_web");
    const workerConnection = integrationConnection("WORKER_DATABASE_URL", "print_worker");
    const ownerConnection = integrationConnection("MIGRATION_DATABASE_URL", "print_owner");
    assertSameDatabaseEndpoint(webConnection, workerConnection, ownerConnection);

    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = webConnection.url;

    const webPrisma = new PrismaClient({ datasourceUrl: webConnection.url });
    const ownerPrisma = new PrismaClient({ datasourceUrl: ownerConnection.url });
    let routePrisma: PrismaClient | undefined;
    let workerPrisma: PrismaClient | undefined;
    let queue: Queue<SliceJobData> | undefined;
    let sharedRedis: (Awaited<typeof import("@/lib/redis")>)["redis"] | undefined;
    let queuedJobId: string | undefined;

    const modelId = crypto.randomUUID();
    const sliceId = crypto.randomUUID();
    const staleAttemptId = crypto.randomUUID();
    const fileHash = randomBytes(32).toString("hex");
    const settings: SliceSettings = {
      material: "PLA",
      layerHeightUm: 200,
      infillPct: 15,
      supports: "auto",
    };
    const settingsKey = sliceArtifactKey("stl", settings);
    const clientIp = "192.0.2.173";

    try {
      await ownerPrisma.uploadedModel.create({
        data: {
          id: modelId,
          sessionId: requestSession.id,
          originalName: "generation-fence.stl",
          storedPath: `/tmp/${modelId}.stl`,
          fileHash,
          sizeBytes: 128,
          format: "stl",
        },
      });
      await webPrisma.sliceResult.create({
        data: {
          id: sliceId,
          attemptId: staleAttemptId,
          fileHash,
          settingsKey,
          settingsJson: settings,
          status: "FAILED",
          progressPct: 91,
          progressStage: "failed",
          progressMessage: "Slicing failed",
          slicerVersion: "2.4.1",
        },
      });
      await webPrisma.sliceResult.update({
        where: { id: sliceId },
        data: {
          errorCode: "NO_OUTPUT",
          errorMessage: "Old attempt failed",
          completedAt: new Date(),
        },
      });

      const [{ POST }, dbModule, queueModule, redisModule] = await Promise.all([
        import("@/app/api/slices/route"),
        import("@print/db"),
        import("@/lib/queue"),
        import("@/lib/redis"),
      ]);
      routePrisma = dbModule.prisma;
      queue = queueModule.getSliceQueue();
      sharedRedis = redisModule.redis;

      const origin = process.env.APP_ORIGIN ?? "http://localhost:3000";
      const response = await POST(
        new NextRequest(`${origin}/api/slices`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin,
            "x-real-ip": clientIp,
          },
          body: JSON.stringify({ modelId, settings }),
        }),
      );

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        sliceId,
        status: "queued",
        progress: {
          percent: 0,
          stage: "queued",
          message: "Waiting for a slicer",
        },
        error: null,
      });

      const retried = await webPrisma.sliceResult.findUniqueOrThrow({ where: { id: sliceId } });
      expect(retried).toMatchObject({
        id: sliceId,
        status: "QUEUED",
        progressPct: 0,
        progressStage: "queued",
        progressMessage: "Waiting for a slicer",
        errorCode: null,
        errorMessage: null,
        completedAt: null,
      });
      expect(retried.attemptId).not.toBe(staleAttemptId);

      queuedJobId = sliceJobId(fileHash, settingsKey, retried.attemptId);
      const queuedJob = await queue.getJob(queuedJobId);
      expect(queuedJob?.data).toMatchObject({
        sliceResultId: sliceId,
        attemptId: retried.attemptId,
        modelId,
        fileHash,
        settingsKey,
        settings,
      });

      // Model the new generation having reached the worker. Keeping the row in
      // RUNNING makes the old attempt id the only reason the late write misses.
      await webPrisma.sliceResult.update({
        where: { id: sliceId },
        data: {
          status: "RUNNING",
          progressPct: 12,
          progressStage: "slicing",
          progressMessage: "New attempt is slicing",
        },
      });

      await routePrisma.$disconnect();
      routePrisma = undefined;
      delete (globalThis as typeof globalThis & { prisma?: unknown }).prisma;
      vi.resetModules();
      process.env.DATABASE_URL = workerConnection.url;

      const [sliceState, workerDbModule] = await Promise.all([
        import("../../worker/src/slice-state.js"),
        import("@print/db"),
      ]);
      workerPrisma = workerDbModule.prisma;

      const [identity] = await workerPrisma.$queryRaw<Array<{ role: string }>>`
        SELECT current_user::text AS role
      `;
      expect(identity?.role).toBe("print_worker");

      const stalePersisted = await sliceState.updateRunningSliceAttempt(
        {
          id: sliceId,
          attemptId: staleAttemptId,
          fileHash,
          settingsKey,
        },
        {
          status: "DONE",
          progressPct: 100,
          progressStage: "complete",
          progressMessage: "Stale attempt completed",
          filamentGrams: 999,
          filamentMm: 99_999,
          printSeconds: 99_999,
          supportGrams: 99,
          slicerVersion: "stale-worker",
          rawMeta: { stale: true },
          completedAt: new Date(),
        },
      );
      expect(stalePersisted).toBe(false);

      const afterStaleWrite = await webPrisma.sliceResult.findUniqueOrThrow({
        where: { id: sliceId },
      });
      expect(afterStaleWrite).toMatchObject({
        attemptId: retried.attemptId,
        status: "RUNNING",
        progressPct: 12,
        progressStage: "slicing",
        progressMessage: "New attempt is slicing",
        filamentGrams: null,
        filamentMm: null,
        printSeconds: null,
        supportGrams: null,
        slicerVersion: "2.4.1",
        rawMeta: null,
        completedAt: null,
      });
    } finally {
      if (queue) {
        if (queuedJobId) await queue.remove(queuedJobId).catch(() => {});
        await queue.close().catch(() => {});
      }
      if (sharedRedis) {
        await sharedRedis.del(`rl:slice:${clientIp}`).catch(() => {});
        await sharedRedis.quit().catch(() => {});
      }
      if (routePrisma) await routePrisma.$disconnect().catch(() => {});
      if (workerPrisma) await workerPrisma.$disconnect().catch(() => {});
      await ownerPrisma.uploadedModel.deleteMany({ where: { id: modelId } }).catch(() => {});
      await ownerPrisma.sliceResult.deleteMany({ where: { id: sliceId } }).catch(() => {});
      await webPrisma.$disconnect().catch(() => {});
      await ownerPrisma.$disconnect().catch(() => {});

      process.env.DATABASE_URL = originalDatabaseUrl;
      clearProcessSingletons();
      vi.resetModules();
    }
  });
});
