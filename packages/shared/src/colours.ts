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
  /** Gradient stops for dual/tri-colour filament; `hex` is then the first. */
  stops?: readonly string[];
}

const PLA_PETG: readonly MaterialId[] = ["PLA", "PETG"];
const PLA_ONLY: readonly MaterialId[] = ["PLA"];
// Premium tiers stock their own lines, so no id is shared with the basics.
const AESTHETIC: readonly MaterialId[] = ["PLA_AESTHETIC"];
const CF_ONLY: readonly MaterialId[] = ["PLA_CF"];
const PETG_PREMIUM_ONLY: readonly MaterialId[] = ["PETG_PREMIUM"];

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
  "terracota-orange": { name: "Terracotta Orange", hex: "#E2725B", materials: PLA_ONLY },
  "water-blue": { name: "Water Blue", hex: "#3FA9F5", materials: PLA_ONLY },
  "light-beige": { name: "Light Beige", hex: "#E7D8BC", materials: PLA_ONLY },
  ivory: { name: "Ivory", hex: "#EDE3C8", materials: PLA_ONLY },
  // ── Aesthetic PLA — Matte ──
  "matte-ruby-red": { name: "Matte Ruby Red", hex: "#C10C26", materials: AESTHETIC },
  "matte-sakura-pink": { name: "Matte Sakura Pink", hex: "#FFB7C5", materials: AESTHETIC },
  "matte-skin": { name: "Matte Skin", hex: "#FBCEB1", materials: AESTHETIC },
  "matte-sunshine-yellow": { name: "Matte Sunshine Yellow", hex: "#FDFC5D", materials: AESTHETIC },
  "matte-mint-green": { name: "Matte Mint Green", hex: "#D4FFD4", materials: AESTHETIC },
  "matte-ice-blue": { name: "Matte Ice Blue", hex: "#AEFFD7", materials: AESTHETIC },
  "matte-olive-green": { name: "Matte Olive Green", hex: "#4B5E42", materials: AESTHETIC },
  "matte-navy-blue": { name: "Matte Navy Blue", hex: "#314963", materials: AESTHETIC },
  "matte-moon-gray": { name: "Matte Moon Gray", hex: "#747F8C", materials: AESTHETIC },
  "matte-lilac-purple": { name: "Matte Lilac Purple", hex: "#886FAC", materials: AESTHETIC },
  "matte-beige": { name: "Matte Beige", hex: "#B79A77", materials: AESTHETIC },
  "matte-white": { name: "Matte White", hex: "#F3F2EE", materials: AESTHETIC },
  "matte-black": { name: "Matte Black", hex: "#0D0D0D", materials: AESTHETIC },
  // ── Aesthetic PLA — Silk ──
  "silk-copper": { name: "Silk Copper", hex: "#CA7031", materials: AESTHETIC },
  "silk-orange": { name: "Silk Orange", hex: "#F28E1C", materials: AESTHETIC },
  "silk-red": { name: "Silk Red", hex: "#A4403E", materials: AESTHETIC },
  "silk-yellow": { name: "Silk Yellow", hex: "#DBDB57", materials: AESTHETIC },
  "silk-molten-gold": { name: "Silk Molten Gold", hex: "#F0C402", materials: AESTHETIC },
  "silk-antique-gold": { name: "Silk Antique Gold", hex: "#C19D3F", materials: AESTHETIC },
  "silk-mint-green": { name: "Silk Mint Green", hex: "#A1D6AA", materials: AESTHETIC },
  "silk-christmas-green": { name: "Silk Christmas Green", hex: "#3F8542", materials: AESTHETIC },
  "silk-blue": { name: "Silk Blue", hex: "#A1C9D3", materials: AESTHETIC },
  "silk-lagoon": { name: "Silk Lagoon", hex: "#28AAB7", materials: AESTHETIC },
  "silk-deep-blue": { name: "Silk Deep Blue", hex: "#1D429A", materials: AESTHETIC },
  "silk-lilac": { name: "Silk Lilac", hex: "#DEB3E8", materials: AESTHETIC },
  "silk-purple": { name: "Silk Purple", hex: "#9146AD", materials: AESTHETIC },
  "silk-pale-lavender": { name: "Silk Pale Lavender", hex: "#9D9FD8", materials: AESTHETIC },
  "silk-petal-pink": { name: "Silk Petal Pink", hex: "#E8C8BC", materials: AESTHETIC },
  "silk-pink": { name: "Silk Pink", hex: "#CD83A4", materials: AESTHETIC },
  "silk-white": { name: "Silk White", hex: "#F9FAF5", materials: AESTHETIC },
  "silk-silver": { name: "Silk Silver", hex: "#A4A9A5", materials: AESTHETIC },
  "silk-black": { name: "Silk Black", hex: "#000000", materials: AESTHETIC },
  "silk-gold": { name: "Silk Gold", hex: "#D4AF37", materials: AESTHETIC },
  "silk-enchanted-gold": { name: "Silk Enchanted Gold", hex: "#FCCC4C", materials: AESTHETIC },
  "silk-bronze": { name: "Silk Bronze", hex: "#B08D57", materials: AESTHETIC },
  "silk-molten-sol": { name: "Silk Molten Sol", hex: "#F28E1C", materials: AESTHETIC },
  "silk-forest-green": { name: "Silk Forest Green", hex: "#008351", materials: AESTHETIC },
  "silk-obsidian-night": { name: "Silk Obsidian Night", hex: "#0E0E10", materials: AESTHETIC },
  // ── Aesthetic PLA — Dual/Tri-Colour Silk ──
  "tri-copper-silver-gold": { name: "Tri Silk Copper/Silver/Gold", hex: "#CA7031", materials: AESTHETIC, stops: ["#CA7031", "#A4A9A5", "#D4AF37"] },
  "tri-blue-green-gold": { name: "Tri Silk Blue/Green/Gold", hex: "#1D429A", materials: AESTHETIC, stops: ["#1D429A", "#3F8542", "#D4AF37"] },
  "tri-black-purple-gold": { name: "Tri Silk Black/Purple/Gold", hex: "#1A1A1A", materials: AESTHETIC, stops: ["#1A1A1A", "#9146AD", "#D4AF37"] },
  "tri-black-purple-orange": { name: "Tri Silk Black/Purple/Orange", hex: "#1A1A1A", materials: AESTHETIC, stops: ["#1A1A1A", "#9146AD", "#F28E1C"] },
  "tri-silver-purple-blue": { name: "Tri Silk Silver/Purple/Blue", hex: "#A4A9A5", materials: AESTHETIC, stops: ["#A4A9A5", "#9146AD", "#1D429A"] },
  "tri-green-magenta-blue": { name: "Tri Silk Green/Magenta/Blue", hex: "#3F8542", materials: AESTHETIC, stops: ["#3F8542", "#CC3366", "#1D429A"] },
  "tri-red-yellow-blue": { name: "Tri Silk Red/Yellow/Blue", hex: "#A4403E", materials: AESTHETIC, stops: ["#A4403E", "#DBDB57", "#1D429A"] },
  "tri-red-orange-gold": { name: "Tri Silk Red/Orange/Gold", hex: "#A4403E", materials: AESTHETIC, stops: ["#A4403E", "#F28E1C", "#D4AF37"] },
  "tri-red-blue-white": { name: "Tri Silk Red/Blue/White", hex: "#A4403E", materials: AESTHETIC, stops: ["#A4403E", "#1D429A", "#F9FAF5"] },
  "dual-black-gold": { name: "Dual Silk Black/Gold", hex: "#1A1A1A", materials: AESTHETIC, stops: ["#1A1A1A", "#D4AF37"] },
  "dual-blue-magenta": { name: "Dual Silk Blue/Magenta", hex: "#1D429A", materials: AESTHETIC, stops: ["#1D429A", "#CC3366"] },
  "dual-purple-black": { name: "Dual Silk Purple/Black", hex: "#9146AD", materials: AESTHETIC, stops: ["#9146AD", "#1A1A1A"] },
  "dual-red-black": { name: "Dual Silk Red/Black", hex: "#A4403E", materials: AESTHETIC, stops: ["#A4403E", "#1A1A1A"] },
  "dual-red-gold": { name: "Dual Silk Red/Gold", hex: "#A4403E", materials: AESTHETIC, stops: ["#A4403E", "#D4AF37"] },
  // ── Aesthetic PLA — Metallic ──
  "metallic-titanium-blue": { name: "Metallic Titanium Blue", hex: "#344F7D", materials: AESTHETIC },
  "metallic-ferrous-green": { name: "Metallic Ferrous Green", hex: "#1E4F39", materials: AESTHETIC },
  "metallic-sunset-bronze": { name: "Metallic Sunset Bronze", hex: "#7A6562", materials: AESTHETIC },
  "metallic-tungsten-brown": { name: "Metallic Tungsten Brown", hex: "#543D35", materials: AESTHETIC },
  "metallic-burnished-copper": { name: "Metallic Burnished Copper", hex: "#774548", materials: AESTHETIC },
  "metallic-burnt-copper": { name: "Metallic Burnt Copper", hex: "#7D4B2C", materials: AESTHETIC },
  // ── Aesthetic PLA — Stone ──
  "stone-white": { name: "Stone White", hex: "#F3F2EE", materials: AESTHETIC },
  // ── Aesthetic PLA — Starlight ──
  "starlight-nebula": { name: "Starlight Nebula", hex: "#594177", materials: AESTHETIC },
  "starlight-comet": { name: "Starlight Comet", hex: "#3B665E", materials: AESTHETIC },
  "starlight-titan": { name: "Starlight Titan", hex: "#546B4E", materials: AESTHETIC },
  "starlight-midnight": { name: "Starlight Midnight", hex: "#424379", materials: AESTHETIC },
  "starlight-neptune": { name: "Starlight Neptune", hex: "#2C7C84", materials: AESTHETIC },
  // ── Aesthetic PLA — Glow in the Dark ──
  "glow-green": { name: "Glow Green", hex: "#009B4F", materials: AESTHETIC },
  "glow-orange": { name: "Glow Orange", hex: "#F08C2D", materials: AESTHETIC },
  "glow-pink": { name: "Glow Pink", hex: "#F17B8F", materials: AESTHETIC },
  "glow-blue": { name: "Glow Blue", hex: "#063E66", materials: AESTHETIC },
  "glow-aqua-blue": { name: "Glow Aqua Blue", hex: "#66F2DD", materials: AESTHETIC },
  // ── Aesthetic PLA — Wood ──
  "wood-natural": { name: "Wood", hex: "#B08457", materials: AESTHETIC },
  // ── PLA-CF ──
  "cf-black": { name: "Black", hex: "#141414", materials: CF_ONLY },
  "cf-wine-red": { name: "Wine Red", hex: "#80464F", materials: CF_ONLY },
  "cf-lemongrass-green": { name: "Lemongrass Green", hex: "#66875E", materials: CF_ONLY },
  "cf-denim-blue": { name: "Denim Blue", hex: "#6381A2", materials: CF_ONLY },
  // ── PETG Premium — Translucent ──
  "translucent-blue": { name: "Translucent Blue", hex: "#063E66", materials: PETG_PREMIUM_ONLY },
  "translucent-ice-blue": { name: "Translucent Ice Blue", hex: "#007CB0", materials: PETG_PREMIUM_ONLY },
  "translucent-ice-blue-glitter": { name: "Translucent Ice Blue Glitter", hex: "#007CB0", materials: PETG_PREMIUM_ONLY },
  "translucent-arctic": { name: "Translucent Arctic", hex: "#7CB7A5", materials: PETG_PREMIUM_ONLY },
  "translucent-arctic-glitter": { name: "Translucent Arctic Glitter", hex: "#7CB7A5", materials: PETG_PREMIUM_ONLY },
  "translucent-pink": { name: "Translucent Pink", hex: "#F17B8F", materials: PETG_PREMIUM_ONLY },
  "translucent-pink-glitter": { name: "Translucent Pink Glitter", hex: "#F17B8F", materials: PETG_PREMIUM_ONLY },
  "translucent-hot-pink": { name: "Translucent Hot Pink", hex: "#D12C7E", materials: PETG_PREMIUM_ONLY },
  "translucent-red": { name: "Translucent Red", hex: "#D0312D", materials: PETG_PREMIUM_ONLY },
  "translucent-orange": { name: "Translucent Orange", hex: "#F08C2D", materials: PETG_PREMIUM_ONLY },
  "translucent-orange-glitter": { name: "Translucent Orange Glitter", hex: "#F08C2D", materials: PETG_PREMIUM_ONLY },
  "translucent-green": { name: "Translucent Green", hex: "#009B4F", materials: PETG_PREMIUM_ONLY },
  "translucent-green-glitter": { name: "Translucent Green Glitter", hex: "#009B4F", materials: PETG_PREMIUM_ONLY },
  "translucent-yellow": { name: "Translucent Yellow", hex: "#FDDA76", materials: PETG_PREMIUM_ONLY },
  // ── PETG Premium — Carbon Fibre ──
  "petg-cf-black": { name: "CF Black", hex: "#141414", materials: PETG_PREMIUM_ONLY },
  "petg-cf-volcanic-rock-gray": { name: "CF Volcanic Rock Gray", hex: "#70777F", materials: PETG_PREMIUM_ONLY },
  "petg-cf-tactical-green": { name: "CF Tactical Green", hex: "#667C59", materials: PETG_PREMIUM_ONLY },
  "petg-cf-denim-blue": { name: "CF Denim Blue", hex: "#6381A2", materials: PETG_PREMIUM_ONLY },
  "petg-cf-purple": { name: "CF Purple", hex: "#655E88", materials: PETG_PREMIUM_ONLY },
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

