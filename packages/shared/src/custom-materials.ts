import { CUSTOM_MATERIAL_IDS, LAYER_HEIGHTS_UM, MATERIAL_IDS, isCustomMaterial, type CustomMaterialId } from "./quote-types";

/**
 * The shop's own materials (OTHER_1…OTHER_4): fixed slots an owner names and
 * gives an OrcaSlicer filament profile in the admin dashboard — ABS-CF, PC,
 * PA… — without a code change per material. Zod-free: the admin editor and the
 * quote UI both use it.
 *
 * A slot is offered to customers only once it has a name AND a live, test-sliced
 * filament profile (`effectiveAvailability` in catalog-availability.ts).
 */

export const CUSTOM_MATERIAL_NAME_MAX = 40;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,+\-/()%&]*$/u;

/** A name as the owner typed it, tidied: trimmed, inner whitespace collapsed.
 *  Null when it isn't usable (empty, too long, or odd characters). */
export function cleanCustomMaterialName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  return name.length > 0 && name.length <= CUSTOM_MATERIAL_NAME_MAX && NAME_RE.test(name) ? name : null;
}

/** The profile slot holding a custom material's filament preset. */
export function customFilamentSlot(id: CustomMaterialId): `filament:${CustomMaterialId}` {
  return `filament:${id}`;
}

export const CUSTOM_FILAMENT_SLOTS = CUSTOM_MATERIAL_IDS.map(customFilamentSlot);

/** Which uploaded-preset slots apply on this install. Advanced mode (the owner's
 *  own printer and presets) uses every slot; any other install only the shop's
 *  own materials' filament slots — its printer and stock materials keep the
 *  profiles the installer generated. */
export function slotInScope(slot: string, advanced: boolean): boolean {
  const material = slot.startsWith("filament:") ? slot.slice("filament:".length) : null;
  if (material !== null) return (MATERIAL_IDS as readonly string[]).includes(material) && (advanced || isCustomMaterial(material));
  const real = slot === "machine" || LAYER_HEIGHTS_UM.some((um) => slot === `process:${um}`);
  return real && advanced;
}

/** OrcaSlicer's universal generic filament presets (OrcaFilamentLibrary), which
 *  fit any printer. A custom material can start from one of these and be tuned
 *  later by uploading the shop's own preset. The worker's test checks the list
 *  against the OrcaSlicer it ships. */
export const ORCA_GENERIC_FILAMENTS = [
  "Generic ABS @System",
  "Generic ASA @System",
  "Generic PC @System",
  "Generic PA @System",
  "Generic PA-CF @System",
  "Generic PPA-CF @System",
  "Generic PPA-GF @System",
  "Generic PETG @System",
  "Generic PETG-CF @System",
  "Generic PETG HF @System",
  "Generic PCTG @System",
  "Generic PLA @System",
  "Generic PLA-CF @System",
  "Generic PLA Silk @System",
  "Generic PLA Matte @System",
  "Generic PLA High Speed @System",
  "Generic TPU @System",
  "Generic PP @System",
  "Generic PP-CF @System",
  "Generic PP-GF @System",
  "Generic PE @System",
  "Generic PE-CF @System",
  "Generic HIPS @System",
  "Generic PVA @System",
  "Generic BVOH @System",
  "Generic SBS @System",
  "Generic PHA @System",
  "Generic EVA @System",
  "Generic CoPE @System",
] as const;
export type OrcaGenericFilament = (typeof ORCA_GENERIC_FILAMENTS)[number];

export function isOrcaGenericFilament(name: string): name is OrcaGenericFilament {
  return (ORCA_GENERIC_FILAMENTS as readonly string[]).includes(name);
}

/** "Generic PA-CF @System" → "Generic PA-CF". */
export function genericLabel(name: OrcaGenericFilament): string {
  return name.replace(/ @System$/, "");
}

export const DENSITY_MIN = 0.5;
export const DENSITY_MAX = 3;

/** A filament preset that starts from an OrcaSlicer generic, optionally with
 *  the real density of the shop's filament (grams are density × volume). It
 *  goes through the same upload → flatten → test slice as a preset the owner
 *  exported, so nothing about it is special once it's live. */
export function startingPreset(
  materialName: string,
  generic: OrcaGenericFilament,
  densityGcm3?: number,
): Record<string, unknown> {
  const preset: Record<string, unknown> = {
    type: "filament",
    name: `${materialName} (from ${genericLabel(generic)})`,
    inherits: generic,
    from: "User",
    instantiation: "true",
  };
  if (densityGcm3 !== undefined) {
    if (!(densityGcm3 >= DENSITY_MIN && densityGcm3 <= DENSITY_MAX)) {
      throw new RangeError(`Density must be between ${DENSITY_MIN} and ${DENSITY_MAX} g/cm³`);
    }
    preset.filament_density = [densityGcm3.toFixed(2)];
  }
  return preset;
}
