import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  chmod,
  chown,
  mkdir,
  open,
  rm,
  statfs,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import type { Logger } from "pino";
import { Prisma, prisma } from "@print/db";
import {
  INGEST_ADMISSION_KEY,
  UPLOAD_STORAGE_RESERVATION_KEY,
  UUID_PATTERN,
  UUID_RE,
  fitsBed,
  formatFromFilename,
  looksWrongScale,
  ingestJobDataSchema,
  publicIngestFailure,
  sanitizeOriginalName,
  type IngestJobData,
  type IngestJobResult,
  type IngestPublicFailure,
  type ParseChildModel,
  type UploadedModelDto,
} from "@print/shared";
import { config } from "./config.js";
import {
  ParseRunnerPublicError,
  removeParseWorkDir,
  runPreparedParse,
  type ParseRunnerOptions,
  type PreparedParse,
} from "./parse-runner.js";

const RESERVATION_RE = new RegExp(`^\\d{1,15}:${UUID_PATTERN}$`, "i");

/** Parsing runs in an isolated child process, so the event loop stays free to
 * renew this lock; two minutes only has to cover queue and I/O hiccups. A
 * stalled job is failed rather than replayed: without a database ticket row,
 * replay could persist the same upload twice. */
export const INGEST_WORKER_OPTIONS = {
  concurrency: 1,
  maxStalledCount: 0,
  lockDuration: 2 * 60_000,
} as const;

export interface IngestProcessorContext {
  redis: Pick<IORedis, "zrem">;
  log: Pick<Logger, "info" | "warn">;
  /** Tests only: overrides for the parse child spawn. */
  parse?: ParseRunnerOptions;
}

class PublicIngestError extends Error {
  constructor(readonly failure: IngestPublicFailure) {
    super(failure.code);
    this.name = "PublicIngestError";
  }
}

function rejectUpload(code: string, message: string): never {
  throw new PublicIngestError(publicIngestFailure(code, message));
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

function uploadRoot(): string {
  return resolve(config.uploadDir);
}

function tmpPathFor(tmpName: string): string {
  if (!UUID_RE.test(tmpName)) throw new Error("Ingest job has an invalid temp-file identity");
  return join(uploadRoot(), "tmp", tmpName);
}

function modelPath(modelId: string, format: string): string {
  if (!UUID_RE.test(modelId) || !["stl", "3mf", "obj", "amf"].includes(format)) {
    throw new Error("Ingest generated an invalid model storage identity");
  }
  return join(uploadRoot(), `${modelId}.${format}`);
}

function thumbnailPath(modelId: string): string {
  if (!UUID_RE.test(modelId)) throw new Error("Ingest generated an invalid thumbnail identity");
  return join(uploadRoot(), "thumbs", `${modelId}.png`);
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function setDirectoryOwnership(path: string): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    await chown(path, config.storageUid, config.storageGid);
  }
  await chmod(path, 0o700);
}

async function setFileOwnership(path: string): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    await chown(path, config.storageUid, config.storageGid);
  }
  await chmod(path, 0o600);
}

async function ensureStorageDirs(): Promise<void> {
  for (const path of [uploadRoot(), join(uploadRoot(), "tmp"), join(uploadRoot(), "thumbs")]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await setDirectoryOwnership(path);
  }
}

function validateJob(job: Job<IngestJobData, IngestJobResult>): IngestJobData {
  if (typeof job.id !== "string" || !UUID_RE.test(job.id)) {
    throw new Error("Ingest job has an invalid ticket");
  }
  const parsed = ingestJobDataSchema.safeParse(job.data);
  if (!parsed.success || parsed.data.publicFailure) {
    throw new Error("Ingest job data failed validation");
  }
  const data = parsed.data;
  if (
    sanitizeOriginalName(data.originalName) !== data.originalName ||
    formatFromFilename(data.originalName) !== data.format
  ) {
    throw new Error("Ingest job filename and format do not agree");
  }
  if (data.sizeBytes > config.maxUploadBytes) {
    throw new Error("Ingest job exceeds the configured upload limit");
  }
  const reservedBytes = Number(data.reservationMember.slice(0, data.reservationMember.indexOf(":")));
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < data.sizeBytes) {
    throw new Error("Ingest job has an invalid storage reservation");
  }
  return data;
}

