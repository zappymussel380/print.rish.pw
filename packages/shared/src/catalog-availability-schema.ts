import { z } from "zod";
import { CUSTOM_MATERIAL_IDS, LAYER_HEIGHTS_UM, MATERIAL_IDS, type MaterialId } from "./quote-types";
import { MATERIAL_COLOURS } from "./colours";
import { MAX_CUSTOM_COLOURS, type CustomColour } from "./custom-colours";
import { normalizeCustomColours } from "./custom-colours-schema";
import { cleanCustomMaterialName } from "./custom-materials";
import { CUSTOM_GUIDE_LIMITS, MATERIAL_GUIDE_KEYS, cleanCustomGuide } from "./material-guide";
import type { CustomMaterialNames } from "./catalog";
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
  // The shop's names for its own materials and their /materials copy; hardened
  // by cleanCustomMaterialName and cleanCustomGuide.
  customMaterials: z.record(z.string(), z.object({ name: z.unknown(), guide: z.unknown() }).partial()).optional(),
  // Offered layer heights (µm); anything else is dropped, none means all.
  layerHeights: z.array(z.unknown()).max(LAYER_HEIGHTS_UM.length * 2).optional(),
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
  base.customMaterials = normalizeCustomMaterialNames(parsed.data.customMaterials);
  const heights = parsed.data.layerHeights;
  if (heights) {
    const offered = LAYER_HEIGHTS_UM.filter((um) => heights.includes(um));
    if (offered.length > 0) base.layerHeights = offered;
  }
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

/** Keep the names of the shop's own materials that are usable, with their
 *  /materials copy; drop the rest (copy goes with its name). */
export function normalizeCustomMaterialNames(raw: unknown): CustomMaterialNames {
  const out: CustomMaterialNames = {};
  if (!raw || typeof raw !== "object") return out;
  for (const id of CUSTOM_MATERIAL_IDS) {
    const entry = (raw as Record<string, { name?: unknown; guide?: unknown } | undefined>)[id];
    const name = cleanCustomMaterialName(entry?.name);
    if (!name) continue;
    const guide = cleanCustomGuide(entry?.guide);
    out[id] = guide ? { name, guide } : { name };
  }
  return out;
}

const guideText = z.string().max(Math.max(CUSTOM_GUIDE_LIMITS.subtitle, CUSTOM_GUIDE_LIMITS.row) * 2);

/** Admin: the names the owner typed for their own materials, one per slot, and
 *  the copy they wrote for /materials. An empty string clears a name; a guide of
 *  blanks clears the copy. Loose here; normalizeCustomMaterialNames and the
 *  route decide what is usable. */
export const customMaterialNamesInputSchema = z
  .object({
    // Partial: the editor saves one slot at a time (a zod 4 enum-keyed record
    // would demand every slot).
    names: z.partialRecord(z.enum(CUSTOM_MATERIAL_IDS), z.string().max(200)).optional(),
    guides: z
      .partialRecord(
        z.enum(CUSTOM_MATERIAL_IDS),
        z.partialRecord(z.enum(MATERIAL_GUIDE_KEYS), guideText),
      )
      .optional(),
  })
  .refine((v) => v.names !== undefined || v.guides !== undefined);
