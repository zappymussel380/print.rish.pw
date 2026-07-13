import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";
import { NextResponse, type NextRequest } from "next/server";
import { Prisma, prisma } from "@print/db";
import {
  ModelParseError,
  renderThumbnail,
  type ParsedModel,
} from "@print/geometry";
import {
  CATALOG,
  formatFromFilename,
  sanitizeOriginalName,
  type ModelConfig,
} from "@print/shared";
import { assertBodySize, guardMutation, jsonError } from "@/lib/api-util";
import { env } from "@/lib/env";
import {
  MAX_CANONICAL_ARCHIVE_BYTES,
  prepareUploadModels,
} from "@/lib/upload-prepare";
import {
  clientIp,
  rateLimitBytes,
  RATE_LIMITS,
  releaseStorageReservation,
  reserveStorageBytes,
  withRedisLock,
} from "@/lib/security";
import { getOrCreateQuoteSessionId } from "@/lib/session";
import {
  availableStorageBytes,
  ensureStorageDirs,
  hasStorageHeadroom,
  modelPath,
  moveIntoPlace,
  removeQuietly,
  thumbPath,
  tmpUploadPath,
} from "@/lib/storage";
import { sendOperatorAlert } from "@/lib/telegram";

export const runtime = "nodejs";
// Uploads can be large; never pre-render or cache.
export const dynamic = "force-dynamic";

// Preview thumbnail resolution (matches the worker's THUMB_SIZE default).
const THUMB_SIZE = 512;
// Above this the inline render is left to the worker (which draws one on first
// slice anyway): the rasteriser itself is budget-bounded, but its full-mesh
// framing passes plus PNG encode still cost real event-loop time on the web
// process, and a pathological mesh should never pay it inline.
const MAX_INLINE_THUMB_TRIANGLES = 1_000_000;
const UPLOAD_DEADLINE_MS = 10 * 60_000;
// At most twenty inline 512px RGBA thumbnails can accompany a multi-plate 3MF.
// PNG encoding is bounded by the ~1 MiB raw image per plate; 32 MiB leaves
// comfortable framing/deflate overhead while the 2 GiB filesystem reserve
// remains the final safety boundary.
const CANONICAL_THUMB_HEADROOM_BYTES = 32 * 1024 * 1024;

class UploadTimeoutError extends Error {}

interface StreamedFile {
  tmpPath: string;
  originalName: string;
  sizeBytes: number;
  sha256: string;
  truncated: boolean;
}

interface UploadedModelResponse {
  id: string;
  originalName: string;
  format: string;
  sizeBytes: number;
  bboxMm: ParsedModel["bboxMm"];
  volumeCm3: number;
  triangleCount: number;
  fitsBed: boolean;
  defaultConfig?: Partial<ModelConfig>;
  sourceConfig?: Partial<ModelConfig>;
  lockedConfig?: Partial<Record<keyof ModelConfig, true>>;
}

/** Stream exactly one multipart file field to disk, hashing as it flows. */
async function streamUpload(request: NextRequest): Promise<StreamedFile | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data") || !request.body) return null;

  const bb = busboy({
    headers: { "content-type": contentType },
    limits: { files: 1, fields: 4, fileSize: env.maxUploadBytes },
  });

  const tmpPath = tmpUploadPath();
  const hash = createHash("sha256");
  let originalName = "";
  let sizeBytes = 0;
  let truncated = false;
  let sawFile = false;
  let timedOut = false;

  const done = new Promise<void>((resolvePromise, rejectPromise) => {
    // Resolves once the file's bytes are fully flushed to disk. Busboy's own
    // "finish" fires when parsing ends, which can precede the write stream
    // draining — statting the temp file then would race to an empty read.
    let writeDone: Promise<void> = Promise.resolve();

    bb.on("file", (_field, stream, info) => {
      sawFile = true;
      originalName = info.filename ?? "";
      const sink = createWriteStream(tmpPath, { flags: "wx", mode: 0o600 });
      stream.on("data", (chunk: Buffer) => {
        sizeBytes += chunk.length;
        hash.update(chunk);
      });
      stream.on("limit", () => {
        truncated = true;
      });
      writeDone = pipeline(stream, sink);
    });
    bb.on("error", rejectPromise);
    bb.on("finish", () => writeDone.then(resolvePromise, rejectPromise));
  });

  const abort = new AbortController();
  const deadline = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, UPLOAD_DEADLINE_MS);
  deadline.unref();
  try {
    // Await both sides so malformed multipart data, client disconnects, parser
    // errors, and destination errors all take the same cleanup path.
    await Promise.all([
      pipeline(Readable.fromWeb(request.body as never), bb, { signal: abort.signal }),
      done,
    ]);
  } catch (err) {
    await removeQuietly(tmpPath);
    if (timedOut) throw new UploadTimeoutError("Upload exceeded the absolute time limit");
    throw err;
  } finally {
    clearTimeout(deadline);
  }

  if (!sawFile) {
    await removeQuietly(tmpPath);
    return null;
  }
  return { tmpPath, originalName, sizeBytes, sha256: hash.digest("hex"), truncated };
}

