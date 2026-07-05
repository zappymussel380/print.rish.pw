import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import { ModelParseError, parseModel } from "@print/geometry";
import { CATALOG, formatFromFilename, sanitizeOriginalName } from "@print/shared";
import { guardMutation, jsonError } from "@/lib/api-util";
import { env } from "@/lib/env";
import { RATE_LIMITS } from "@/lib/security";
import { getOrCreateQuoteSessionId } from "@/lib/session";
import {
  ensureStorageDirs,
  modelPath,
  moveIntoPlace,
  removeQuietly,
  tmpUploadPath,
} from "@/lib/storage";

export const runtime = "nodejs";
// Uploads can be large; never pre-render or cache.
export const dynamic = "force-dynamic";

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

  const done = new Promise<void>((resolvePromise, rejectPromise) => {
    // Resolves once the file's bytes are fully flushed to disk. Busboy's own
    // "finish" fires when parsing ends, which can precede the write stream
    // draining — statting the temp file then would race to an empty read.
    let writeDone: Promise<void> = Promise.resolve();

    bb.on("file", (_field, stream, info) => {
      sawFile = true;
      originalName = info.filename ?? "";
      const sink = createWriteStream(tmpPath, { mode: 0o600 });
      stream.on("data", (chunk: Buffer) => {
        sizeBytes += chunk.length;
        hash.update(chunk);
      });
      stream.on("limit", () => {
        truncated = true;
      });
      writeDone = new Promise<void>((res, rej) => {
        sink.on("finish", res);
        sink.on("error", rej);
        stream.on("error", rej);
      });
      stream.pipe(sink);
    });
    bb.on("error", rejectPromise);
    bb.on("finish", () => writeDone.then(resolvePromise, rejectPromise));
  });

  await pipeline(Readable.fromWeb(request.body as never), bb).catch(() => {
    // pipeline surfaces busboy errors; `done` below settles the outcome.
  });
  await done;

  if (!sawFile) {
    await removeQuietly(tmpPath);
    return null;
  }
  return { tmpPath, originalName, sizeBytes, sha256: hash.digest("hex"), truncated };
}

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "upload", RATE_LIMITS.upload);
  if (guard) return guard;

  await ensureStorageDirs();
  const sessionId = await getOrCreateQuoteSessionId();

  const existing = await prisma.uploadedModel.count({ where: { sessionId } });
  if (existing >= env.maxModelsPerSession) {
    return jsonError(
      422,
      "TOO_MANY_MODELS",
      `A quote can contain at most ${env.maxModelsPerSession} models`,
    );
  }

  const file = await streamUpload(request);
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

    // Full structural validation: if the geometry parser accepts it, it is a
    // real model of the declared format — far stronger than magic bytes alone.
    let parsed;
    try {
      parsed = parseModel(await readFile(file.tmpPath), format);
    } catch (err) {
      if (err instanceof ModelParseError) {
        return jsonError(422, `INVALID_MODEL_${err.code}`, err.message);
      }
      throw err;
    }

    const bed = CATALOG.printers[CATALOG.defaultPrinterId]!.bedMm;
    // Compare sorted dimensions so a part that fits when rotated still passes.
    const dims = [parsed.bboxMm.x, parsed.bboxMm.y, parsed.bboxMm.z].sort((a, b) => a - b);
    const bedSorted = [...bed].sort((a, b) => a - b);
    const fitsBed = dims.every((d, i) => d <= bedSorted[i]!);

    const model = await prisma.uploadedModel.create({
      data: {
        sessionId,
        originalName,
        storedPath: "", // set below once the id exists
        fileHash: file.sha256,
        sizeBytes: file.sizeBytes,
        format,
        bboxXMm: parsed.bboxMm.x,
        bboxYMm: parsed.bboxMm.y,
        bboxZMm: parsed.bboxMm.z,
        volumeCm3: parsed.volumeCm3,
      },
    });

    const finalPath = modelPath(model.id, format);
    await moveIntoPlace(file.tmpPath, finalPath);
    await prisma.uploadedModel.update({
      where: { id: model.id },
      data: { storedPath: finalPath },
    });

    return NextResponse.json(
      {
        model: {
          id: model.id,
          originalName,
          format,
          sizeBytes: file.sizeBytes,
          bboxMm: parsed.bboxMm,
          volumeCm3: Number(parsed.volumeCm3.toFixed(3)),
          triangleCount: parsed.triangleCount,
          fitsBed,
        },
      },
      { status: 201 },
    );
  } finally {
    await removeQuietly(file.tmpPath);
  }
}
