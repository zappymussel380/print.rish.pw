import {
  CUSTOM_MATERIAL_IDS,
  LAYER_HEIGHTS_UM,
  MATERIAL_IDS,
  isCustomMaterial,
  type ColourId,
  type CustomMaterialId,
  type LayerHeightUm,
  type MaterialId,
} from "./quote-types";
import { materialName, type CustomMaterialNames } from "./catalog";
import {
  MASTER_COLOURS,
  MATERIAL_COLOURS,
  DEFAULT_ENABLED_COLOURS,
  DEFAULT_ENABLED_MATERIALS,
  colourName,
} from "./colours";
import { CUSTOM_COLOUR_GROUP, type CustomColour } from "./custom-colours";

/**
 * Runtime, admin-controlled availability of materials and colours, overlaid on
 * the static catalog. Persisted as a single JSON app setting; this module holds
 * only pure logic (no DB) so it is trivially testable and usable on the client —
 * and zod-free for the same reason: hardening a stored blob lives in
 * catalog-availability-schema.ts.
 */
export interface Availability {
  materials: Record<MaterialId, boolean>;
  /** Enabled colour ids per material — always a subset of that material's
   *  palette (`MATERIAL_COLOURS`) plus its custom colours. */
  colours: Record<MaterialId, string[]>;
  /** Admin-defined hex colours, saved in the same blob as their enabled flags. */
  customColours: CustomColour[];
  /** The shop's names for its own materials (OTHER_*). Only named slots appear. */
  customMaterials: CustomMaterialNames;
  /** Layer heights customers may pick, in `LAYER_HEIGHTS_UM` order; never
   *  empty. A shop that prints at one height offers just that one. */
  layerHeights: LayerHeightUm[];
}

/** Legacy colour ids resolve to their modern equivalent for availability checks
 *  so a session that still carries `"black"` maps to the enabled `pitch-black`. */
export const LEGACY_COLOUR_ALIAS: Record<string, ColourId> = {
  black: "pitch-black",
  white: "pure-white",
};

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
  return { materials, colours, customColours: [], customMaterials: {}, layerHeights: [...LAYER_HEIGHTS_UM] };
}

export function isLayerHeightEnabled(avail: Availability, um: number): boolean {
  return (avail.layerHeights as readonly number[]).includes(um);
}

/** The layer height a new model starts at: 0.20 mm (fastest, cheapest) when
 *  it's offered, else the coarsest one that is. */
export function defaultLayerHeight(layerHeights: readonly LayerHeightUm[]): LayerHeightUm {
  return layerHeights.includes(200) ? 200 : (layerHeights.at(-1) ?? 200);
}

/** "0.16 mm". */
export function layerHeightLabel(um: number): string {
  return `${(um / 1000).toFixed(2)} mm`;
}

/** Why one of the shop's own materials can't be offered yet, or null when it
 *  can: it needs a name, and a live (test-sliced) OrcaSlicer filament profile. */
export function customMaterialProblem(
  avail: Availability,
  id: CustomMaterialId,
  ready: ReadonlySet<CustomMaterialId>,
): string | null {
  const label = materialName(id, avail.customMaterials);
  if (!avail.customMaterials[id]?.name) return `${label} needs a name first.`;
  if (!ready.has(id)) return `${label} needs an OrcaSlicer profile first — start from one of OrcaSlicer's or upload your own.`;
  return null;
}

/** Availability as customers get it: one of the shop's own materials is only
 *  on when it's switched on AND named AND has a live filament profile, so a
 *  profile that later fails or is removed takes it off sale by itself. */
export function effectiveAvailability(avail: Availability, ready: ReadonlySet<CustomMaterialId>): Availability {
  const materials = { ...avail.materials };
  for (const id of CUSTOM_MATERIAL_IDS) {
    if (materials[id] && customMaterialProblem(avail, id, ready)) materials[id] = false;
  }
  return { ...avail, materials };
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
  | { ok: false; code: "MATERIAL_UNAVAILABLE" | "COLOUR_UNAVAILABLE" | "LAYER_HEIGHT_UNAVAILABLE"; message: string };

/** Gate a chosen material (+optional colour and layer height) against current
 *  availability. */
export function assertConfigAvailable(
  config: { material: MaterialId; colour?: string; layerHeightUm?: number },
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
  if (config.layerHeightUm !== undefined && !isLayerHeightEnabled(avail, config.layerHeightUm)) {
    return {
      ok: false,
      code: "LAYER_HEIGHT_UNAVAILABLE",
      message: `${layerHeightLabel(config.layerHeightUm)} layers are not offered — pick ${avail.layerHeights.map(layerHeightLabel).join(" or ")}.`,
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
  /** Admin view of one of the shop's own materials: what it still needs. */
  setup?: { named: boolean; ready: boolean; problem: string | null };
}

/** Serialisable view of the full palette with per-item enabled flags, for the
 *  customer quote UI and the admin editor. */
/** Pass `ready` (the admin view) to describe what each of the shop's own
 *  materials still needs; customers get effectiveAvailability instead. */
export function toPublicCatalog(
  avail: Availability,
  ready?: ReadonlySet<CustomMaterialId>,
): { materials: PublicMaterial[]; layerHeights: LayerHeightUm[] } {
  const materials = MATERIAL_IDS.map((m) => ({
    id: m,
    name: materialName(m, avail.customMaterials),
    enabled: isMaterialEnabled(avail, m),
    ...(ready && isCustomMaterial(m)
      ? {
          setup: {
            named: Boolean(avail.customMaterials[m]?.name),
            ready: ready.has(m),
            problem: customMaterialProblem(avail, m, ready),
          },
        }
      : {}),
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
  return { materials, layerHeights: [...avail.layerHeights] };
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
