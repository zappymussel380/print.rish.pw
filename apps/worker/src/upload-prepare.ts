import { createHash } from "node:crypto";
import {
  inspect3mfUpload,
  isZip,
  ModelParseError,
  parseModel,
  serializeBinaryStl,
  type ParsedModel,
  type ThreeMfSourceConfig,
} from "@print/geometry";
import {
  INFILL_MAX_PCT,
  INFILL_MIN_PCT,
  LAYER_HEIGHTS_UM,
  MATERIAL_IDS,
  SUPPORT_MODES,
  sanitizeOriginalName,
  type ModelConfig,
  type ModelFormat,
} from "@print/shared";

const CANONICAL_ARCHIVE_HEADER = "print.rish.pw canonical archive geometry";

export interface PreparedUploadModel {
  originalName: string;
  format: ModelFormat;
  contents: Buffer;
  parsed: ParsedModel;
  fileHash: string;
  sizeBytes: number;
  /** False only when the original upload bytes can be copied as-is. */
  derived: boolean;
  defaultConfig?: Partial<ModelConfig>;
  sourceConfig?: Partial<ModelConfig>;
  lockedConfig?: Partial<Record<keyof ModelConfig, true>>;
}

export interface PreparedUpload {
  models: PreparedUploadModel[];
  totalBytes: number;
}

interface PrepareUploadInput {
  contents: Buffer;
  originalName: string;
  format: ModelFormat;
  sourceSha256: string;
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function asStlName(originalName: string): string {
  const stem = originalName.replace(/\.[^.]+$/, "").trim() || "model";
  return sanitizeOriginalName(`${stem}.stl`);
}

function plateOriginalName(originalName: string, index: number): string {
  const stem = originalName.replace(/\.[^.]+$/, "").trim() || "model";
  return sanitizeOriginalName(`${stem} - plate ${String(index).padStart(2, "0")}.stl`);
}

function derivedModel(
  originalName: string,
  contents: Buffer,
  parsed: ParsedModel,
  config: Pick<PreparedUploadModel, "defaultConfig" | "sourceConfig" | "lockedConfig"> = {},
): PreparedUploadModel {
  return {
    originalName,
    format: "stl",
    contents,
    parsed,
    fileHash: sha256(contents),
    sizeBytes: contents.length,
    derived: true,
    ...config,
  };
}

function normalize3mfSourceConfig(
  raw: ThreeMfSourceConfig | null | undefined,
): Partial<ModelConfig> | undefined {
  if (!raw) return undefined;

  const source: Partial<ModelConfig> = {};
  if (raw.material && (MATERIAL_IDS as readonly string[]).includes(raw.material)) {
    source.material = raw.material as ModelConfig["material"];
  }
  if (
    typeof raw.layerHeightUm === "number" &&
    (LAYER_HEIGHTS_UM as readonly number[]).includes(raw.layerHeightUm)
  ) {
    source.layerHeightUm = raw.layerHeightUm as ModelConfig["layerHeightUm"];
  }
  const infillPct = raw.infillPct;
  if (
    Number.isInteger(infillPct) &&
    infillPct !== undefined &&
    infillPct >= INFILL_MIN_PCT &&
    infillPct <= INFILL_MAX_PCT
  ) {
    source.infillPct = infillPct;
  }
  if (raw.supports && (SUPPORT_MODES as readonly string[]).includes(raw.supports)) {
    source.supports = raw.supports as ModelConfig["supports"];
  }

  return Object.keys(source).length > 0 ? source : undefined;
}

/** Parse an upload once and produce exactly the bytes that may be persisted.
 *
 * 3MF and zipped AMF are never retained as archives: our bounded local-header
 * parser's triangle soup is serialized to binary STL, so the native slicer's
 * central-directory ZIP reader cannot select different geometry. Project print
 * defaults/locks are carried out-of-band on the model row before the archive is
 * discarded. Raw STL/OBJ/AMF retain their original bytes and streaming hash. */
export function prepareUploadModels(input: PrepareUploadInput): PreparedUpload {
  const { contents, originalName, format, sourceSha256 } = input;
  let models: PreparedUploadModel[];

  if (format === "3mf") {
    const inspection = inspect3mfUpload(contents);
    if (inspection.plates.length > 1) {
      models = inspection.plates.map((plate) => {
        const sourceConfig =
          normalize3mfSourceConfig(plate.sourceConfig) ??
          ({ supports: plate.configuredSupports ? "auto" : "off" } satisfies Partial<ModelConfig>);
        return derivedModel(
          plateOriginalName(originalName, plate.index),
          plate.stl,
          plate.model,
          {
            defaultConfig: sourceConfig,
            sourceConfig,
            lockedConfig: { supports: true },
          },
        );
      });
    } else {
      const parsed = inspection.model;
      if (!parsed) throw new ModelParseError("3MF contains no canonical model", "EMPTY");
      const stl = serializeBinaryStl(parsed.positions, CANONICAL_ARCHIVE_HEADER);
      const sourceConfig = normalize3mfSourceConfig(inspection.sourceConfig);
      models = [
        derivedModel(asStlName(originalName), stl, parsed, {
          ...(sourceConfig ? { defaultConfig: sourceConfig, sourceConfig } : {}),
        }),
      ];
    }
  } else {
    const parsed = parseModel(contents, format);
    if (format === "amf" && isZip(contents)) {
      const stl = serializeBinaryStl(parsed.positions, CANONICAL_ARCHIVE_HEADER);
      models = [derivedModel(asStlName(originalName), stl, parsed)];
    } else {
      models = [
        {
          originalName,
          format,
          contents,
          parsed,
          fileHash: sourceSha256,
          sizeBytes: contents.length,
          derived: false,
        },
      ];
    }
  }

  return {
    models,
    totalBytes: models.reduce((sum, model) => sum + model.sizeBytes, 0),
  };
}