/** Copy a child-produced artifact into customer storage, recomputing the hash
 * in transit. The child is untrusted: a forged fileHash could otherwise poison
 * the global (fileHash, settingsKey) slice-result cache across customers. */
async function copyVerifiedArtifact(
  sourcePath: string,
  destination: string,
  expectedBytes: number,
  expectedHash: string,
): Promise<void> {
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let copiedBytes = 0;
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size !== expectedBytes) {
      throw new Error("Parse child artifact failed its size integrity check");
    }
    const reader = source.createReadStream({ autoClose: false });
    reader.on("data", (chunk: string | Buffer) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      copiedBytes += data.length;
      hash.update(data);
    });
    const writer = createWriteStream(destination, { flags: "wx", mode: 0o600 });
    await pipeline(reader, writer);
  } finally {
    await source.close().catch(() => {});
  }
  if (copiedBytes !== expectedBytes || hash.digest("hex") !== expectedHash) {
    await rm(destination, { force: true }).catch(() => {});
    throw new Error("Parse child artifact failed its hash integrity check");
  }
}

interface PendingModel {
  id: string;
  finalPath: string;
  thumbPath: string | null;
  model: ParseChildModel;
  response: UploadedModelDto;
}

async function persistPreparedUpload(
  jobId: string,
  sessionId: string,
  prepared: PreparedParse,
  log: IngestProcessorContext["log"],
): Promise<IngestJobResult> {
  await ensureStorageDirs();
  const pending: PendingModel[] = [];
  const artifactPaths = new Set<string>();
  let transactionStarted = false;

  try {
    for (const model of prepared.result.models) {
      const id = randomUUID();
      const finalPath = modelPath(id, model.format);
      artifactPaths.add(finalPath);
      await copyVerifiedArtifact(
        join(prepared.outDir, model.fileName),
        finalPath,
        model.sizeBytes,
        model.fileHash,
      );
      await setFileOwnership(finalPath);

      let thumbPath: string | null = null;
      if (model.thumbFile) {
        const candidate = thumbnailPath(id);
        artifactPaths.add(candidate);
        try {
          const source = await open(
            join(prepared.outDir, model.thumbFile),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const reader = source.createReadStream({ autoClose: false });
            const writer = createWriteStream(candidate, { flags: "wx", mode: 0o600 });
            await pipeline(reader, writer);
          } finally {
            await source.close().catch(() => {});
          }
          await setFileOwnership(candidate);
          thumbPath = candidate;
        } catch (error) {
          await removeQuietly(candidate).catch(() => {});
          artifactPaths.delete(candidate);
          log.warn({ jobId, modelId: id, errorType: errorType(error) }, "ingest thumbnail failed");
        }
      }

      const response: UploadedModelDto = {
        id,
        originalName: model.originalName,
        format: model.format,
        sizeBytes: model.sizeBytes,
        bboxMm: model.bboxMm,
        volumeCm3: Number(model.volumeCm3.toFixed(3)),
        triangleCount: model.triangleCount,
        fitsBed: fitsBed(model.bboxMm),
        ...(model.defaultConfig ? { defaultConfig: model.defaultConfig } : {}),
        ...(model.sourceConfig ? { sourceConfig: model.sourceConfig } : {}),
        ...(model.lockedConfig ? { lockedConfig: model.lockedConfig } : {}),
      };
      pending.push({ id, finalPath, thumbPath, model, response });
    }

    transactionStarted = true;
    await prisma.$transaction(async (tx) => {
      for (const entry of pending) {
        await tx.uploadedModel.create({
          data: {
            id: entry.id,
            sessionId,
            originalName: entry.model.originalName,
            storedPath: entry.finalPath,
            fileHash: entry.model.fileHash,
            sizeBytes: entry.model.sizeBytes,
            format: entry.model.format,
            bboxXMm: entry.model.bboxMm.x,
            bboxYMm: entry.model.bboxMm.y,
            bboxZMm: entry.model.bboxMm.z,
            volumeCm3: entry.model.volumeCm3,
            ...(entry.thumbPath ? { thumbPath: entry.thumbPath } : {}),
            ...(entry.model.defaultConfig
              ? { defaultConfig: entry.model.defaultConfig as Prisma.InputJsonValue }
              : {}),
            ...(entry.model.sourceConfig
              ? { sourceConfig: entry.model.sourceConfig as Prisma.InputJsonValue }
              : {}),
            ...(entry.model.lockedConfig
              ? { lockedConfig: entry.model.lockedConfig as Prisma.InputJsonValue }
              : {}),
          },
        });
      }
    });

    const models = pending.map((model) => model.response);
    return { model: models[0]!, models };
  } catch (error) {
    let mayRemoveArtifacts = true;
    if (transactionStarted && pending.length > 0) {
      try {
        // Covers a connection failure with an ambiguous COMMIT result. These
        // ids have not been returned to the customer, and the quotation fence
        // prevents deleting anything that somehow became attached.
        await prisma.uploadedModel.deleteMany({
          where: { id: { in: pending.map((model) => model.id) }, items: { none: {} } },
        });
      } catch (cleanupError) {
        mayRemoveArtifacts = false;
        log.warn(
          { jobId, errorType: errorType(cleanupError) },
          "ingest database rollback could not be confirmed",
        );
      }
    }
    if (mayRemoveArtifacts) {
      await Promise.all(
        [...artifactPaths].map((path) =>
          removeQuietly(path).catch((cleanupError) =>
            log.warn(
              { jobId, errorType: errorType(cleanupError) },
              "ingest artifact rollback failed",
            ),
          ),
        ),
      );
    }
    throw error;
  }
}

