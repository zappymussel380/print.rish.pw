import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import pino from "pino";
import { Prisma, prisma } from "@print/db";
import { parseModel, renderThumbnail } from "@print/geometry";
import {
  SLICE_QUEUE,
  SLICE_PIPELINE_VERSION,
  sliceArtifactKey,
  sliceSettingsSchema,
  type SliceJobData,
  type SliceProgressStage,
} from "@print/shared";
import { config } from "./config.js";
import { runSlice, type SlicerIdentity } from "./orca.js";
import { runRetention } from "./retention.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLACEHOLDER_RE = /^(?:change-me|changeme|password|secret|example)(?:[-_].*)?$/i;

if (!SLICE_PIPELINE_VERSION.includes(`orca-${config.slicerVersion}-`)) {
  throw new Error(
    `ORCA_VERSION ${config.slicerVersion} does not match slice cache version ${SLICE_PIPELINE_VERSION}`,
  );
}

for (const [name, raw, protocols] of [
  ["DATABASE_URL", process.env.DATABASE_URL, ["postgres:", "postgresql:"]],
  ["REDIS_URL", config.redisUrl, ["redis:", "rediss:"]],
] as const) {
  if (!raw) throw new Error(`Missing required environment variable ${name}`);
  const url = new URL(raw);
  const password = decodeURIComponent(url.password);
  const passwordInvalid = Buffer.byteLength(password, "utf8") < 32 || PLACEHOLDER_RE.test(password);
  if (
    !(protocols as readonly string[]).includes(url.protocol) ||
    (process.env.NODE_ENV === "production" && passwordInvalid)
  ) {
    throw new Error(`${name} must use the expected protocol and a non-placeholder password`);
  }
}

const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
if (!runningAsRoot && !config.allowInsecureSlicer) {
  throw new Error(
    "Refusing to run Orca under the credential-bearing worker UID; use the hardened container or explicitly set ALLOW_INSECURE_SLICER=true for local development",
  );
}
if (
  config.slicerUid < 1000 ||
  config.slicerGid < 1000 ||
  config.slicerUid + config.concurrency >= 65_000 ||
  config.slicerGid + config.concurrency >= 65_000 ||
  (config.storageUid >= config.slicerUid &&
    config.storageUid < config.slicerUid + config.concurrency) ||
  (config.storageGid >= config.slicerGid &&
    config.storageGid < config.slicerGid + config.concurrency)
) {
  throw new Error("Slicer UID/GID range must be non-root, bounded, and distinct from storage ownership");
}
if (!runningAsRoot) {
  log.warn("ALLOW_INSECURE_SLICER is enabled; Orca can access worker credentials and uploads");
}

function redisOptions() {
  const u = new URL(config.redisUrl);
  const dbText = u.pathname.replace(/^\//, "");
  if (dbText && !/^\d+$/.test(dbText)) throw new Error("REDIS_URL has an invalid database index");
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: dbText ? Number(dbText) : 0,
    tls: u.protocol === "rediss:" ? { servername: u.hostname } : undefined,
    maxRetriesPerRequest: null as null,
  };
}

const availableSlicerIdentities: SlicerIdentity[] = Array.from(
  { length: config.concurrency },
  (_, index) => ({ uid: config.slicerUid + index, gid: config.slicerGid + index }),
);

function acquireSlicerIdentity(): SlicerIdentity {
  const identity = availableSlicerIdentities.pop();
  if (!identity) throw new Error("No isolated slicer identity is available");
  return identity;
}

function releaseSlicerIdentity(identity: SlicerIdentity): void {
  availableSlicerIdentities.push(identity);
}

