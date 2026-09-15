import { z } from "zod";
import { BUILT_IN_NEEDS, NEED_IDS, OWN_NEED_LIMITS, OWN_NEEDS } from "./material-helper";
import { MATERIAL_IDS } from "./quote-types";

const score = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

/** What admin → Filament → Material helper sends: the whole helper at once. */
export const materialHelperInputSchema = z.object({
  enabled: z.boolean(),
  builtIn: z.object(Object.fromEntries(BUILT_IN_NEEDS.map((id) => [id, z.boolean()])) as Record<(typeof BUILT_IN_NEEDS)[number], z.ZodBoolean>),
  own: z.partialRecord(
    z.enum(OWN_NEEDS),
    z.object({
      label: z.string().trim().min(1).max(OWN_NEED_LIMITS.label),
      description: z.string().trim().max(OWN_NEED_LIMITS.description),
      enabled: z.boolean(),
    }),
  ),
  scores: z.partialRecord(z.enum(MATERIAL_IDS), z.partialRecord(z.enum(NEED_IDS), score)),
});
export type MaterialHelperInput = z.infer<typeof materialHelperInputSchema>;
