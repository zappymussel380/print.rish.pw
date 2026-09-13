import { z } from "zod";

/** Materials, colours, layer heights and support modes offered to customers.
 *  Extend these tuples (plus `catalog.ts`) to add options — everything else
 *  (validation, pricing, UI selects) derives from them. */
export const MATERIAL_IDS = [
  "PLA",
  "PLA_AESTHETIC",
  "PLA_CF",
  "PETG",
  "PETG_PREMIUM",
  "ABS",
  "ASA",
] as const;
/** The full orderable colour universe (Numakers palette), plus the legacy
 *  `black`/`white` ids kept accept-only for records created before the palette
 *  expanded. Which of these a customer may actually pick is a runtime,
 *  admin-controlled subset — see `catalog-availability.ts`. Display names and
 *  swatches live in `colours.ts` (`MASTER_COLOURS`), whose keys must stay in
 *  exact sync with this tuple (enforced by a completeness type + a unit test). */
export const COLOUR_IDS = [
  "pitch-black",
  "pure-white",
  "lemon-yellow",
  "mauve-purple",
  "nuclear-red",
  "imperial-red",
  "outrageous-orange",
  "atomic-pink",
  "royal-blue",
  "light-gray",
  "light-blue",
  "grass-green",
  "beige-brown",
  "teal-blue",
  "army-green",
  "dark-gray",
  "ivory-white",
  "rust-copper",
  "apricot",
  "lagoon-blue",
  "forest-green",
  "fluorescent-orange",
  "fluorescent-green",
  "transparent",
  "bahama-yellow",
  "chocolate-brown",
  "fluorescent-yellow",
  "lavender-violet",
  "magenta",
  "military-khaki",
  "ryobix-green",
  "simply-silver",
  "midnight-gray",
  "thanos-purple",
  "cool-white",
  "bone-white",
  "terracota-orange",
  "water-blue",
  "light-beige",
  "ivory",
  "baby-pink",
  // Aesthetic PLA — Matte
  "matte-ruby-red",
  "matte-sakura-pink",
  "matte-skin",
  "matte-sunshine-yellow",
  "matte-mint-green",
  "matte-ice-blue",
  "matte-olive-green",
  "matte-navy-blue",
  "matte-moon-gray",
  "matte-lilac-purple",
  "matte-beige",
  "matte-white",
  "matte-black",
  // Aesthetic PLA — Silk
  "silk-copper",
  "silk-orange",
  "silk-red",
  "silk-yellow",
  "silk-molten-gold",
  "silk-antique-gold",
  "silk-mint-green",
  "silk-christmas-green",
  "silk-blue",
  "silk-lagoon",
  "silk-deep-blue",
  "silk-lilac",
  "silk-purple",
  "silk-pale-lavender",
  "silk-petal-pink",
  "silk-pink",
  "silk-white",
  "silk-silver",
  "silk-black",
  "silk-gold",
  "silk-enchanted-gold",
  "silk-bronze",
  "silk-molten-sol",
  "silk-forest-green",
  "silk-obsidian-night",
  // Aesthetic PLA — Dual/Tri-Colour Silk
  "tri-copper-silver-gold",
  "tri-blue-green-gold",
  "tri-black-purple-gold",
  "tri-black-purple-orange",
  "tri-silver-purple-blue",
  "tri-green-magenta-blue",
  "tri-red-yellow-blue",
  "tri-red-orange-gold",
  "tri-red-blue-white",
  "dual-black-gold",
  "dual-blue-magenta",
  "dual-purple-black",
  "dual-red-black",
  "dual-red-gold",
  // Aesthetic PLA — Metallic
  "metallic-titanium-blue",
  "metallic-ferrous-green",
  "metallic-sunset-bronze",
  "metallic-tungsten-brown",
  "metallic-burnished-copper",
  "metallic-burnt-copper",
  // Aesthetic PLA — Stone
  "stone-white",
  // Aesthetic PLA — Starlight
  "starlight-nebula",
  "starlight-comet",
  "starlight-titan",
  "starlight-midnight",
  "starlight-neptune",
  // Aesthetic PLA — Glow in the Dark
  "glow-green",
  "glow-orange",
  "glow-pink",
  "glow-blue",
  "glow-aqua-blue",
  // Aesthetic PLA — Wood
  "wood-natural",
  // PLA-CF
  "cf-black",
  "cf-wine-red",
  "cf-lemongrass-green",
  "cf-denim-blue",
  // PETG Premium — Translucent
  "translucent-blue",
  "translucent-ice-blue",
  "translucent-ice-blue-glitter",
  "translucent-arctic",
  "translucent-arctic-glitter",
  "translucent-pink",
  "translucent-pink-glitter",
  "translucent-hot-pink",
  "translucent-red",
  "translucent-orange",
  "translucent-orange-glitter",
  "translucent-green",
  "translucent-green-glitter",
  "translucent-yellow",
  // PETG Premium — Carbon Fibre
  "petg-cf-black",
  "petg-cf-volcanic-rock-gray",
  "petg-cf-tactical-green",
  "petg-cf-denim-blue",
  "petg-cf-purple",
  // Legacy — accept-only, never offered going forward.
  "black",
  "white",
] as const;
export const LAYER_HEIGHTS_UM = [120, 160, 200] as const;
export const SUPPORT_MODES = ["auto", "off", "always"] as const;
export const INFILL_MIN_PCT = 10;
export const INFILL_MAX_PCT = 60;
export const MAX_QUANTITY = 100;

export type MaterialId = (typeof MATERIAL_IDS)[number];
export type ColourId = (typeof COLOUR_IDS)[number];

/** Shape of any colour a model may carry: a palette id from `COLOUR_IDS` or an
 *  admin-defined custom colour (`custom-…`, see `custom-colours.ts`). The shape
 *  is all the wire schema can check — whether the colour may actually be
 *  ordered is decided against live availability by `assertConfigAvailable`. */
export const COLOUR_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const colourKeySchema = z.string().max(64).regex(COLOUR_KEY_RE);
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
  colour: colourKeySchema,
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  material: "PLA",
  colour: "pitch-black",
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