async function processValidatedJob(
  jobId: string,
  data: IngestJobData,
  context: IngestProcessorContext,
): Promise<IngestJobResult> {
  // Staging inside the runner re-verifies size and hash against the queued
  // metadata; parsing, canonicalization, and thumbnail rendering all happen in
  // the sandboxed child so this event loop never blocks on customer geometry.
  const prepared = await runPreparedParse(
    {
      jobId,
      sourcePath: tmpPathFor(data.tmpName),
      sizeBytes: data.sizeBytes,
      sha256: data.sha256,
      originalName: data.originalName,
      format: data.format,
    },
    context.parse,
  );
  try {
    const models = prepared.result.models;
    const wrongScale = models.find((model) =>
      looksWrongScale(model.bboxMm, model.triangleCount),
    );
    if (wrongScale) {
      const { x, y, z } = wrongScale.bboxMm;
      rejectUpload(
        "MODEL_WRONG_SCALE",
        `This model measures only ${x.toFixed(1)} × ${y.toFixed(1)} × ${z.toFixed(1)} mm — too small to print. ` +
          "It was likely exported at the wrong scale; scale it to the intended size (or re-export in millimetres) and upload it again.",
      );
    }

    const [count, aggregate] = await Promise.all([
      prisma.uploadedModel.count({ where: { sessionId: data.sessionId, items: { none: {} } } }),
      prisma.uploadedModel.aggregate({
        where: { sessionId: data.sessionId, items: { none: {} } },
        _sum: { sizeBytes: true },
      }),
    ]);
    if (count + models.length > config.maxModelsPerSession) {
      rejectUpload(
        "TOO_MANY_MODELS",
        `This upload contains ${models.length} models, but this quote only has room for ${
          Math.max(0, config.maxModelsPerSession - count)
        } more model(s)`,
      );
    }
    if ((aggregate._sum.sizeBytes ?? 0) + prepared.result.totalBytes > config.maxSessionUploadBytes) {
      rejectUpload(
        "SESSION_STORAGE_LIMIT",
        `Active quote files are limited to ${Math.round(config.maxSessionUploadBytes / 1024 / 1024)} MB in total`,
      );
    }

    const storage = await statfs(uploadRoot());
    if (storage.bavail * storage.bsize < prepared.result.totalBytes + config.storageReserveBytes) {
      rejectUpload("STORAGE_LOW", "Uploads are temporarily paused while storage is low.");
    }

    return await persistPreparedUpload(jobId, data.sessionId, prepared, context.log);
  } finally {
    await removeParseWorkDir(prepared.workDir).catch(() => {});
  }
}

