import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  chown,
  mkdir,
  open,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import type { Logger } from "pino";
import { Prisma, prisma } from "@print/db";
import { ModelParseError, renderThumbnail } from "@print/geometry";
import {
  CATALOG,
  INGEST_ADMISSION_KEY,
  UPLOAD_STORAGE_RESERVATION_KEY,
  formatFromFilename,
  ingestJobDataSchema,
  publicIngestFailure,
  sanitizeOriginalName,
  type IngestJobData,
  type IngestJobResult,
  type IngestPublicFailure,
  type UploadedModelDto,
} from "@print/shared";
import { config } from "./config.js";
import { prepareUploadModels, type PreparedUpload, type PreparedUploadModel } from "./upload-prepare.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVATION_RE = /^\d{1,15}:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INLINE_THUMB_TRIANGLES = 1_000_000;

/** Parsing is synchronous, so its BullMQ lock must comfortably exceed the old
 * five-minute web ingest lease. A stalled job is failed rather than replayed:
 * without a database ticket row, replay could persist the same upload twice. */
export const INGEST_WORKER_OPTIONS = {
  concurrency: 1,
  maxStalledCount: 0,
  lockDuration: 15 * 60_000,
} as const;

export interface IngestProcessorContext {
  redis: Pick<IORedis, "zrem">;
  log: Pick<Logger, "info" | "warn">;
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

async function readVerifiedTempFile(data: IngestJobData): Promise<Buffer> {
  const path = tmpPathFor(data.tmpName);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size <= 0 ||
      info.size !== data.sizeBytes ||
      info.size > config.maxUploadBytes
    ) {
      throw new Error("Queued upload failed its file-size integrity check");
    }
    const contents = await handle.readFile();
    const actualHash = createHash("sha256").update(contents).digest();
    const expectedHash = Buffer.from(data.sha256, "hex");
    if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
      throw new Error("Queued upload failed its hash integrity check");
    }
    return contents;
  } finally {
    await handle.close().catch(() => {});
  }
}

function fitsBed(model: PreparedUploadModel): boolean {
  const bed = CATALOG.printers[CATALOG.defaultPrinterId]!.bedMm;
  const dimensions = [model.parsed.bboxMm.x, model.parsed.bboxMm.y, model.parsed.bboxMm.z].sort(
    (a, b) => a - b,
  );
  const bedDimensions = [...bed].sort((a, b) => a - b);
  return dimensions.every((dimension, index) => dimension <= bedDimensions[index]!);
}

interface PendingModel {
  id: string;
  finalPath: string;
  thumbPath: string | null;
  prepared: PreparedUploadModel;
  response: UploadedModelDto;
}

