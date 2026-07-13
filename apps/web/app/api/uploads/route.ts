import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { MAX_CANONICAL_ARCHIVE_BYTES } from "@print/geometry";
import {
  INGEST_ADMISSION_TTL_SECONDS,
  INGEST_MAX_WAITING,
  formatFromFilename,
  sanitizeOriginalName,
  type IngestJobData,
} from "@print/shared";
import { assertBodySize, guardMutation, jsonError } from "@/lib/api-util";
import { env } from "@/lib/env";
import {
  getIngestCountAhead,
  releaseIngestAdmission,
  reserveIngestAdmission,
} from "@/lib/ingest-queue";
import { getIngestQueue } from "@/lib/queue";
import {
  clientIp,
  rateLimitBytes,
  RATE_LIMITS,
  releaseStorageReservation,
  reserveStorageBytes,
} from "@/lib/security";
import { getOrCreateQuoteSessionId } from "@/lib/session";
import {
  availableStorageBytes,
  ensureStorageDirs,
  removeQuietly,
  tmpUploadPath,
} from "@/lib/storage";
import { sendOperatorAlert } from "@/lib/telegram";

export const runtime = "nodejs";
// Uploads can be large; never pre-render or cache.
export const dynamic = "force-dynamic";

const UPLOAD_DEADLINE_MS = 10 * 60_000;
// The worker may produce at most twenty 512px RGBA thumbnails for a multi-plate
// 3MF. PNG encoding is bounded by the ~1 MiB raw image per plate; 32 MiB leaves
// comfortable framing/deflate overhead while the 2 GiB filesystem reserve
// remains the final safety boundary.
const CANONICAL_THUMB_HEADROOM_BYTES = 32 * 1024 * 1024;
const QUEUE_DEPTH_ALERT_THRESHOLD = Math.floor(INGEST_MAX_WAITING * 0.8);

class UploadTimeoutError extends Error {}

interface StreamedFile {
  tmpPath: string;
  originalName: string;
  sizeBytes: number;
  sha256: string;
  truncated: boolean;
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
  // Once queued, the worker owns this reservation until terminal cleanup. The
  // two-hour self-expiry matches admission and the temp-file orphan grace, so
  // a crashed producer/worker cannot permanently consume disk capacity.
  const reservation = await reserveStorageBytes(
    reservationCost,
    freeBytes - env.storageReserveBytes,
    INGEST_ADMISSION_TTL_SECONDS,
  );
  if (!reservation) {
    return jsonError(507, "STORAGE_LOW", "Uploads are temporarily paused while storage is low.");
  }
  let ownershipTransferred = false;
  let admissionTicket: string | null = null;
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

      const ticket = crypto.randomUUID();
      const queue = getIngestQueue();
      let admission;
      try {
        admission = await reserveIngestAdmission(queue, ticket);
      } catch {
        return jsonError(
          503,
          "INGEST_UNAVAILABLE",
          "Model processing is temporarily unavailable. Please retry shortly.",
        );
      }
      if (!admission) {
        void sendOperatorAlert(
          "ingest_queue_depth",
          `Upload ingest queue reached its hard admission limit of ${INGEST_MAX_WAITING}.`,
        ).catch(() => {});
        const response = jsonError(
          503,
          "INGEST_QUEUE_FULL",
          "The site is unusually busy processing models. Please retry shortly.",
        );
        response.headers.set("Retry-After", "60");
        return response;
      }
      admissionTicket = ticket;

      const data: IngestJobData = {
        tmpName: basename(file.tmpPath),
        sessionId,
        originalName,
        format,
        sizeBytes: actualSize,
        sha256: file.sha256,
        reservationMember: reservation,
      };
      let enqueued = false;
      let enqueueOutcomeKnown = true;
      try {
        await queue.add("ingest", data, { jobId: ticket });
        enqueued = true;
      } catch {
        // Queue.add is atomic in Redis, but the response can be lost after the
        // write. Verify by the unguessable ticket before deciding who owns the
        // temp file and capacity markers.
        try {
          const existingJob = await queue.getJob(ticket);
          enqueued =
            existingJob !== undefined &&
            existingJob.data.tmpName === data.tmpName &&
            existingJob.data.sessionId === data.sessionId &&
            existingJob.data.originalName === data.originalName &&
            existingJob.data.format === data.format &&
            existingJob.data.sizeBytes === data.sizeBytes &&
            existingJob.data.sha256 === data.sha256 &&
            existingJob.data.reservationMember === data.reservationMember;
        } catch {
          enqueueOutcomeKnown = false;
        }
      }

      if (!enqueued) {
        if (!enqueueOutcomeKnown) {
          // Do not delete beneath a job that may have committed. Both markers
          // self-expire and orphan reconciliation removes the temp file if it
          // turns out no worker ever received it.
          ownershipTransferred = true;
        }
        return jsonError(
          503,
          "INGEST_UNAVAILABLE",
          "Model processing is temporarily unavailable. Please retry shortly.",
        );
      }

      ownershipTransferred = true;
      // From here BullMQ is the durable source of truth. Remove the short
      // producer marker immediately so real wait/paused/active list lengths —
      // not a two-hour shadow count — enforce subsequent admissions.
      await releaseIngestAdmission(ticket).catch(() => {});
      let position = admission.position;
      try {
        position = (await getIngestCountAhead(queue, ticket)) ?? position;
      } catch {
        // Admission itself is an atomic conservative count. The ticket is
        // durable, so a transient position lookup must not turn success into an
        // error or prompt a duplicate customer upload.
      }
      if (position >= QUEUE_DEPTH_ALERT_THRESHOLD) {
        void sendOperatorAlert(
          "ingest_queue_depth",
          `Upload ingest queue has at least ${position + 1} admitted jobs.`,
        ).catch(() => {});
      }
      return NextResponse.json({ ticket, position }, { status: 202 });
    } finally {
      if (!ownershipTransferred) {
        if (admissionTicket) await releaseIngestAdmission(admissionTicket).catch(() => {});
        await removeQuietly(file.tmpPath);
      }
    }
  } finally {
    if (!ownershipTransferred) await releaseStorageReservation(reservation).catch(() => {});
  }
}