async function processJob(job: Job<SliceJobData>): Promise<void> {
  const { sliceResultId, modelId, fileHash, settingsKey: queuedSettingsKey } = job.data;
  if (!UUID_RE.test(sliceResultId) || !UUID_RE.test(modelId)) {
    throw new Error("Queue job contains invalid identifiers");
  }
  const parsedSettings = sliceSettingsSchema.safeParse(job.data.settings);
  if (!parsedSettings.success) {
    throw new Error("Queue job contains invalid slice settings");
  }
  const settings = parsedSettings.data;
  const [model, sliceResult] = await Promise.all([
    prisma.uploadedModel.findUnique({ where: { id: modelId } }),
    prisma.sliceResult.findUnique({ where: { id: sliceResultId } }),
  ]);
  if (!model || model.fileHash !== fileHash) throw new Error("Queue job model does not match the database");
  if (
    !sliceResult ||
    sliceResult.fileHash !== fileHash ||
    sliceResult.settingsKey !== queuedSettingsKey
  ) {
    throw new Error("Queue job slice result does not match the database");
  }
  const storedPath = resolve(model.storedPath);
  const expectedPath = resolve(config.uploadDir, `${model.id}.${model.format}`);
  if (storedPath !== expectedPath || !["stl", "3mf", "obj", "amf"].includes(model.format)) {
    throw new Error("Queue job resolved outside the model storage root");
  }
  if (
    sliceArtifactKey(
      model.format as "stl" | "3mf" | "obj" | "amf",
      parsedSettings.data,
    ) !== queuedSettingsKey
  ) {
    throw new Error("Queue job cache identity does not match the model format/settings");
  }
  // BullMQ job ids are Redis-controlled input. Never place one in a filesystem
  // path: a forged "../../..." id would otherwise reach recursive rm as root.
  const workDir = join(config.workRoot, sliceResultId);

  await prisma.sliceResult.update({
    where: { id: sliceResultId },
    data: {
      status: "RUNNING",
      progressPct: 1,
      progressStage: "preparing",
      progressMessage: "Preparing model",
      progressUpdatedAt: new Date(),
    },
  });

  let lastProgress = 1;
  let queuedProgress: { percent: number; message: string; stage: SliceProgressStage } | null = null;
  let progressWriter: Promise<void> | null = null;
  let lastProgressWriteAt = 0;

  const drainProgress = async (): Promise<void> => {
    while (queuedProgress) {
      const next = queuedProgress;
      queuedProgress = null;
      const delay = Math.max(0, 1000 - (Date.now() - lastProgressWriteAt));
      if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      try {
        await prisma.sliceResult.update({
          where: { id: sliceResultId },
          data: {
            progressPct: next.percent,
            progressStage: next.stage,
            progressMessage: next.message,
            progressUpdatedAt: new Date(),
          },
        });
      } catch (err) {
        log.warn({ sliceResultId, err: String(err) }, "slice progress update failed");
      }
      lastProgressWriteAt = Date.now();
    }
  };

  const scheduleProgressWrite = () => {
    if (progressWriter) return;
    progressWriter = drainProgress().finally(() => {
      progressWriter = null;
      if (queuedProgress) scheduleProgressWrite();
    });
  };

  const reportProgress = (progress: { percent: number; message: string }) => {
    const percent = Math.min(97, Math.max(1, Math.round(progress.percent)));
    const message = progress.message.slice(0, 120);
    // Orca controls this stream. Ignore same-percent message churn and retain
    // only the newest advance; at most one DB write per second can be pending.
    if (percent <= lastProgress) return;
    lastProgress = percent;
    const stage: SliceProgressStage =
      percent < 3 ? "preparing" : percent >= 96 ? "finalizing" : "slicing";
    queuedProgress = { percent, message, stage };
    scheduleProgressWrite();
  };

  const identity = acquireSlicerIdentity();
  try {
    const outcome = await runSlice(
      {
        storedPath,
        fileHash,
        sizeBytes: model.sizeBytes,
        format: model.format,
      },
      settings,
      workDir,
      identity,
      reportProgress,
    );
    while (progressWriter) await progressWriter;

    if (!outcome.ok) {
      await prisma.sliceResult.update({
        where: { id: sliceResultId },
        data: {
          status: "FAILED",
          slicerVersion: outcome.slicerVersion,
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
          progressStage: "failed",
          progressMessage: "Slicing failed",
          progressUpdatedAt: new Date(),
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
        status: "RUNNING",
        progressPct: 98,
        progressStage: "finalizing",
        progressMessage: "Building model preview",
        progressUpdatedAt: new Date(),
        filamentGrams: outcome.filamentGrams,
        filamentMm: outcome.filamentMm,
        printSeconds: outcome.printSeconds,
        supportGrams: outcome.supportGrams,
        slicerVersion: outcome.slicerVersion,
        rawMeta: outcome.rawMeta as Prisma.InputJsonValue,
      },
    });

    await ensureThumbnail(modelId, storedPath, model.format);
    await prisma.sliceResult.update({
      where: { id: sliceResultId },
      data: {
        status: "DONE",
        progressPct: 100,
        progressStage: "complete",
        progressMessage: "Quote data ready",
        progressUpdatedAt: new Date(),
        completedAt: new Date(),
      },
    });
    log.info({ modelId, sliceResultId, grams: outcome.filamentGrams }, "slice done");
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } finally {
      releaseSlicerIdentity(identity);
    }
  }
}

/** Render + persist a model thumbnail once (first slice wins). Thumbnails live
 *  beside the model file so web and worker agree on the path regardless of cwd. */
async function ensureThumbnail(modelId: string, storedPath: string, format: string): Promise<void> {
  const model = await prisma.uploadedModel.findUnique({ where: { id: modelId } });
  if (!model || model.thumbPath) return;

  try {
    const handle = await open(storedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let buf: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== model.sizeBytes || info.size > config.maxUploadBytes) {
        throw new Error("Stored model failed the thumbnail integrity check");
      }
      buf = await handle.readFile();
    } finally {
      await handle.close().catch(() => {});
    }
    if (createHash("sha256").update(buf).digest("hex") !== model.fileHash) {
      throw new Error("Stored model hash changed before thumbnail rendering");
    }
    const parsed = parseModel(buf, format);
    const png = renderThumbnail(parsed.positions, config.thumbSize);

    const thumbDir = join(dirname(storedPath), "thumbs");
    await mkdir(thumbDir, { recursive: true, mode: 0o700 });
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      await chown(thumbDir, config.storageUid, config.storageGid);
    }
    await chmod(thumbDir, 0o700);
    const thumbPath = join(thumbDir, `${modelId}.png`);
    await writeFile(thumbPath, png, { flag: "wx", mode: 0o600 });
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      await chown(thumbPath, config.storageUid, config.storageGid);
    }
    await chmod(thumbPath, 0o600);

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
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  if (!UUID_RE.test(job.data.sliceResultId)) return;
  void prisma.sliceResult
    .updateMany({
      // A forged Redis job must not mark an unrelated cache row failed.
      where: {
        id: job.data.sliceResultId,
        fileHash: job.data.fileHash,
        settingsKey: job.data.settingsKey,
      },
      data: {
        status: "FAILED",
        errorCode: "WORKER_ERROR",
        errorMessage: "The slicer worker stopped unexpectedly",
        progressStage: "failed",
        progressMessage: "Slicing failed",
        progressUpdatedAt: new Date(),
        completedAt: new Date(),
      },
    })
    .catch((updateErr) =>
      log.error({ jobId: job.id, err: String(updateErr) }, "could not persist worker failure"),
    );
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
await maintenanceQueue.add("retention", {}, {
  jobId: "retention-startup",
  removeOnComplete: true,
  removeOnFail: 20,
});
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
