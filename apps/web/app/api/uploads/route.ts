import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";
import { NextResponse, type NextRequest } from "next/server";
import { Prisma, prisma } from "@print/db";
import {
  extract3mfPlates,
  ModelParseError,
  parseModel,
  renderThumbnail,
  type ParsedModel,
} from "@print/geometry";
import { CATALOG, formatFromFilename, sanitizeOriginalName, type ModelConfig } from "@print/shared";
import { guardMutation, jsonError } from "@/lib/api-util";
import { env } from "@/lib/env";
import { RATE_LIMITS } from "@/lib/security";
import { getOrCreateQuoteSessionId } from "@/lib/session";
import {
  ensureStorageDirs,
  modelPath,
  removeQuietly,
  thumbPath,
  tmpUploadPath,
} from "@/lib/storage";

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

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function fitsBed(parsed: ParsedModel): boolean {
  const bed = CATALOG.printers[CATALOG.defaultPrinterId]!.bedMm;
  // Compare sorted dimensions so a part that fits when rotated still passes.
  const dims = [parsed.bboxMm.x, parsed.bboxMm.y, parsed.bboxMm.z].sort((a, b) => a - b);
  const bedSorted = [...bed].sort((a, b) => a - b);
  return dims.every((d, i) => d <= bedSorted[i]!);
}

function plateOriginalName(originalName: string, index: number): string {
  const stem = originalName.replace(/\.[^.]+$/, "");
  return sanitizeOriginalName(`${stem} - plate ${String(index).padStart(2, "0")}.stl`);
}

async function persistUploadedModel(input: {
  sessionId: string;
  originalName: string;
  format: string;
  contents: Buffer;
  parsed: ParsedModel;
  fileHash: string;
  defaultConfig?: Partial<ModelConfig>;
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
        ...(input.lockedConfig ? { lockedConfig: input.lockedConfig as Prisma.InputJsonValue } : {}),
      },
    });
    id = model.id;

    finalPath = modelPath(model.id, input.format);
    await writeFile(finalPath, input.contents, { mode: 0o600 });
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
      try {
        await ensureStorageDirs();
        const tp = thumbPath(model.id);
        await writeFile(tp, renderThumbnail(input.parsed.positions, THUMB_SIZE));
        await prisma.uploadedModel.update({ where: { id: model.id }, data: { thumbPath: tp } });
      } catch {
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
      lockedConfig: input.lockedConfig,
    };
  } catch (err) {
    await removeQuietly(finalPath);
    if (id) await prisma.uploadedModel.delete({ where: { id } }).catch(() => {});
    throw err;
  }
}

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "upload", RATE_LIMITS.upload);
  if (guard) return guard;

  await ensureStorageDirs();
  const sessionId = await getOrCreateQuoteSessionId();

  // Only models not yet attached to a submitted quotation count toward the
  // active-quote cap. A quoted model has left the quote being built and the
  // cleanup path can't remove it, so counting it here would permanently wedge a
  // session that once submitted a full quote. Mirrors GET/DELETE in api/models.
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

    const contents = await readFile(file.tmpPath);

    // Bambu/Orca project 3MFs can contain several printable plates. Treat each
    // plate as a separate clean STL-backed model so the customer sees the same
    // printable units the slicer project intended, and so Orca never has to
    // ingest stale or incompatible project-level 3MF settings.
    if (format === "3mf") {
      let plates;
      try {
        plates = extract3mfPlates(contents);
      } catch (err) {
        if (err instanceof ModelParseError) {
          return jsonError(422, `INVALID_MODEL_${err.code}`, err.message);
        }
        throw err;
      }

      if (plates.length > 1) {
        if (existing + plates.length > env.maxModelsPerSession) {
          return jsonError(
            422,
            "TOO_MANY_MODELS",
            `This 3MF contains ${plates.length} plates, but this quote only has room for ${
              env.maxModelsPerSession - existing
            } more model(s)`,
          );
        }

        const created: UploadedModelResponse[] = [];
        try {
          for (const plate of plates) {
            created.push(
              await persistUploadedModel({
                sessionId,
                originalName: plateOriginalName(originalName, plate.index),
                format: "stl",
                contents: plate.stl,
                parsed: plate.model,
                fileHash: sha256(plate.stl),
                defaultConfig: { supports: plate.configuredSupports ? "auto" : "off" },
                lockedConfig: { supports: true },
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
      }
    }

    // Full structural validation: if the geometry parser accepts it, it is a
    // real model of the declared format — far stronger than magic bytes alone.
    let parsed: ParsedModel;
    try {
      parsed = parseModel(contents, format);
    } catch (err) {
      if (err instanceof ModelParseError) {
        return jsonError(422, `INVALID_MODEL_${err.code}`, err.message);
      }
      throw err;
    }

    const model = await persistUploadedModel({
      sessionId,
      originalName,
      format,
      contents,
      parsed,
      fileHash: file.sha256,
    });

    return NextResponse.json(
      {
        model,
        models: [model],
      },
      { status: 201 },
    );
  } finally {
    await removeQuietly(file.tmpPath);
  }
}