async function persistPreparedUpload(
  jobId: string,
  sessionId: string,
  prepared: PreparedUpload,
  log: IngestProcessorContext["log"],
): Promise<IngestJobResult> {
  await ensureStorageDirs();
  const pending: PendingModel[] = [];
  const artifactPaths = new Set<string>();
  let transactionStarted = false;

  try {
    for (const model of prepared.models) {
      const id = randomUUID();
      const finalPath = modelPath(id, model.format);
      artifactPaths.add(finalPath);
      // Persist the bytes read from the verified O_NOFOLLOW descriptor. Reopening
      // the temp pathname here would reintroduce a swap race after hash checking.
      await writeFile(finalPath, model.contents, { flag: "wx", mode: 0o600 });
      await setFileOwnership(finalPath);

      let thumbPath: string | null = null;
      if (model.parsed.triangleCount <= MAX_INLINE_THUMB_TRIANGLES) {
        const candidate = thumbnailPath(id);
        artifactPaths.add(candidate);
        try {
          await writeFile(candidate, renderThumbnail(model.parsed.positions, config.thumbSize), {
            flag: "wx",
            mode: 0o600,
          });
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
        bboxMm: model.parsed.bboxMm,
        volumeCm3: Number(model.parsed.volumeCm3.toFixed(3)),
        triangleCount: model.parsed.triangleCount,
        fitsBed: fitsBed(model),
        ...(model.defaultConfig ? { defaultConfig: model.defaultConfig } : {}),
        ...(model.sourceConfig ? { sourceConfig: model.sourceConfig } : {}),
        ...(model.lockedConfig ? { lockedConfig: model.lockedConfig } : {}),
      };
      pending.push({ id, finalPath, thumbPath, prepared: model, response });
    }

    transactionStarted = true;
    await prisma.$transaction(async (tx) => {
      for (const model of pending) {
        await tx.uploadedModel.create({
          data: {
            id: model.id,
            sessionId,
            originalName: model.prepared.originalName,
            storedPath: model.finalPath,
            fileHash: model.prepared.fileHash,
            sizeBytes: model.prepared.sizeBytes,
            format: model.prepared.format,
            bboxXMm: model.prepared.parsed.bboxMm.x,
            bboxYMm: model.prepared.parsed.bboxMm.y,
            bboxZMm: model.prepared.parsed.bboxMm.z,
            volumeCm3: model.prepared.parsed.volumeCm3,
            ...(model.thumbPath ? { thumbPath: model.thumbPath } : {}),
            ...(model.prepared.defaultConfig
              ? { defaultConfig: model.prepared.defaultConfig as Prisma.InputJsonValue }
              : {}),
            ...(model.prepared.sourceConfig
              ? { sourceConfig: model.prepared.sourceConfig as Prisma.InputJsonValue }
              : {}),
            ...(model.prepared.lockedConfig
              ? { lockedConfig: model.prepared.lockedConfig as Prisma.InputJsonValue }
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
  log: IngestProcessorContext["log"],
): Promise<IngestJobResult> {
  const contents = await readVerifiedTempFile(data);
  let prepared: PreparedUpload;
  try {
    prepared = prepareUploadModels({
      contents,
      originalName: data.originalName,
      format: data.format,
      sourceSha256: data.sha256,
    });
  } catch (error) {
    if (error instanceof ModelParseError) {
      rejectUpload(
        `INVALID_MODEL_${error.code}`,
        error.message.slice(0, 500) || "The model could not be parsed",
      );
    }
    throw error;
  }

  if (prepared.models.some((model) => model.sizeBytes > config.maxUploadBytes)) {
    rejectUpload(
      "FILE_TOO_LARGE",
      `Canonical model files are limited to ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB each`,
    );
  }

  const [count, aggregate] = await Promise.all([
    prisma.uploadedModel.count({ where: { sessionId: data.sessionId, items: { none: {} } } }),
    prisma.uploadedModel.aggregate({
      where: { sessionId: data.sessionId, items: { none: {} } },
      _sum: { sizeBytes: true },
    }),
  ]);
  if (count + prepared.models.length > config.maxModelsPerSession) {
    rejectUpload(
      "TOO_MANY_MODELS",
      `This upload contains ${prepared.models.length} models, but this quote only has room for ${
        Math.max(0, config.maxModelsPerSession - count)
      } more model(s)`,
    );
  }
  if ((aggregate._sum.sizeBytes ?? 0) + prepared.totalBytes > config.maxSessionUploadBytes) {
    rejectUpload(
      "SESSION_STORAGE_LIMIT",
      `Active quote files are limited to ${Math.round(config.maxSessionUploadBytes / 1024 / 1024)} MB in total`,
    );
  }

  const storage = await statfs(uploadRoot());
  if (storage.bavail * storage.bsize < prepared.totalBytes + config.storageReserveBytes) {
    rejectUpload("STORAGE_LOW", "Uploads are temporarily paused while storage is low.");
  }

  return persistPreparedUpload(jobId, data.sessionId, prepared, log);
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

async function terminalCleanup(
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
    return await processValidatedJob(job.id!, data, context.log);
  } catch (error) {
    const failure =
      error instanceof PublicIngestError
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