function fitsBed(parsed: ParsedModel): boolean {
  const bed = CATALOG.printers[CATALOG.defaultPrinterId]!.bedMm;
  // Compare sorted dimensions so a part that fits when rotated still passes.
  const dims = [parsed.bboxMm.x, parsed.bboxMm.y, parsed.bboxMm.z].sort((a, b) => a - b);
  const bedSorted = [...bed].sort((a, b) => a - b);
  return dims.every((d, i) => d <= bedSorted[i]!);
}

async function persistUploadedModel(input: {
  sessionId: string;
  originalName: string;
  format: string;
  contents: Buffer;
  sourceTmpPath?: string;
  parsed: ParsedModel;
  fileHash: string;
  defaultConfig?: Partial<ModelConfig>;
  sourceConfig?: Partial<ModelConfig>;
  lockedConfig?: Partial<Record<keyof ModelConfig, true>>;
}): Promise<UploadedModelResponse> {
  let id: string | null = null;
  let finalPath: string | null = null;

  try {
    const model = await prisma.uploadedModel.create({
      data: {
        sessionId: input.sessionId,
        originalName: input.originalName,
        storedPath: "", // set below once the id exists
        fileHash: input.fileHash,
        sizeBytes: input.contents.length,
        format: input.format,
        bboxXMm: input.parsed.bboxMm.x,
        bboxYMm: input.parsed.bboxMm.y,
        bboxZMm: input.parsed.bboxMm.z,
        volumeCm3: input.parsed.volumeCm3,
        ...(input.defaultConfig
          ? { defaultConfig: input.defaultConfig as Prisma.InputJsonValue }
          : {}),
        ...(input.sourceConfig ? { sourceConfig: input.sourceConfig as Prisma.InputJsonValue } : {}),
        ...(input.lockedConfig ? { lockedConfig: input.lockedConfig as Prisma.InputJsonValue } : {}),
      },
    });
    id = model.id;

    finalPath = modelPath(model.id, input.format);
    if (input.sourceTmpPath) {
      await moveIntoPlace(input.sourceTmpPath, finalPath);
    } else {
      await writeFile(finalPath, input.contents, { flag: "wx", mode: 0o600 });
    }
    // Persist storedPath immediately — the file now exists on disk, so the DB
    // must point at it before anything else can fail, or retention (which skips
    // rows with an empty storedPath) could never reclaim an orphaned file.
    await prisma.uploadedModel.update({
      where: { id: model.id },
      data: { storedPath: finalPath },
    });

    // Render the preview thumbnail now, while the geometry is already parsed.
    // Done here (not only in the slicer) so every upload has a preview even when
    // its slice is served from cache and no worker job runs. Best-effort and
    // strictly after the critical persist above — a thumbnail is a nicety and
    // must never fail an upload or strand its file. Skipped for huge meshes
    // (see MAX_INLINE_THUMB_TRIANGLES) — the worker renders those on first slice.
    if (input.parsed.triangleCount <= MAX_INLINE_THUMB_TRIANGLES) {
      let tp: string | null = null;
      try {
        await ensureStorageDirs();
        tp = thumbPath(model.id);
        await writeFile(tp, renderThumbnail(input.parsed.positions, THUMB_SIZE), {
          flag: "wx",
          mode: 0o600,
        });
        await prisma.uploadedModel.update({ where: { id: model.id }, data: { thumbPath: tp } });
      } catch {
        await removeQuietly(tp).catch(() => {});
        // ignore — the worker still renders one on first slice as a fallback
      }
    }

    return {
      id: model.id,
      originalName: input.originalName,
      format: input.format,
      sizeBytes: input.contents.length,
      bboxMm: input.parsed.bboxMm,
      volumeCm3: Number(input.parsed.volumeCm3.toFixed(3)),
      triangleCount: input.parsed.triangleCount,
      fitsBed: fitsBed(input.parsed),
      defaultConfig: input.defaultConfig,
      sourceConfig: input.sourceConfig,
      lockedConfig: input.lockedConfig,
    };
  } catch (err) {
    await removeQuietly(finalPath);
    if (id) await prisma.uploadedModel.delete({ where: { id } }).catch(() => {});
    throw err;
  }
}

