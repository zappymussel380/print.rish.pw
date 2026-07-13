import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Queue, QueueEvents, Worker, type Job } from "bullmq";
import Redis from "ioredis";
import pino from "pino";
import {
  INGEST_ADMISSION_KEY,
  UPLOAD_STORAGE_RESERVATION_KEY,
  type IngestJobData,
  type IngestJobResult,
} from "@print/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getIngestCountAhead } from "@/lib/ingest-queue";
import {
  assertSameDatabaseEndpoint,
  integrationConnection,
} from "./support/connections";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function redisConnection(raw: string) {
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, "");
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: database ? Number(database) : 0,
    tls: url.protocol === "rediss:" ? { servername: url.hostname } : undefined,
    maxRetriesPerRequest: null,
  };
}

function disposableRedisUrl(): string {
  const raw = process.env.REDIS_URL;
  if (!raw) throw new Error("REDIS_URL is required for ingest integration tests");
  const url = new URL(raw);
  if (!["redis:", "rediss:"].includes(url.protocol)) {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error("Ingest integration tests require a loopback disposable Redis service");
  }
  return raw;
}

const webConnection = integrationConnection("DATABASE_URL", "print_web");
const workerConnection = integrationConnection("WORKER_DATABASE_URL", "print_worker");
assertSameDatabaseEndpoint(webConnection, workerConnection);
const redisUrl = disposableRedisUrl();

const originalEnv = {
  databaseUrl: process.env.DATABASE_URL,
  uploadDir: process.env.UPLOAD_DIR,
  maxModels: process.env.MAX_MODELS_PER_SESSION,
  maxUploadMb: process.env.MAX_UPLOAD_MB,
  maxSessionUploadMb: process.env.MAX_SESSION_UPLOAD_MB,
  storageReserveMb: process.env.STORAGE_RESERVE_MB,
  thumbSize: process.env.THUMB_SIZE,
};

const sessionId = randomUUID();
const firstTicket = randomUUID();
const secondTicket = randomUUID();
const queueName = `ingest-integration-${process.pid}-${randomUUID()}`;
const cubeFixture = fileURLToPath(
  new URL("../../../packages/geometry/fixtures/cube.stl", import.meta.url),
);
const log = pino({ enabled: false });

let storageRoot = "";
let uploadDir = "";
let cube = Buffer.alloc(0);
let workerPrisma: typeof import("@print/db").prisma;
let processIngestJob: typeof import("../../worker/src/ingest.js").processIngestJob;
let ingestWorkerOptions: typeof import("../../worker/src/ingest.js").INGEST_WORKER_OPTIONS;
let queue: Queue<IngestJobData, IngestJobResult> | undefined;
let queueEvents: QueueEvents | undefined;
let worker: Worker<IngestJobData, IngestJobResult> | undefined;
let markerRedis: Redis | undefined;
let firstRelease: ReturnType<typeof deferred> | undefined;
const reservationMembers: string[] = [];

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function jobData(tmpName: string, originalName: string): IngestJobData {
  const reservationMember = `${cube.length}:${randomUUID()}`;
  reservationMembers.push(reservationMember);
  return {
    tmpName,
    sessionId,
    originalName,
    format: "stl",
    sizeBytes: cube.length,
    sha256: createHash("sha256").update(cube).digest("hex"),
    reservationMember,
  };
}

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "print-ingest-integration-"));
  uploadDir = join(storageRoot, "uploads");
  await mkdir(join(uploadDir, "tmp"), { recursive: true });
  cube = await readFile(cubeFixture);

  // Worker config and @print/db are import-time singletons. Select the worker
  // role and isolated storage before importing either, and evict any client a
  // reused Vitest fork may have cached for another integration file.
  process.env.DATABASE_URL = workerConnection.url;
  process.env.UPLOAD_DIR = uploadDir;
  process.env.MAX_MODELS_PER_SESSION = "1";
  process.env.MAX_UPLOAD_MB = "10";
  process.env.MAX_SESSION_UPLOAD_MB = "20";
  process.env.STORAGE_RESERVE_MB = "1";
  process.env.THUMB_SIZE = "64";
  vi.stubEnv("NODE_ENV", "test");
  delete (globalThis as { prisma?: unknown }).prisma;
  vi.resetModules();

  ({ prisma: workerPrisma } = await import("@print/db"));
  ({ processIngestJob, INGEST_WORKER_OPTIONS: ingestWorkerOptions } = await import(
    "../../worker/src/ingest.js"
  ));

  markerRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  queue = new Queue<IngestJobData, IngestJobResult>(queueName, {
    connection: redisConnection(redisUrl),
  });
  queueEvents = new QueueEvents(queueName, { connection: redisConnection(redisUrl) });
  await Promise.all([queue.waitUntilReady(), queueEvents.waitUntilReady(), markerRedis.ping()]);
});

afterAll(async () => {
  firstRelease?.resolve();
  await worker?.close(true).catch(() => {});
  await queue?.obliterate({ force: true }).catch(() => {});
  await Promise.all([queueEvents?.close(), queue?.close()]);

  if (markerRedis) {
    if (reservationMembers.length > 0) {
      await markerRedis
        .zrem(UPLOAD_STORAGE_RESERVATION_KEY, ...reservationMembers)
        .catch(() => {});
    }
    await markerRedis.zrem(INGEST_ADMISSION_KEY, firstTicket, secondTicket).catch(() => {});
    await markerRedis.quit().catch(() => {});
  }

  if (workerPrisma) {
    await workerPrisma.uploadedModel.deleteMany({ where: { sessionId } }).catch(() => {});
    await workerPrisma.$disconnect().catch(() => {});
  }
  delete (globalThis as { prisma?: unknown }).prisma;
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });

  restore("DATABASE_URL", originalEnv.databaseUrl);
  restore("UPLOAD_DIR", originalEnv.uploadDir);
  restore("MAX_MODELS_PER_SESSION", originalEnv.maxModels);
  restore("MAX_UPLOAD_MB", originalEnv.maxUploadMb);
  restore("MAX_SESSION_UPLOAD_MB", originalEnv.maxSessionUploadMb);
  restore("STORAGE_RESERVE_MB", originalEnv.storageReserveMb);
  restore("THUMB_SIZE", originalEnv.thumbSize);
  vi.unstubAllEnvs();
});

