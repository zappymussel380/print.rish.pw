import type { MaterialId } from "./quote-types";

/**
 * Plain-language comparison copy for the /materials page, one entry per
 * material tier. Which tiers the page shows (and in what order) is the shop's
 * choice — `SiteProfile.materialsPage`.
 */
export interface MaterialGuideEntry {
  /** What the material is, under its name ("Polylactic acid"). */
  subtitle: string;
  strength: string;
  flexibility: string;
  temperature: string;
  uv: string;
  printQuality: string;
  bestFor: string;
}

export const MATERIAL_GUIDE_ROWS: { key: keyof Omit<MaterialGuideEntry, "subtitle">; label: string }[] = [
  { key: "strength", label: "Strength" },
  { key: "flexibility", label: "Flexibility" },
  { key: "temperature", label: "Temperature resistance" },
  { key: "uv", label: "UV / outdoor resistance" },
  { key: "printQuality", label: "Print quality" },
  { key: "bestFor", label: "Best for" },
];

export const MATERIAL_GUIDE: Record<MaterialId, MaterialGuideEntry> = {
  PLA: {
    subtitle: "Polylactic acid",
    strength: "Stiff and strong in static loads; can be brittle under impact.",
    flexibility: "Low — snaps rather than bends.",
    temperature: "Softens around 55–60 °C. Keep out of parked cars and direct sun.",
    uv: "Degrades and fades with prolonged sun exposure.",
    printQuality: "Excellent — sharp corners, clean overhangs, the best-looking surface finish.",
    bestFor: "Prototypes, figurines, architectural models, jigs, indoor decorative parts.",
  },
  PLA_AESTHETIC: {
    subtitle: "Silk, matte, metallic and specialty PLA",
    strength: "As plain PLA; silk and glow blends are slightly more brittle.",
    flexibility: "Low — snaps rather than bends.",
    temperature: "Softens around 55–60 °C, like all PLA.",
    uv: "Fades with prolonged sun exposure; best kept indoors.",
    printQuality: "The showpiece finishes — silk sheen, matte, metallic, stone, glow and wood effects.",
    bestFor: "Display pieces, gifts, cosplay props, vases and anything that has to look the part.",
  },
  PLA_CF: {
    subtitle: "Carbon-fibre-filled PLA",
    strength: "Noticeably stiffer than PLA and dimensionally very stable.",
    flexibility: "Very low — rigid by design.",
    temperature: "Softens around 55–60 °C, like all PLA.",
    uv: "Better than plain PLA thanks to the fibre, but still an indoor material.",
    printQuality: "Crisp, even matte finish that hides layer lines well.",
    bestFor: "Jigs, fixtures, drone and RC parts, brackets that must not flex.",
  },
  PETG: {
    subtitle: "Glycol-modified PET",
    strength: "Slightly less stiff but much tougher — absorbs impacts without cracking.",
    flexibility: "Moderate — flexes and springs back, good for clips and snap-fits.",
    temperature: "Comfortable up to ~75–80 °C. Fine for warm environments and enclosures.",
    uv: "Good UV and moisture resistance — the default for outdoor parts.",
    printQuality: "Very good, slightly glossier; fine details are a touch softer than PLA.",
    bestFor: "Functional parts, brackets, enclosures, planters, anything outdoors or load-bearing.",
  },
  PETG_PREMIUM: {
    subtitle: "Translucent and carbon-fibre PETG",
    strength: "PETG toughness; the carbon-fibre blend adds stiffness.",
    flexibility: "Moderate for translucent, low for carbon fibre.",
    temperature: "Comfortable up to ~75–80 °C.",
    uv: "Good UV and moisture resistance.",
    printQuality: "Glassy translucent colours, or a fine matte carbon finish.",
    bestFor: "Light diffusers, lamp shades, stiff functional parts, outdoor fittings.",
  },
  ABS: {
    subtitle: "Acrylonitrile butadiene styrene",
    strength: "Tough and impact-resistant; takes knocks that would crack PLA.",
    flexibility: "Moderate — bends a little before it breaks.",
    temperature: "Holds its shape to ~95–100 °C. Fine near engines, lamps and electronics.",
    uv: "Yellows and turns brittle in strong sun; paint it or choose ASA outdoors.",
    printQuality: "Good; large flat parts can warp slightly. Sands and paints well.",
    bestFor: "Car interior parts, electronics housings, tool handles, parts that get hot.",
  },
  ASA: {
    subtitle: "Acrylonitrile styrene acrylate",
    strength: "Tough and impact-resistant, like ABS.",
    flexibility: "Moderate — bends a little before it breaks.",
    temperature: "Holds its shape to ~95–100 °C.",
    uv: "Excellent — keeps its colour and strength after years outdoors.",
    printQuality: "Good, with a slightly matte finish; large flat parts can warp slightly.",
    bestFor: "Outdoor fixtures, car exterior trim, garden and marine parts, signage.",
  },
};
