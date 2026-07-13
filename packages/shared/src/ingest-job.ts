import { z } from "zod";
import {
  COLOUR_IDS,
  INFILL_MAX_PCT,
  INFILL_MIN_PCT,
  MATERIAL_IDS,
  MAX_QUANTITY,
  SUPPORT_MODES,
  type BoundingBoxMm,
  type ModelConfig,
} from "./quote-types";
import { type ModelFormat } from "./filename";
import { UUID_PATTERN } from "./uuid";

/** BullMQ queue name shared by the web producer and worker consumer. */
export const INGEST_QUEUE = "ingest";

/** Admission is intentionally small: every waiting job owns a customer file
 * and a worst-case canonical-output disk reservation. */
export const INGEST_MAX_WAITING = 25;
export const INGEST_JOB_RETENTION_SECONDS = 60 * 60;
export const INGEST_ADMISSION_TTL_SECONDS = 2 * 60 * 60;
export const INGEST_ADMISSION_KEY = "queue:ingest:admission";
export const UPLOAD_STORAGE_RESERVATION_KEY = "storage:upload-reservations";

const uuidSchema = z.string().uuid();
const modelFormatSchema = z.enum(["stl", "3mf", "obj", "amf"]);
const publicFailureSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    message: z.string().min(1).max(500),
  })
  .strict();

export const ingestJobDataSchema = z
  .object({
    tmpName: uuidSchema,
    sessionId: uuidSchema,
    originalName: z.string().min(1).max(255),
    format: modelFormatSchema,
    sizeBytes: z.number().int().positive().max(1024 * 1024 * 1024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    reservationMember: z.string().regex(new RegExp(`^\\d{1,15}:${UUID_PATTERN}$`, "i")),
    /** Set by the worker only for customer-safe, expected failures. Raw
     * BullMQ failure reasons are never returned by the status endpoint. */
    publicFailure: publicFailureSchema.optional(),
  })
  .strict();

export type IngestJobData = z.infer<typeof ingestJobDataSchema>;
export type IngestPublicFailure = z.infer<typeof publicFailureSchema>;

export interface UploadedModelDto {
  id: string;
  originalName: string;
  format: string;
  sizeBytes: number;
  bboxMm: BoundingBoxMm;
  volumeCm3: number;
  triangleCount?: number;
  fitsBed: boolean;
  defaultConfig?: Partial<ModelConfig>;
  sourceConfig?: Partial<ModelConfig>;
  lockedConfig?: Partial<Record<keyof ModelConfig, true>>;
}

const partialConfigSchema = z
  .object({
    material: z.enum(MATERIAL_IDS),
    colour: z.enum(COLOUR_IDS),
    layerHeightUm: z.union([z.literal(120), z.literal(160), z.literal(200)]),
    infillPct: z.number().int().min(INFILL_MIN_PCT).max(INFILL_MAX_PCT),
    supports: z.enum(SUPPORT_MODES),
    quantity: z.number().int().min(1).max(MAX_QUANTITY),
  })
  .partial()
  .strict();
const lockedConfigSchema = z
  .object({
    material: z.literal(true).optional(),
    colour: z.literal(true).optional(),
    layerHeightUm: z.literal(true).optional(),
    infillPct: z.literal(true).optional(),
    supports: z.literal(true).optional(),
    quantity: z.literal(true).optional(),
  })
  .strict();

export const uploadedModelDtoSchema: z.ZodType<UploadedModelDto> = z
  .object({
    id: uuidSchema,
    originalName: z.string().min(1).max(255),
    format: modelFormatSchema,
    sizeBytes: z.number().int().positive(),
    bboxMm: z
      .object({ x: z.number(), y: z.number(), z: z.number() })
      .strict(),
    volumeCm3: z.number().nonnegative(),
    triangleCount: z.number().int().nonnegative().optional(),
    fitsBed: z.boolean(),
    defaultConfig: partialConfigSchema.optional(),
    sourceConfig: partialConfigSchema.optional(),
    lockedConfig: lockedConfigSchema.optional(),
  })
  .strict();

export const ingestJobResultSchema = z
  .object({
    model: uploadedModelDtoSchema,
    models: z.array(uploadedModelDtoSchema).min(1),
  })
  .strict();

export type IngestJobResult = z.infer<typeof ingestJobResultSchema>;

/** `position` is a count of jobs ahead, so zero means this upload is next. */
export interface UploadAcceptedDto {
  ticket: string;
  position: number;
}

export type UploadTicketDto =
  | { status: "queued"; position: number; processorOnline: boolean }
  | { status: "processing" }
  | ({ status: "done" } & IngestJobResult)
  | { status: "failed"; error: IngestPublicFailure };

export function isModelFormat(value: string): value is ModelFormat {
  return modelFormatSchema.safeParse(value).success;
}

export function publicIngestFailure(
  code: string,
  message: string,
): IngestPublicFailure {
  return publicFailureSchema.parse({ code, message });
}