function safeCleanupIdentity(job: Job<IngestJobData, IngestJobResult>): {
  ticket?: string;
  tmpPath?: string;
  reservationMember?: string;
} {
  const rawValue = job.data as unknown;
  const raw =
    rawValue && typeof rawValue === "object"
      ? (rawValue as Partial<Record<keyof IngestJobData, unknown>>)
      : {};
  const ticket = typeof job.id === "string" && UUID_RE.test(job.id) ? job.id : undefined;
  const tmpName = typeof raw.tmpName === "string" && UUID_RE.test(raw.tmpName) ? raw.tmpName : undefined;
  const reservationMember =
    typeof raw.reservationMember === "string" && RESERVATION_RE.test(raw.reservationMember)
      ? raw.reservationMember
      : undefined;
  return {
    ...(ticket ? { ticket } : {}),
    ...(tmpName ? { tmpPath: tmpPathFor(tmpName) } : {}),
    ...(reservationMember ? { reservationMember } : {}),
  };
}

/** Also invoked directly by the ingest worker's failed-event handler: a job
 * failed as stalled never reaches the processor, so the `finally` cleanup in
 * processIngestJob is skipped and its admission slot, storage reservation, and
 * temp file would otherwise leak until their TTLs expire. Every step is
 * idempotent, so running again after a processor-side cleanup is harmless. */
export async function terminalCleanup(
  job: Job<IngestJobData, IngestJobResult>,
  context: IngestProcessorContext,
): Promise<void> {
  const identity = safeCleanupIdentity(job);
  const cleanups: { label: string; run: () => Promise<unknown> }[] = [];
  if (identity.tmpPath) {
    cleanups.push({ label: "temp file", run: () => removeQuietly(identity.tmpPath!) });
  }
  if (identity.reservationMember) {
    cleanups.push({
      label: "storage reservation",
      run: () => context.redis.zrem(UPLOAD_STORAGE_RESERVATION_KEY, identity.reservationMember!),
    });
  }
  if (identity.ticket) {
    cleanups.push({
      label: "queue admission",
      run: () => context.redis.zrem(INGEST_ADMISSION_KEY, identity.ticket!),
    });
  }

  await Promise.all(
    cleanups.map(async (cleanup) => {
      try {
        await cleanup.run();
      } catch (error) {
        context.log.warn(
          { jobId: identity.ticket, cleanup: cleanup.label, errorType: errorType(error) },
          "ingest terminal cleanup failed",
        );
      }
    }),
  );
}

/** Consume one queued upload. Expected customer errors are stored back into the
 * job data; the raw BullMQ failure reason remains generic and is never an API. */
export async function processIngestJob(
  job: Job<IngestJobData, IngestJobResult>,
  context: IngestProcessorContext,
): Promise<IngestJobResult> {
  let data: IngestJobData | null = null;
  try {
    data = validateJob(job);
    return await processValidatedJob(job.id!, data, context);
  } catch (error) {
    const failure =
      error instanceof PublicIngestError
        ? error.failure
        : error instanceof ParseRunnerPublicError
          ? error.failure
          : publicIngestFailure(
              "INGEST_FAILED",
              "The uploaded model could not be processed. Please upload it again.",
            );
    if (data) {
      try {
        await job.updateData({ ...data, publicFailure: failure });
      } catch (updateError) {
        context.log.warn(
          { jobId: job.id, errorType: errorType(updateError) },
          "ingest public failure could not be recorded",
        );
      }
    }
    if (!(error instanceof PublicIngestError)) {
      context.log.warn({ jobId: job.id, errorType: errorType(error) }, "ingest processing failed");
    }
    throw new Error(`Ingest failed (${failure.code})`);
  } finally {
    await terminalCleanup(job, context);
  }
}
