import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import pino from "pino";
import { Prisma, prisma } from "@print/db";
import { parseModel, renderThumbnail } from "@print/geometry";
import { SLICE_QUEUE, type SliceJobData } from "@print/shared";
import { config } from "./config.js";
import { runSlice } from "./orca.js";
import { runRetention } from "./retention.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

function redisOptions() {
  const u = new URL(config.redisUrl);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    password: u.password || undefined,
    maxRetriesPerRequest: null as null,
  };
}

async function processJob(job: Job<SliceJobData>): Promise<void> {
  const { sliceResultId, modelId, settings, storedPath, format } = job.data;
  const workDir = join(config.workRoot, job.id ?? sliceResultId);

  await prisma.sliceResult.update({
    where: { id: sliceResultId },
    data: { status: "RUNNING" },
  });

  try {
    const outcome = await runSlice(storedPath, settings, workDir);

    if (!outcome.ok) {
      await prisma.sliceResult.update({
        where: { id: sliceResultId },
        data: {
          status: "FAILED",
          slicerVersion: outcome.slicerVersion,
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
          rawMeta: outcome.rawMeta as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      log.warn({ modelId, sliceResultId, code: outcome.errorCode }, "slice failed");
      return;
    }

    await prisma.sliceResult.update({
      where: { id: sliceResultId },
      data: {
        status: "DONE",
        filamentGrams: outcome.filamentGrams,
        filamentMm: outcome.filamentMm,
        printSeconds: outcome.printSeconds,
        supportGrams: outcome.supportGrams,
        slicerVersion: outcome.slicerVersion,
        rawMeta: outcome.rawMeta as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });

    await ensureThumbnail(modelId, storedPath, format);
    log.info({ modelId, sliceResultId, grams: outcome.filamentGrams }, "slice done");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Render + persist a model thumbnail once (first slice wins). Thumbnails live
 *  beside the model file so web and worker agree on the path regardless of cwd. */
async function ensureThumbnail(modelId: string, storedPath: string, format: string): Promise<void> {
  const model = await prisma.uploadedModel.findUnique({ where: { id: modelId } });
  if (!model || model.thumbPath) return;

  try {
    const buf = await readFile(storedPath);
    const parsed = parseModel(buf, format);
    const png = renderThumbnail(parsed.positions, config.thumbSize);

    const thumbDir = join(dirname(storedPath), "thumbs");
    await mkdir(thumbDir, { recursive: true });
    const thumbPath = join(thumbDir, `${modelId}.png`);
    await writeFile(thumbPath, png);

    await prisma.uploadedModel.update({ where: { id: modelId }, data: { thumbPath } });
  } catch (err) {
    // A thumbnail is a nicety; never fail the slice because of it.
    log.warn({ modelId, err: String(err) }, "thumbnail render failed");
  }
}

const worker = new Worker<SliceJobData>(SLICE_QUEUE, processJob, {
  connection: redisOptions(),
  concurrency: config.concurrency,
});

worker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, "job errored");
});
worker.on("ready", () => log.info({ concurrency: config.concurrency }, "slice worker ready"));

// --- daily data-retention sweep (repeatable) ---
const MAINTENANCE_QUEUE = "maintenance";
const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection: redisOptions() });
await maintenanceQueue.add(
  "retention",
  {},
  {
    repeat: { every: 24 * 3600 * 1000 },
    jobId: "retention",
    removeOnComplete: true,
    removeOnFail: 20,
  },
);
const maintenanceWorker = new Worker(
  MAINTENANCE_QUEUE,
  async () => {
    await runRetention(log);
  },
  { connection: redisOptions() },
);
maintenanceWorker.on("failed", (_job, err) =>
  log.error({ err: err.message }, "retention job failed"),
);

// Liveness key for the container healthcheck.
const heartbeat = new IORedis(redisOptions());
const beat = setInterval(() => {
  heartbeat.set("worker:heartbeat", Date.now(), "EX", 30).catch(() => {});
}, 10_000);

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  clearInterval(beat);
  await worker.close();
  await maintenanceWorker.close();
  await maintenanceQueue.close();
  await heartbeat.quit().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
