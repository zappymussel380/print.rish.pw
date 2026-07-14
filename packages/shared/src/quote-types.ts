import { z } from "zod";

/** Materials, colours, layer heights and support modes offered to customers.
 *  Extend these tuples (plus `catalog.ts`) to add options — everything else
 *  (validation, pricing, UI selects) derives from them. */
export const MATERIAL_IDS = ["PLA", "PETG"] as const;
export const COLOUR_IDS = ["black", "white"] as const;
export const LAYER_HEIGHTS_UM = [120, 160, 200] as const;
export const SUPPORT_MODES = ["auto", "off", "always"] as const;
export const INFILL_MIN_PCT = 10;
export const INFILL_MAX_PCT = 60;
export const MAX_QUANTITY = 100;

export type MaterialId = (typeof MATERIAL_IDS)[number];
export type ColourId = (typeof COLOUR_IDS)[number];
export type LayerHeightUm = (typeof LAYER_HEIGHTS_UM)[number];
export type SupportMode = (typeof SUPPORT_MODES)[number];

/** The knobs that affect slicing output. Colour and quantity deliberately
 *  excluded — they only affect pricing/records, never the slicer. */
export const sliceSettingsSchema = z.object({
  material: z.enum(MATERIAL_IDS),
  layerHeightUm: z.union([z.literal(120), z.literal(160), z.literal(200)]),
  infillPct: z.number().int().min(INFILL_MIN_PCT).max(INFILL_MAX_PCT),
  supports: z.enum(SUPPORT_MODES),
});
export type SliceSettings = z.infer<typeof sliceSettingsSchema>;

/** Full per-model configuration as chosen by the customer. */
export const modelConfigSchema = sliceSettingsSchema.extend({
  colour: z.enum(COLOUR_IDS),
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  material: "PLA",
  colour: "black",
  layerHeightUm: 200,
  infillPct: 15,
  supports: "auto",
  quantity: 1,
};

/** What the worker reports back from a successful slice. */
export interface SliceStats {
  filamentGrams: number;
  filamentMm: number;
  printSeconds: number;
  /** Support filament grams when the slicer reports it separately; else null. */
  supportGrams: number | null;
}

export interface BoundingBoxMm {
  x: number;
  y: number;
  z: number;
}

export const sliceJobStages = ["queued", "slicing", "parsing", "done", "failed"] as const;
export type SliceJobStage = (typeof sliceJobStages)[number];

export const sliceProgressStages = [
  "queued",
  "preparing",
  "slicing",
  "finalizing",
  "complete",
  "failed",
] as const;
export type SliceProgressStage = (typeof sliceProgressStages)[number];

export interface SliceProgress {
  percent: number;
  stage: SliceProgressStage;
  message: string;
}

export const customerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().pipe(z.email().max(254)),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 \-()]{6,19}$/, "Enter a valid phone number"),
  city: z.string().trim().min(2).max(80),
  notes: z.string().trim().max(2000).optional().default(""),
});
export type Customer = z.infer<typeof customerSchema>;
