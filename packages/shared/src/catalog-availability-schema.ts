import { z } from "zod";
import { MATERIAL_IDS, type MaterialId } from "./quote-types";
import { MATERIAL_COLOURS } from "./colours";
import { MAX_CUSTOM_COLOURS, type CustomColour } from "./custom-colours";
import { normalizeCustomColours } from "./custom-colours-schema";
import { defaultAvailability, type Availability } from "./catalog-availability";

/** Wire shape for a stored/submitted availability blob. Loose on purpose —
 *  `normalizeAvailability` is the single place that hardens it. */
export const availabilitySchema = z.object({
  // String keys (not a material enum) so a partial blob — e.g. colours for only
  // one material — still parses; `normalizeAvailability` reads by known id and
  // ignores anything else.
  materials: z.record(z.string(), z.boolean()).optional(),
  colours: z.record(z.string(), z.array(z.string())).optional(),
  // Entries are hardened one by one in `normalizeCustomColours`; only the
  // length is bounded here so an oversized blob is refused outright.
  customColours: z.array(z.unknown()).max(MAX_CUSTOM_COLOURS).optional(),
});
export type AvailabilityInput = z.infer<typeof availabilitySchema>;

/** Every colour id a material can offer: its palette, then its custom colours. */
function colourUniverse(material: MaterialId, customs: readonly CustomColour[]): string[] {
  return [
    ...MATERIAL_COLOURS[material],
    ...customs.filter((c) => c.material === material).map((c) => c.id),
  ];
}

/** Harden arbitrary/stored input into a valid Availability: fill missing keys
 *  from defaults, drop unknown materials, and drop any colour that isn't part of
 *  that material's real palette or its custom colours. */
export function normalizeAvailability(raw: unknown): Availability {
  const base = defaultAvailability();
  const parsed = availabilitySchema.safeParse(raw ?? {});
  if (!parsed.success) return base;

  base.customColours = normalizeCustomColours(parsed.data.customColours);
  for (const m of MATERIAL_IDS) {
    const enabled = parsed.data.materials?.[m];
    if (typeof enabled === "boolean") base.materials[m] = enabled;

    const rawColours = parsed.data.colours?.[m];
    if (Array.isArray(rawColours)) {
      const universe = new Set(colourUniverse(m, base.customColours));
      base.colours[m] = [...new Set(rawColours.filter((c) => universe.has(c)))];
    }
  }
  return base;
}
