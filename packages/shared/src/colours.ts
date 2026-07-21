import { MATERIAL_IDS, type ColourId, type MaterialId } from "./quote-types";

/**
 * Colour palette reference data — the supplier's (Numakers) orderable colours,
 * their display names, an approximate swatch, and which materials each colour is
 * stocked in. This is the *possible* universe; the *enabled* subset a customer
 * may pick is runtime, admin-controlled state (see `catalog-availability.ts`).
 *
 * `Record<ColourId, ColourDef>` forces every id in `COLOUR_IDS` to appear here,
 * so the tuple and this map can never silently drift.
 */
export interface ColourDef {
  name: string;
  /** Approximate hex for a UI swatch. Not a colour-accurate spec. */
  hex: string;
  /** Materials this colour is offered in. Empty = legacy/accept-only. */
  materials: readonly MaterialId[];
}

const PLA_PETG: readonly MaterialId[] = ["PLA", "PETG"];
const PLA_ONLY: readonly MaterialId[] = ["PLA"];

export const MASTER_COLOURS: Record<ColourId, ColourDef> = {
  "pitch-black": { name: "Pitch Black", hex: "#141414", materials: PLA_PETG },
  "pure-white": { name: "Pure White", hex: "#F7F7F4", materials: PLA_PETG },
  "lemon-yellow": { name: "Lemon Yellow", hex: "#F6E400", materials: PLA_PETG },
  "mauve-purple": { name: "Mauve Purple", hex: "#915F84", materials: PLA_PETG },
  "nuclear-red": { name: "Nuclear Red", hex: "#E10E1A", materials: PLA_PETG },
  "imperial-red": { name: "Imperial Red", hex: "#C41E28", materials: PLA_ONLY },
  "outrageous-orange": { name: "Outrageous Orange", hex: "#FF6A3D", materials: PLA_PETG },
  "atomic-pink": { name: "Atomic Pink", hex: "#FF3E96", materials: PLA_PETG },
  "royal-blue": { name: "Royal Blue", hex: "#2A4BA0", materials: PLA_PETG },
  "light-gray": { name: "Light Gray", hex: "#C6CACE", materials: PLA_PETG },
  "light-blue": { name: "Light Blue", hex: "#7FB6E6", materials: PLA_PETG },
  "grass-green": { name: "Grass Green", hex: "#3FA34D", materials: PLA_PETG },
  "beige-brown": { name: "Beige Brown", hex: "#A6845F", materials: PLA_ONLY },
  "teal-blue": { name: "Teal Blue", hex: "#0F8B99", materials: PLA_ONLY },
  "army-green": { name: "Army Green", hex: "#4B5320", materials: PLA_PETG },
  "dark-gray": { name: "Dark Gray", hex: "#45494E", materials: PLA_ONLY },
  "ivory-white": { name: "Ivory White", hex: "#EFE9D6", materials: PLA_ONLY },
  "rust-copper": { name: "Rust Copper", hex: "#A65E2E", materials: PLA_ONLY },
  apricot: { name: "Apricot", hex: "#F6B98A", materials: PLA_ONLY },
  "lagoon-blue": { name: "Lagoon Blue", hex: "#2BA4B8", materials: PLA_ONLY },
  "forest-green": { name: "Forest Green", hex: "#1F6B37", materials: PLA_PETG },
  "fluorescent-orange": { name: "Fluorescent Orange", hex: "#FF7A00", materials: PLA_ONLY },
  "fluorescent-green": { name: "Fluorescent Green", hex: "#5DFF3B", materials: PLA_ONLY },
  transparent: { name: "Transparent", hex: "#DCE3E8", materials: PLA_PETG },
  "bahama-yellow": { name: "Bahama Yellow", hex: "#F6C414", materials: PLA_ONLY },
  "chocolate-brown": { name: "Chocolate Brown", hex: "#5C3A22", materials: PLA_ONLY },
  "fluorescent-yellow": { name: "Fluorescent Yellow", hex: "#E4FF00", materials: PLA_ONLY },
  "lavender-violet": { name: "Lavender Violet", hex: "#9F7FD1", materials: PLA_ONLY },
  magenta: { name: "Magenta", hex: "#C724B1", materials: PLA_ONLY },
  "military-khaki": { name: "Military Khaki", hex: "#837B57", materials: PLA_ONLY },
  "ryobix-green": { name: "Ryobix Green", hex: "#7BB025", materials: PLA_ONLY },
  "simply-silver": { name: "Simply Silver", hex: "#BCC0C4", materials: PLA_PETG },
  "midnight-gray": { name: "Midnight Gray", hex: "#2E3338", materials: PLA_PETG },
  "thanos-purple": { name: "Thanos Purple", hex: "#6D3FA0", materials: PLA_PETG },
  "cool-white": { name: "Cool White", hex: "#EFF4FA", materials: PLA_ONLY },
  "bone-white": { name: "Bone White", hex: "#E4DBC7", materials: PLA_ONLY },
  "terracota-orange": { name: "Terracota Orange", hex: "#E2725B", materials: PLA_ONLY },
  "water-blue": { name: "Water Blue", hex: "#3FA9F5", materials: PLA_ONLY },
  "light-beige": { name: "Light Beige", hex: "#E7D8BC", materials: PLA_ONLY },
  // Legacy ids: rendered for old records, never offered in any material.
  black: { name: "Black", hex: "#141414", materials: [] },
  white: { name: "White", hex: "#F7F7F4", materials: [] },
};

/** The orderable colour universe per material, in palette order. */
export const MATERIAL_COLOURS: Record<MaterialId, readonly ColourId[]> = MATERIAL_IDS.reduce(
  (acc, material) => {
    acc[material] = (Object.keys(MASTER_COLOURS) as ColourId[]).filter((id) =>
      MASTER_COLOURS[id].materials.includes(material),
    );
    return acc;
  },
  {} as Record<MaterialId, ColourId[]>,
);

/** Colours enabled out of the box — the black/white that were always in stock,
 *  so behaviour is unchanged until the operator turns more colours on. */
export const DEFAULT_ENABLED_COLOURS: Record<MaterialId, readonly ColourId[]> = {
  PLA: ["pitch-black", "pure-white"],
  PETG: ["pitch-black", "pure-white"],
};

/** Human-readable name for any colour id, including legacy values. */
export function colourName(id: string): string {
  return id in MASTER_COLOURS ? MASTER_COLOURS[id as ColourId].name : id;
}