describe("worker upload ingest queue", () => {
  it("processes FIFO at concurrency one and cleans success and limit-failure state", async () => {
    if (!queue || !queueEvents || !markerRedis) throw new Error("Integration queue not ready");

    const firstTmpName = randomUUID();
    const secondTmpName = randomUUID();
    const firstData = jobData(firstTmpName, "first-cube.stl");
    const secondData = jobData(secondTmpName, "second-cube.stl");
    const firstTmpPath = join(uploadDir, "tmp", firstTmpName);
    const secondTmpPath = join(uploadDir, "tmp", secondTmpName);
    await Promise.all([
      writeFile(firstTmpPath, cube, { mode: 0o600 }),
      writeFile(secondTmpPath, cube, { mode: 0o600 }),
      markerRedis.zadd(
        UPLOAD_STORAGE_RESERVATION_KEY,
        Date.now() + 60_000,
        firstData.reservationMember,
        Date.now() + 60_000,
        secondData.reservationMember,
      ),
      markerRedis.zadd(
        INGEST_ADMISSION_KEY,
        Date.now() + 60_000,
        firstTicket,
        Date.now() + 60_000,
        secondTicket,
      ),
    ]);

    const firstJob = await queue.add("ingest", firstData, {
      jobId: firstTicket,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });
    const secondJob = await queue.add("ingest", secondData, {
      jobId: secondTicket,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });

    expect(await getIngestCountAhead(queue, firstTicket)).toBe(0);
    expect(await getIngestCountAhead(queue, secondTicket)).toBe(1);
    expect(ingestWorkerOptions.concurrency).toBe(1);

    const firstEntered = deferred();
    firstRelease = deferred();
    const processingOrder: string[] = [];
    let activeProcessors = 0;
    let maximumActiveProcessors = 0;
    let modelsVisibleBeforeSecond = -1;

    worker = new Worker<IngestJobData, IngestJobResult>(
      queueName,
      async (job: Job<IngestJobData, IngestJobResult>) => {
        activeProcessors += 1;
        maximumActiveProcessors = Math.max(maximumActiveProcessors, activeProcessors);
        processingOrder.push(job.id!);
        try {
          if (job.id === firstTicket) {
            firstEntered.resolve();
            await firstRelease!.promise;
          } else if (job.id === secondTicket) {
            modelsVisibleBeforeSecond = await workerPrisma.uploadedModel.count({
              where: { sessionId, items: { none: {} } },
            });
          }
          return await processIngestJob(job, { redis: markerRedis!, log });
        } finally {
          activeProcessors -= 1;
        }
      },
      { connection: redisConnection(redisUrl), ...ingestWorkerOptions },
    );
    await worker.waitUntilReady();
    await firstEntered.promise;

    expect(await firstJob.getState()).toBe("active");
    expect(await secondJob.getState()).toBe("waiting");
    expect(await getIngestCountAhead(queue, secondTicket)).toBe(1);
    expect(maximumActiveProcessors).toBe(1);

    const firstFinished = firstJob.waitUntilFinished(queueEvents, 20_000);
    const secondFinished = secondJob.waitUntilFinished(queueEvents, 20_000).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    firstRelease.resolve();

    const firstResult = await firstFinished;
    const secondOutcome = await secondFinished;
    expect(secondOutcome.ok).toBe(false);
    if (secondOutcome.ok) throw new Error("Second ingest unexpectedly succeeded");
    expect(String(secondOutcome.error)).toContain("Ingest failed (TOO_MANY_MODELS)");
    expect(processingOrder).toEqual([firstTicket, secondTicket]);
    expect(maximumActiveProcessors).toBe(1);
    expect(modelsVisibleBeforeSecond).toBe(1);

    const [identity] = await workerPrisma.$queryRaw<{ role: string }[]>`
      SELECT current_user::text AS role
    `;
    expect(identity?.role).toBe(workerConnection.username);
    const rows = await workerPrisma.uploadedModel.findMany({
      where: { sessionId },
      select: { id: true, originalName: true, storedPath: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.originalName).toBe("first-cube.stl");
    expect(firstResult.models).toHaveLength(1);
    expect(firstResult.models[0]?.id).toBe(rows[0]?.id);
    await expect(access(rows[0]!.storedPath!)).resolves.toBeUndefined();

    const failedJob = await queue.getJob(secondTicket);
    expect(failedJob?.data.publicFailure).toMatchObject({ code: "TOO_MANY_MODELS" });

    await expect(access(firstTmpPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(secondTmpPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      markerRedis.zscore(UPLOAD_STORAGE_RESERVATION_KEY, firstData.reservationMember),
    ).resolves.toBeNull();
    await expect(
      markerRedis.zscore(UPLOAD_STORAGE_RESERVATION_KEY, secondData.reservationMember),
    ).resolves.toBeNull();
    await expect(markerRedis.zscore(INGEST_ADMISSION_KEY, firstTicket)).resolves.toBeNull();
    await expect(markerRedis.zscore(INGEST_ADMISSION_KEY, secondTicket)).resolves.toBeNull();
  });
});