async function persistWithinSessionLimits(
  sessionId: string,
  modelCount: number,
  sizeBytes: number,
  persist: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const response = await withRedisLock(`upload-session:${sessionId}`, async () => {
    const [count, aggregate] = await Promise.all([
      prisma.uploadedModel.count({ where: { sessionId, items: { none: {} } } }),
      prisma.uploadedModel.aggregate({
        where: { sessionId, items: { none: {} } },
        _sum: { sizeBytes: true },
      }),
    ]);
    if (count + modelCount > env.maxModelsPerSession) {
      return jsonError(
        422,
        "TOO_MANY_MODELS",
        `A quote can contain at most ${env.maxModelsPerSession} models`,
      );
    }
    if ((aggregate._sum.sizeBytes ?? 0) + sizeBytes > env.maxSessionUploadBytes) {
      return jsonError(
        413,
        "SESSION_STORAGE_LIMIT",
        `Active quote files are limited to ${Math.round(env.maxSessionUploadBytes / 1024 / 1024)} MB in total`,
      );
    }
    // Recheck the real filesystem immediately before durable writes. The
    // cross-session Redis reservation prevents peers from consuming this space
    // between the check and persistence.
    if (!(await hasStorageHeadroom(sizeBytes + env.storageReserveBytes))) {
      return jsonError(507, "STORAGE_LOW", "Uploads are temporarily paused while storage is low.");
    }
    return persist();
  });

  if (response === null) {
    void sendOperatorAlert(
      "upload_busy",
      "Upload finalization lock timed out; uploads are temporarily busy.",
    ).catch(() => {});
    return jsonError(503, "UPLOAD_BUSY", "Another upload is still being finalized. Please retry.");
  }
  return response;
}

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "upload", RATE_LIMITS.upload);
  if (guard) return guard;

  // Multipart framing adds a small amount around the file itself. Reject a
  // declared oversized request before touching the body; busboy remains the
  // authoritative per-file limit for absent/chunked Content-Length requests.
  const bodyTooLarge = assertBodySize(request, env.maxUploadBytes + 1024 * 1024);
  if (bodyTooLarge) {
    return jsonError(413, "FILE_TOO_LARGE", `Files are limited to ${env.maxUploadMb} MB`);
  }

  const declaredBytes = Number(request.headers.get("content-length") ?? 0);
  const byteCost =
    Number.isFinite(declaredBytes) && declaredBytes > 0
      ? Math.min(declaredBytes, env.maxUploadBytes)
      : env.maxUploadBytes;
  const byteLimit = await rateLimitBytes(
    "upload",
    clientIp(request),
    byteCost,
    env.uploadWindowBytes,
    RATE_LIMITS.upload.windowSeconds,
  );
  if (!byteLimit.allowed) {
    const response = jsonError(
      429,
      "UPLOAD_BUDGET_EXCEEDED",
      "Upload bandwidth limit reached. Please try again later.",
      { retryAfterSeconds: byteLimit.retryAfterSeconds },
    );
    response.headers.set("Retry-After", String(byteLimit.retryAfterSeconds));
    return response;
  }

  await ensureStorageDirs();
  const freeBytes = await availableStorageBytes();
  // Archive input remains on disk while its canonical STL(s) and thumbnails are
  // written. The parser's shared triangle budget gives a hard combined STL
  // ceiling; configured per-file/session caps can only reduce it. Reserve that
  // worst-case expansion across replicas before accepting the body.
  const maxCanonicalBytes = Math.min(
    MAX_CANONICAL_ARCHIVE_BYTES,
    env.maxSessionUploadBytes,
    env.maxUploadBytes * env.maxModelsPerSession,
  );
  const reservationCost = byteCost + maxCanonicalBytes + CANONICAL_THUMB_HEADROOM_BYTES;
  // The reservation outlives the absolute upload deadline plus the bounded
  // ingest-lock wait/lease, so a slow client cannot continue after capacity is
  // automatically released.
  const reservation = await reserveStorageBytes(
    reservationCost,
    freeBytes - env.storageReserveBytes,
    25 * 60,
  );
  if (!reservation) {
    return jsonError(507, "STORAGE_LOW", "Uploads are temporarily paused while storage is low.");
  }
  try {
    const sessionId = await getOrCreateQuoteSessionId();

    // Only models not yet attached to a submitted quotation count toward the
    // active-quote cap. A quoted model has left the quote being built and the
    // cleanup path can't remove it, so counting it here would permanently wedge
    // a session that once submitted a full quote. Mirrors GET/DELETE in api/models.
    const existing = await prisma.uploadedModel.count({
      where: { sessionId, items: { none: {} } },
    });
    if (existing >= env.maxModelsPerSession) {
      return jsonError(
        422,
        "TOO_MANY_MODELS",
        `A quote can contain at most ${env.maxModelsPerSession} models`,
      );
    }

    let file: StreamedFile | null;
    try {
      file = await streamUpload(request);
    } catch (err) {
      if (err instanceof UploadTimeoutError) {
        return jsonError(408, "UPLOAD_TIMEOUT", "Upload exceeded the 10-minute time limit");
      }
      throw err;
    }
    if (!file) {
      return jsonError(400, "NO_FILE", "Send one model file as multipart/form-data");
    }

    try {
      if (file.truncated) {
        return jsonError(
          413,
          "FILE_TOO_LARGE",
          `Files are limited to ${Math.round(env.maxUploadBytes / 1024 / 1024)} MB`,
        );
      }

      const originalName = sanitizeOriginalName(file.originalName);
      const format = formatFromFilename(originalName);
      if (!format) {
        return jsonError(422, "UNSUPPORTED_FORMAT", "Supported formats: STL, 3MF, OBJ, AMF");
      }

      const actualSize = (await stat(file.tmpPath)).size;
      if (actualSize !== file.sizeBytes || actualSize === 0) {
        return jsonError(422, "EMPTY_FILE", "The uploaded file is empty or incomplete");
      }

      const parsedResponse = await withRedisLock(
        "geometry-ingest",
        async () => {
          // Acquire the cross-replica ingest slot before reading the full file
          // into memory. Waiting requests retain only their disk temp file,
          // preventing a distributed burst from filling the web heap.
          const contents = await readFile(file.tmpPath);
          let prepared;
          try {
            prepared = prepareUploadModels({
              contents,
              originalName,
              format,
              sourceSha256: file.sha256,
            });
          } catch (err) {
            if (err instanceof ModelParseError) {
              return jsonError(422, `INVALID_MODEL_${err.code}`, err.message);
            }
            throw err;
          }

          // Derived STL is bounded by the geometry triangle cap, but deployments
          // may intentionally choose a lower per-file limit than that hard cap.
          if (prepared.models.some((model) => model.sizeBytes > env.maxUploadBytes)) {
            return jsonError(
              413,
              "FILE_TOO_LARGE",
              `Canonical model files are limited to ${env.maxUploadMb} MB each`,
            );
          }
          if (existing + prepared.models.length > env.maxModelsPerSession) {
            return jsonError(
              422,
              "TOO_MANY_MODELS",
              `This upload contains ${prepared.models.length} models, but this quote only has room for ${
                env.maxModelsPerSession - existing
              } more model(s)`,
            );
          }

          return persistWithinSessionLimits(
            sessionId,
            prepared.models.length,
            prepared.totalBytes,
            async () => {
              const created: UploadedModelResponse[] = [];
              try {
                for (const model of prepared.models) {
                  created.push(
                    await persistUploadedModel({
                      sessionId,
                      originalName: model.originalName,
                      format: model.format,
                      contents: model.contents,
                      ...(model.derived ? {} : { sourceTmpPath: file.tmpPath }),
                      parsed: model.parsed,
                      fileHash: model.fileHash,
                      ...(model.defaultConfig ? { defaultConfig: model.defaultConfig } : {}),
                      ...(model.sourceConfig ? { sourceConfig: model.sourceConfig } : {}),
                      ...(model.lockedConfig ? { lockedConfig: model.lockedConfig } : {}),
                    }),
                  );
                }
              } catch (err) {
                await Promise.all(
                  created.map((model) =>
                    Promise.all([
                      prisma.uploadedModel.delete({ where: { id: model.id } }).catch(() => undefined),
                      removeQuietly(modelPath(model.id, model.format)),
                      removeQuietly(thumbPath(model.id)),
                    ]),
                  ),
                );
                throw err;
              }

              return NextResponse.json({ model: created[0], models: created }, { status: 201 });
            },
          );
        },
        { leaseMs: 5 * 60_000, waitMs: 60_000 },
      );
      if (parsedResponse === null) {
        void sendOperatorAlert(
          "ingest_busy",
          "Geometry ingest lock timed out; model inspection is temporarily busy.",
        ).catch(() => {});
        return jsonError(503, "INGEST_BUSY", "Another model is being inspected. Please retry.");
      }
      return parsedResponse;
    } finally {
      await removeQuietly(file.tmpPath);
    }
  } finally {
    await releaseStorageReservation(reservation).catch(() => {});
  }
}
