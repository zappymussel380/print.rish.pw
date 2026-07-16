import { z } from "zod";
import {
  lockedConfigSchema,
  modelFormatSchema,
  partialConfigSchema,
  uploadFormatSchema,
} from "./ingest-job";

/** Wire contract between the worker orchestrator and the isolated parse child
 * process. The child parses untrusted uploads under a throwaway uid, so the
 * orchestrator treats everything it reports — the JSON on stdout and the files
 * it writes — as untrusted input and validates it against these schemas. */

const finiteNonNegative = z.number().finite().nonnegative();

export const parseChildParamsSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("prepare"),
      inputPath: z.string().min(1),
      originalName: z.string().min(1).max(255),
      format: uploadFormatSchema,
      sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
      outDir: z.string().min(1),
      thumbSize: z.number().int().min(16).max(4096),
      maxUploadBytes: z.number().int().positive(),
      /** STEP→STL converter binary; orchestrator-controlled, defaults in-child. */
      stepConvertBin: z.string().min(1).optional(),
      stepConvertTimeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("thumbnail"),
      inputPath: z.string().min(1),
      format: modelFormatSchema,
      outPath: z.string().min(1),
      thumbSize: z.number().int().min(16).max(4096),
      maxUploadBytes: z.number().int().positive(),
    })
    .strict(),
]);

export type ParseChildParams = z.infer<typeof parseChildParamsSchema>;

export const parseChildModelSchema = z
  .object({
    /** Both names are child-chosen; the orchestrator only ever joins them onto
     * its own out directory after this pattern check, so they cannot traverse. */
    fileName: z.string().regex(/^model-\d{1,3}\.(stl|3mf|obj|amf)$/),
    thumbFile: z
      .string()
      .regex(/^thumb-\d{1,3}\.png$/)
      .nullable(),
    originalName: z.string().min(1).max(255),
    format: modelFormatSchema,
    fileHash: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().positive(),
    derived: z.boolean(),
    bboxMm: z
      .object({ x: finiteNonNegative, y: finiteNonNegative, z: finiteNonNegative })
      .strict(),
    volumeCm3: finiteNonNegative,
    triangleCount: z.number().int().nonnegative(),
    defaultConfig: partialConfigSchema.optional(),
    sourceConfig: partialConfigSchema.optional(),
    lockedConfig: lockedConfigSchema.optional(),
  })
  .strict();

export type ParseChildModel = z.infer<typeof parseChildModelSchema>;

export const parseChildSuccessSchema = z
  .object({
    ok: z.literal(true),
    models: z.array(parseChildModelSchema).max(64),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();

export type ParseChildSuccess = z.infer<typeof parseChildSuccessSchema>;

/** `publicCode` marks failures that are safe to show to the customer
 * (parse rejections, size limits); anything else stays internal. */
export const parseChildFailureSchema = z
  .object({
    ok: z.literal(false),
    publicCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
    message: z.string().min(1).max(500),
  })
  .strict();

export type ParseChildFailure = z.infer<typeof parseChildFailureSchema>;

export const parseChildOutputSchema = z.discriminatedUnion("ok", [
  parseChildSuccessSchema,
  parseChildFailureSchema,
]);

export type ParseChildOutput = z.infer<typeof parseChildOutputSchema>;
