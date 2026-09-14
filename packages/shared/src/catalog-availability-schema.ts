import { z } from "zod";
import { CUSTOM_MATERIAL_IDS, MATERIAL_IDS, type MaterialId } from "./quote-types";
import { MATERIAL_COLOURS } from "./colours";
import { MAX_CUSTOM_COLOURS, type CustomColour } from "./custom-colours";
import { normalizeCustomColours } from "./custom-colours-schema";
import { cleanCustomMaterialName } from "./custom-materials";
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
  // The shop's names for its own materials; hardened by cleanCustomMaterialName.
  customMaterials: z.record(z.string(), z.object({ name: z.unknown() }).partial()).optional(),
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

/** Keep the names of the shop's own materials that are usable; drop the rest. */
export function normalizeCustomMaterialNames(raw: unknown): CustomMaterialNames {
  const out: CustomMaterialNames = {};
  if (!raw || typeof raw !== "object") return out;
  for (const id of CUSTOM_MATERIAL_IDS) {
    const name = cleanCustomMaterialName((raw as Record<string, { name?: unknown } | undefined>)[id]?.name);
    if (name) out[id] = { name };
  }
  return out;
}

/** Admin: the names the owner typed for their own materials, one per slot. An
 *  empty string clears a name. Loose here; normalizeCustomMaterialNames and
 *  the route decide what is usable. */
export const customMaterialNamesInputSchema = z.object({
  names: z.record(z.enum(CUSTOM_MATERIAL_IDS), z.string().max(200)),
});
