import type { BoundingBoxMm, ColourId, MaterialId } from "./quote-types";
import { MATERIAL_COLOURS } from "./colours";

/**
 * Business configuration: printers, materials, rates.
 *
 * The pricing engine takes a catalog as a parameter, so replacing this
 * constant with a database-backed catalog later requires no engine changes.
 * All money is integer paise (₹1 = 100 paise).
 */

export interface MaterialSpec {
  name: string;
  /** Customer-facing selling rate per gram of filament used. */
  sellPerGramPaise: number;
  /** Internal filament cost per kilogram — informational, never billed on top. */
  costPerKgPaise: number;
  densityGcm3: number;
  colours: readonly ColourId[];
}

export interface PrinterSpec {
  name: string;
  nozzleMm: number;
  /** Printable envelope in millimetres. */
  bedMm: readonly [number, number, number];
  /** Average power draw while printing, in kWh per hour of print time. */
  kwhPerHour: number;
  /** Can switch filaments mid-print (AMS/MMU/toolchanger). Absent = single filament. */
  multiMaterial?: boolean;
}

export interface Catalog {
  currency: "INR";
  /** One-time fee per order, regardless of file count. */
  setupFeePaise: number;
  printers: Record<string, PrinterSpec>;
  defaultPrinterId: string;
  materials: Record<MaterialId, MaterialSpec>;
  /** Internal electricity rate — informational component of the breakdown. */
  electricityPerKwhPaise: number;
  /** Internal maintenance allocation — informational component of the breakdown. */
  maintenancePerGramPaise: number;
  leadTime: {
    /** Effective printing hours available per calendar day. */
    printHoursPerDay: number;
    /** Days added on top of raw print time for prep, cooling, QC, packing. */
    bufferDays: number;
  };
}

export const CATALOG: Catalog = {
  currency: "INR",
  setupFeePaise: 150_00,
  printers: {
    "bbl-a1": {
      name: "Bambu Lab A1",
      nozzleMm: 0.4,
      bedMm: [256, 256, 256],
      kwhPerHour: 0.09,
    },
  },
  defaultPrinterId: "bbl-a1",
  // Densities match filament_density in each tier's Numakers slicer profile
  // (apps/worker/profiles/filament.*.json). Informational only: the billed grams
  // come from the slicer, which scales them by density × flow ratio.
  materials: {
    PLA: {
      name: "PLA",
      sellPerGramPaise: 200,
      costPerKgPaise: 600_00,
      densityGcm3: 1.26,
      colours: MATERIAL_COLOURS.PLA,
    },
    // Matte, silk, dual/tri-colour silk, metallic, stone, starlight, glow, wood.
    PLA_AESTHETIC: {
      name: "Aesthetic PLA",
      sellPerGramPaise: 300,
      costPerKgPaise: 750_00,
      densityGcm3: 1.32,
      colours: MATERIAL_COLOURS.PLA_AESTHETIC,
    },
    PLA_CF: {
      name: "PLA-CF",
      sellPerGramPaise: 350,
      costPerKgPaise: 1499_00,
      densityGcm3: 1.22,
      colours: MATERIAL_COLOURS.PLA_CF,
    },
    PETG: {
      name: "PETG",
      sellPerGramPaise: 250,
      costPerKgPaise: 800_00,
      densityGcm3: 1.28,
      colours: MATERIAL_COLOURS.PETG,
    },
    // Translucent (incl. glitter) and carbon-fibre PETG.
    PETG_PREMIUM: {
      name: "PETG Premium",
      sellPerGramPaise: 350,
      costPerKgPaise: 1149_00,
      densityGcm3: 1.25,
      colours: MATERIAL_COLOURS.PETG_PREMIUM,
    },
    // ABS and ASA have no supplier palette — their colours are admin-defined
    // (hex picker). Sliced with Orca's generic A1 presets; both ship disabled.
    ABS: {
      name: "ABS",
      sellPerGramPaise: 250,
      costPerKgPaise: 650_00,
      densityGcm3: 1.04,
      colours: MATERIAL_COLOURS.ABS,
    },
    ASA: {
      name: "ASA",
      sellPerGramPaise: 300,
      costPerKgPaise: 900_00,
      densityGcm3: 1.04,
      colours: MATERIAL_COLOURS.ASA,
    },
  },
  electricityPerKwhPaise: 10_00,
  maintenancePerGramPaise: 20,
  leadTime: {
    printHoursPerDay: 8,
    bufferDays: 2,
  },
};

/** Customer-facing name for a material id ("PLA_AESTHETIC" → "Aesthetic PLA").
 *  Unknown values (never expected) fall through verbatim. */
export function materialName(id: string): string {
  return id in CATALOG.materials ? CATALOG.materials[id as MaterialId].name : id;
}

/** The base polymer a material tier is made of. Tiers of one family share its
 *  handling (print temperatures, reported weight splits, 3MF import). */
export type MaterialFamily = "PLA" | "PETG" | "ABS" | "ASA";

export const MATERIAL_FAMILY: Record<MaterialId, MaterialFamily> = {
  PLA: "PLA",
  PLA_AESTHETIC: "PLA",
  PLA_CF: "PLA",
  PETG: "PETG",
  PETG_PREMIUM: "PETG",
  ABS: "ABS",
  ASA: "ASA",
};

export function materialFamily(id: MaterialId): MaterialFamily {
  return MATERIAL_FAMILY[id];
}

/** True when the bounding box fits the default printer's bed in some axis
 * permutation (models can be rotated at print time). */
export function fitsBed(bboxMm: BoundingBoxMm): boolean {
  const bed = CATALOG.printers[CATALOG.defaultPrinterId]!.bedMm;
  const dims = [bboxMm.x, bboxMm.y, bboxMm.z].sort((a, b) => a - b);
  const bedSorted = [...bed].sort((a, b) => a - b);
  return dims.every((d, i) => d <= bedSorted[i]!);
}

/** Below this longest-side length an FDM model has no printable geometry at
 * all — the slicer fails on it regardless of settings. */
export const MIN_PRINTABLE_DIMENSION_MM = 3;
/** A model smaller than this in every direction while carrying sculpt-level
 * triangle counts is a detailed figurine exported at the wrong unit scale
 * (desktop slicers silently offer to rescale these; a CLI slicer cannot). */
export const WRONG_SCALE_MAX_DIMENSION_MM = 20;
export const WRONG_SCALE_TRIANGLE_COUNT = 100_000;

/** True when the model is either physically unprintable or overwhelmingly
 * likely to be a wrong-scale export. Calibrated against real rejects: every
 * such file failed the slicer, while a plain 33 mm/467k-triangle part passed. */
export function looksWrongScale(bboxMm: BoundingBoxMm, triangleCount: number): boolean {
  const maxDim = Math.max(bboxMm.x, bboxMm.y, bboxMm.z);
  if (maxDim < MIN_PRINTABLE_DIMENSION_MM) return true;
  return maxDim < WRONG_SCALE_MAX_DIMENSION_MM && triangleCount > WRONG_SCALE_TRIANGLE_COUNT;
}
