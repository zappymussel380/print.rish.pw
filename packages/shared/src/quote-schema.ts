import { z } from "zod";
import { COLOUR_KEY_RE, INFILL_MAX_PCT, INFILL_MIN_PCT, MATERIAL_IDS, MAX_QUANTITY, SUPPORT_MODES } from "./quote-types";

/** The zod schemas for quote-types.ts, kept out of it so its constants reach
 *  the browser without zod. */

export const colourKeySchema = z.string().max(64).regex(COLOUR_KEY_RE);

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
  colour: colourKeySchema,
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

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
