import { z } from "zod";
import { MATERIAL_IDS, type ColourId, type MaterialId } from "./quote-types";
import { MASTER_COLOURS, MATERIAL_COLOURS, DEFAULT_ENABLED_COLOURS } from "./colours";

/**
 * Runtime, admin-controlled availability of materials and colours, overlaid on
 * the static catalog. Persisted as a single JSON app setting; this module holds
 * only pure logic (no DB) so it is trivially testable and usable on the client.
 */
export interface Availability {
  materials: Record<MaterialId, boolean>;
  /** Enabled colour ids per material — always a subset of `MATERIAL_COLOURS`. */
  colours: Record<MaterialId, ColourId[]>;
}

/** Legacy colour ids resolve to their modern equivalent for availability checks
 *  so a session that still carries `"black"` maps to the enabled `pitch-black`. */
export const LEGACY_COLOUR_ALIAS: Record<string, ColourId> = {
  black: "pitch-black",
  white: "pure-white",
};

/** Wire shape for a stored/submitted availability blob. Loose on purpose —
 *  `normalizeAvailability` is the single place that hardens it. */
export const availabilitySchema = z.object({
  // String keys (not a material enum) so a partial blob — e.g. colours for only
  // one material — still parses; `normalizeAvailability` reads by known id and
  // ignores anything else.
  materials: z.record(z.string(), z.boolean()).optional(),
  colours: z.record(z.string(), z.array(z.string())).optional(),
});
export type AvailabilityInput = z.infer<typeof availabilitySchema>;

/** The default when nothing is stored: every material on, colours limited to the
 *  historically in-stock set. */
export function defaultAvailability(): Availability {
  const materials = {} as Record<MaterialId, boolean>;
  const colours = {} as Record<MaterialId, ColourId[]>;
  for (const m of MATERIAL_IDS) {
    materials[m] = true;
    colours[m] = [...DEFAULT_ENABLED_COLOURS[m]];
  }
  return { materials, colours };
}

/** Harden arbitrary/stored input into a valid Availability: fill missing keys
 *  from defaults, drop unknown materials, and drop any colour that isn't part of
 *  that material's real palette. */
export function normalizeAvailability(raw: unknown): Availability {
  const base = defaultAvailability();
  const parsed = availabilitySchema.safeParse(raw ?? {});
  if (!parsed.success) return base;

  for (const m of MATERIAL_IDS) {
    const enabled = parsed.data.materials?.[m];
    if (typeof enabled === "boolean") base.materials[m] = enabled;

    const rawColours = parsed.data.colours?.[m];
    if (Array.isArray(rawColours)) {
      const universe = new Set<string>(MATERIAL_COLOURS[m]);
      const seen = new Set<ColourId>();
      const cleaned: ColourId[] = [];
      for (const c of rawColours) {
        if (universe.has(c) && !seen.has(c as ColourId)) {
          seen.add(c as ColourId);
          cleaned.push(c as ColourId);
        }
      }
      base.colours[m] = cleaned;
    }
  }
  return base;
}

export function isMaterialEnabled(avail: Availability, material: MaterialId): boolean {
  return avail.materials[material] === true;
}

export function isColourEnabled(
  avail: Availability,
  material: MaterialId,
  colour: string,
): boolean {
  const resolved = (LEGACY_COLOUR_ALIAS[colour] ?? colour) as ColourId;
  return avail.colours[material]?.includes(resolved) ?? false;
}

export type AvailabilityViolation =
  | { ok: true }
  | { ok: false; code: "MATERIAL_UNAVAILABLE" | "COLOUR_UNAVAILABLE"; message: string };

/** Gate a chosen material (+optional colour) against current availability. */
export function assertConfigAvailable(
  config: { material: MaterialId; colour?: string },
  avail: Availability,
): AvailabilityViolation {
  if (!isMaterialEnabled(avail, config.material)) {
    return {
      ok: false,
      code: "MATERIAL_UNAVAILABLE",
      message: `Material ${config.material} is not currently available.`,
    };
  }
  if (config.colour !== undefined && !isColourEnabled(avail, config.material, config.colour)) {
    return {
      ok: false,
      code: "COLOUR_UNAVAILABLE",
      message: `The selected colour is not available in ${config.material}.`,
    };
  }
  return { ok: true };
}

export interface PublicColour {
  id: ColourId;
  name: string;
  hex: string;
  enabled: boolean;
}
export interface PublicMaterial {
  id: MaterialId;
  name: string;
  enabled: boolean;
  colours: PublicColour[];
}

/** Serialisable view of the full palette with per-item enabled flags, for the
 *  customer quote UI and the admin editor. */
export function toPublicCatalog(avail: Availability): { materials: PublicMaterial[] } {
  const materials = MATERIAL_IDS.map((m) => ({
    id: m,
    name: m,
    enabled: isMaterialEnabled(avail, m),
    colours: MATERIAL_COLOURS[m].map((id) => ({
      id,
      name: MASTER_COLOURS[id].name,
      hex: MASTER_COLOURS[id].hex,
      enabled: avail.colours[m]?.includes(id) ?? false,
    })),
  }));
  return { materials };
}

/** First enabled colour for a material, if any (used to reset a stale choice). */
export function firstEnabledColour(
  avail: Availability,
  material: MaterialId,
): ColourId | undefined {
  return avail.colours[material]?.[0];
}
