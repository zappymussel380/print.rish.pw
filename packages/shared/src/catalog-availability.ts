import { z } from "zod";
import { MATERIAL_IDS, type ColourId, type MaterialId } from "./quote-types";
import { materialName } from "./catalog";
import {
  MASTER_COLOURS,
  MATERIAL_COLOURS,
  DEFAULT_ENABLED_COLOURS,
  DEFAULT_ENABLED_MATERIALS,
  colourName,
} from "./colours";
import {
  CUSTOM_COLOUR_GROUP,
  MAX_CUSTOM_COLOURS,
  normalizeCustomColours,
  type CustomColour,
} from "./custom-colours";

/**
 * Runtime, admin-controlled availability of materials and colours, overlaid on
 * the static catalog. Persisted as a single JSON app setting; this module holds
 * only pure logic (no DB) so it is trivially testable and usable on the client.
 */
export interface Availability {
  materials: Record<MaterialId, boolean>;
  /** Enabled colour ids per material — always a subset of that material's
   *  palette (`MATERIAL_COLOURS`) plus its custom colours. */
  colours: Record<MaterialId, string[]>;
  /** Admin-defined hex colours, saved in the same blob as their enabled flags. */
  customColours: CustomColour[];
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
  // Entries are hardened one by one in `normalizeCustomColours`; only the
  // length is bounded here so an oversized blob is refused outright.
  customColours: z.array(z.unknown()).max(MAX_CUSTOM_COLOURS).optional(),
});
export type AvailabilityInput = z.infer<typeof availabilitySchema>;

/** The default when nothing is stored (or a stored blob predates a material):
 *  the basic materials on, premium tiers off, colours limited to the historically
 *  in-stock set. */
export function defaultAvailability(): Availability {
  const materials = {} as Record<MaterialId, boolean>;
  const colours = {} as Record<MaterialId, string[]>;
  for (const m of MATERIAL_IDS) {
    materials[m] = DEFAULT_ENABLED_MATERIALS[m];
    colours[m] = [...DEFAULT_ENABLED_COLOURS[m]];
  }
  return { materials, colours, customColours: [] };
}

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

export function isMaterialEnabled(avail: Availability, material: MaterialId): boolean {
  return avail.materials[material] === true;
}

export function isColourEnabled(
  avail: Availability,
  material: MaterialId,
  colour: string,
): boolean {
  const resolved = LEGACY_COLOUR_ALIAS[colour] ?? colour;
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
      message: `${materialName(config.material)} is not currently available.`,
    };
  }
  if (config.colour !== undefined && !isColourEnabled(avail, config.material, config.colour)) {
    return {
      ok: false,
      code: "COLOUR_UNAVAILABLE",
      message: `The selected colour is not available in ${materialName(config.material)}.`,
    };
  }
  return { ok: true };
}

export interface PublicColour {
  id: string;
  name: string;
  hex: string;
  /** Present only for dual/tri-colour filament — see `swatchBackground`. */
  stops?: readonly string[];
  /** Sub-section within a multi-line tier ("Matte", "Silk" …) — see `groupColours`. */
  group?: string;
  /** Admin-defined (hex picker) rather than a supplier palette colour. */
  custom?: true;
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
    name: materialName(m),
    enabled: isMaterialEnabled(avail, m),
    colours: [
      ...MATERIAL_COLOURS[m].map((id): PublicColour => {
        const { name, hex, stops, group } = MASTER_COLOURS[id];
        return {
          id,
          name,
          hex,
          ...(stops ? { stops } : {}),
          ...(group ? { group } : {}),
          enabled: avail.colours[m]?.includes(id) ?? false,
        };
      }),
      ...avail.customColours
        .filter((c) => c.material === m)
        .map(
          (c): PublicColour => ({
            id: c.id,
            name: c.name,
            hex: c.hex,
            // A heading only where it separates customs from a palette.
            ...(MATERIAL_COLOURS[m].length > 0 ? { group: CUSTOM_COLOUR_GROUP } : {}),
            custom: true,
            enabled: avail.colours[m]?.includes(c.id) ?? false,
          }),
        ),
    ],
  }));
  return { materials };
}

/** Display name for any colour id, custom colours included. Palette and legacy
 *  ids resolve without the list; an unknown custom id falls back to the raw id. */
export function resolveColourName(id: string, customs: readonly CustomColour[]): string {
  return customs.find((c) => c.id === id)?.name ?? colourName(id);
}

/** First enabled colour for a material, if any (used to reset a stale choice). */
export function firstEnabledColour(
  avail: Availability,
  material: MaterialId,
): string | undefined {
  return avail.colours[material]?.[0];
}