/** Materials offered out of the box. The premium tiers ship switched OFF: the
 *  operator enables each one as the filament is actually stocked. Stored
 *  availability only overrides a material it names, so without this a blob
 *  saved before a tier existed would silently switch that tier on. */
export const DEFAULT_ENABLED_MATERIALS: Record<MaterialId, boolean> = {
  PLA: true,
  PLA_AESTHETIC: false,
  PLA_CF: false,
  PETG: true,
  PETG_PREMIUM: false,
};

/** Colours enabled out of the box — the black/white that were always in stock,
 *  so behaviour is unchanged until the operator turns more colours on. */
export const DEFAULT_ENABLED_COLOURS: Record<MaterialId, readonly ColourId[]> = {
  PLA: ["pitch-black", "pure-white"],
  PLA_AESTHETIC: [],
  PLA_CF: [],
  PETG: ["pitch-black", "pure-white"],
  PETG_PREMIUM: [],
};

/** Human-readable name for any colour id, including legacy values. */
export function colourName(id: string): string {
  return id in MASTER_COLOURS ? MASTER_COLOURS[id as ColourId].name : id;
}

/** CSS `background` for a swatch: a diagonal gradient for multi-colour
 *  filament, otherwise the flat hex. */
export function swatchBackground(c: { hex: string; stops?: readonly string[] }): string {
  return c.stops && c.stops.length > 1 ? `linear-gradient(135deg, ${c.stops.join(", ")})` : c.hex;
}
