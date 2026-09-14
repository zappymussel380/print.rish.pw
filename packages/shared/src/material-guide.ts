import { isCustomMaterial, type CustomMaterialId, type MaterialId, type StockMaterialId } from "./quote-types";
import { materialName, type CustomMaterialNames } from "./catalog";
import { DEFAULT_SITE_PROFILE } from "./site-profile";

/**
 * Plain-language comparison copy for the /materials page, one entry per
 * material tier. Which tiers the page shows (and in what order) is the shop's
 * choice — `SiteProfile.materialsPage`. The shop's own materials (OTHER_*)
 * have no copy here: the owner writes theirs in the admin dashboard (Your own
 * materials), and the page offers one once it has some — `customGuide`.
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

export const MATERIAL_GUIDE: Record<StockMaterialId, MaterialGuideEntry> = {
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

/** The owner's copy for one of their own materials. Every field is optional; a
 *  row left blank reads "Ask us about this." on the page. */
export type CustomMaterialGuide = Partial<MaterialGuideEntry>;

export const MATERIAL_GUIDE_KEYS = [
  "subtitle",
  "strength",
  "flexibility",
  "temperature",
  "uv",
  "printQuality",
  "bestFor",
] as const satisfies readonly (keyof MaterialGuideEntry)[];

export const CUSTOM_GUIDE_LIMITS = { subtitle: 80, row: 300 } as const;

export const GUIDE_BLANK_ROW = "Ask us about this.";

/** The owner's copy, tidied: trimmed, inner whitespace collapsed, blank fields
 *  dropped. Null when nothing usable is left (or a field is too long — the
 *  admin form keeps typing within the limits, so that is only a crafted save). */
export function cleanCustomGuide(raw: unknown): CustomMaterialGuide | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: CustomMaterialGuide = {};
  for (const key of MATERIAL_GUIDE_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    const text = value.replace(/\s+/g, " ").trim();
    const max = key === "subtitle" ? CUSTOM_GUIDE_LIMITS.subtitle : CUSTOM_GUIDE_LIMITS.row;
    if (text.length > max) return null;
    if (text) out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** A full guide entry for one of the shop's own materials, blanks filled. */
export function customGuideEntry(guide: CustomMaterialGuide): MaterialGuideEntry {
  const entry = { subtitle: guide.subtitle ?? "" } as MaterialGuideEntry;
  for (const { key } of MATERIAL_GUIDE_ROWS) entry[key] = guide[key] ?? GUIDE_BLANK_ROW;
  return entry;
}

/** Whether one of the shop's own materials can go on /materials: it has a name
 *  and the owner has written some copy for it. */
export function hasCustomGuide(names: CustomMaterialNames | undefined, id: CustomMaterialId): boolean {
  return Boolean(names?.[id]?.name && names[id]?.guide);
}

export interface MaterialsPageEntry {
  id: MaterialId;
  name: string;
  guide: MaterialGuideEntry;
}

/** What /materials shows: the shop's pick in its order, each with its copy.
 *  One of the shop's own materials that has since lost its name or copy is
 *  left out; if nothing is left, the default pair is shown. */
export function materialsPageEntries(pick: readonly MaterialId[], names?: CustomMaterialNames): MaterialsPageEntry[] {
  const entries = pick.flatMap((id): MaterialsPageEntry[] => {
    if (!isCustomMaterial(id)) return [{ id, name: materialName(id), guide: MATERIAL_GUIDE[id] }];
    const own = names?.[id];
    return own?.name && own.guide ? [{ id, name: own.name, guide: customGuideEntry(own.guide) }] : [];
  });
  return entries.length > 0 ? entries : materialsPageEntries(DEFAULT_SITE_PROFILE.materialsPage);
}
