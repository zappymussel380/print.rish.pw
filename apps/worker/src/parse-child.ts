import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ModelParseError, parseModel, renderThumbnail } from "@print/geometry";
import {
  parseChildParamsSchema,
  type ParseChildModel,
  type ParseChildParams,
  type ParseChildSuccess,
} from "@print/shared";
import { StepConvertError, convertStepToStl } from "./step-convert.js";
import { prepareUploadModels } from "./upload-prepare.js";

/** Untrusted half of upload parsing. The orchestrator spawns this file as a
 * separate process under a throwaway uid with `choom -n 1000`, so a hostile or
 * pathological model can only take down this child: the event loop, BullMQ
 * locks, and the worker heartbeat stay live, and the cgroup OOM killer prefers
 * this process tree over the orchestrator. Everything printed to stdout and
 * every file written to outDir is re-validated by the parent. */

const MAX_INLINE_THUMB_TRIANGLES = 1_000_000;

export class ParseChildPublicError extends Error {
  constructor(
    readonly publicCode: string,
    message: string,
  ) {
    super(message);
    this.name = "ParseChildPublicError";
  }
}

async function runStepConversion(
  params: Extract<ParseChildParams, { mode: "prepare" }>,
  maxUploadBytes: number,
): Promise<Buffer> {
  try {
    return await convertStepToStl(params.inputPath, params.outDir, {
      ...(params.stepConvertBin ? { bin: params.stepConvertBin } : {}),
      ...(params.stepConvertTimeoutMs ? { timeoutMs: params.stepConvertTimeoutMs } : {}),
      // CAD solids legitimately tessellate larger than their STEP source, but
      // canonical artifacts are still bounded by the per-file upload limit.
      maxStlBytes: maxUploadBytes,
    });
  } catch (error) {
    if (error instanceof StepConvertError) {
      throw new ParseChildPublicError(error.publicCode, error.message);
    }
    throw error;
  }
}

async function readInput(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) {
      throw new Error("Parse input failed its size check");
    }
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function executeParseChild(params: ParseChildParams): Promise<ParseChildSuccess> {
  const contents = await readInput(params.inputPath, params.maxUploadBytes);

  if (params.mode === "thumbnail") {
    const parsed = parseModel(contents, params.format);
    const png = renderThumbnail(parsed.positions, params.thumbSize);
    await writeFile(params.outPath, png, { flag: "wx", mode: 0o600 });
    return { ok: true, models: [], totalBytes: 0 };
  }

  // STEP is CAD geometry, not a mesh: tessellate it here in the sandbox and
  // hand the resulting STL bytes through the normal canonicalization path.
  const contentsForParse =
    params.format === "step"
      ? await runStepConversion(params, params.maxUploadBytes)
      : contents;

  const prepared = prepareUploadModels({
    contents: contentsForParse,
    originalName: params.originalName,
    format: params.format,
    sourceSha256: params.sourceSha256,
  });

  const models: ParseChildModel[] = [];
  for (const [index, model] of prepared.models.entries()) {
    if (model.sizeBytes > params.maxUploadBytes) {
      throw new ParseChildPublicError(
        "FILE_TOO_LARGE",
        `Canonical model files are limited to ${Math.round(params.maxUploadBytes / 1024 / 1024)} MB each`,
      );
    }
    const fileName = `model-${index}.${model.format}`;
    await writeFile(join(params.outDir, fileName), model.contents, { flag: "wx", mode: 0o600 });

    let thumbFile: string | null = null;
    if (model.parsed.triangleCount <= MAX_INLINE_THUMB_TRIANGLES) {
      try {
        const png = renderThumbnail(model.parsed.positions, params.thumbSize);
        const candidate = `thumb-${index}.png`;
        await writeFile(join(params.outDir, candidate), png, { flag: "wx", mode: 0o600 });
        thumbFile = candidate;
      } catch (error) {
        // A thumbnail is a nicety; never fail the upload because of it.
        process.stderr.write(
          `thumbnail render failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }

    models.push({
      fileName,
      thumbFile,
      originalName: model.originalName,
      format: model.format,
      fileHash: model.fileHash,
      sizeBytes: model.sizeBytes,
      derived: model.derived,
      bboxMm: model.parsed.bboxMm,
      volumeCm3: model.parsed.volumeCm3,
      triangleCount: model.parsed.triangleCount,
      ...(model.defaultConfig ? { defaultConfig: model.defaultConfig } : {}),
      ...(model.sourceConfig ? { sourceConfig: model.sourceConfig } : {}),
      ...(model.lockedConfig ? { lockedConfig: model.lockedConfig } : {}),
    });
  }

  return { ok: true, models, totalBytes: prepared.totalBytes };
}

function printFailure(publicCode: string | undefined, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ ok: false, ...(publicCode ? { publicCode } : {}), message: message.slice(0, 500) || "The model could not be processed" })}\n`,
  );
}

async function main(): Promise<number> {
  let params: ParseChildParams;
  try {
    params = parseChildParamsSchema.parse(JSON.parse(process.argv[2] ?? ""));
  } catch {
    process.stderr.write("invalid parse-child parameters\n");
    return 70;
  }
  try {
    const result = await executeParseChild(params);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ModelParseError) {
      printFailure(`INVALID_MODEL_${error.code}`, error.message || "The model could not be parsed");
      return 64;
    }
    if (error instanceof ParseChildPublicError) {
      printFailure(error.publicCode, error.message);
      return 64;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 70;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
