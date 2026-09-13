import { z } from "zod";
import { MATERIAL_IDS, type MaterialId } from "./quote-types";

/**
 * Admin-defined colours, created in the catalog editor with a hex picker. They
 * extend a material's palette at runtime — ABS and ASA have no supplier
 * palette at all, so every colour they offer is one of these. Stored inside the
 * catalog availability blob (see `catalog-availability.ts`), so a colour and
 * its enabled flag are always saved together.
 */
export interface CustomColour {
  /** `custom-<material>-<slug>`: can never collide with a palette id. */
  id: string;
  name: string;
  /** `#RRGGBB`, upper-case. */
  hex: string;
  /** A custom colour belongs to one material: ABS black and PLA black are
   *  different spools with their own stock. */
  material: MaterialId;
}

export const MAX_CUSTOM_COLOURS = 200;
export const CUSTOM_COLOUR_NAME_MAX = 40;
export const CUSTOM_COLOUR_PREFIX = "custom-";
/** Section heading for custom colours in a material that also has palette colours. */
export const CUSTOM_COLOUR_GROUP = "Custom";

export const HEX_COLOUR_RE = /^#[0-9a-fA-F]{6}$/;
const CUSTOM_ID_RE = /^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const customColourSchema = z.object({
  id: z.string().max(64).regex(CUSTOM_ID_RE),
  name: z.string().trim().min(1).max(CUSTOM_COLOUR_NAME_MAX),
  hex: z.string().regex(HEX_COLOUR_RE),
  material: z.enum(MATERIAL_IDS),
});

export function isCustomColourId(id: string): boolean {
  return id.startsWith(CUSTOM_COLOUR_PREFIX);
}

/** Harden a stored/submitted list: drop invalid entries and duplicate ids,
 *  normalise the hex, and cap the length. Never throws. */
export function normalizeCustomColours(raw: unknown): CustomColour[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CustomColour[] = [];
  for (const entry of raw) {
    const parsed = customColourSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    out.push({ ...parsed.data, hex: parsed.data.hex.toUpperCase() });
    if (out.length >= MAX_CUSTOM_COLOURS) break;
  }
  return out;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

/** A fresh id for a new custom colour, unique against `taken`. The name only
 *  seeds it for readability; renaming a colour later keeps its id. */
export function newCustomColourId(
  material: MaterialId,
  name: string,
  taken: Iterable<string>,
): string {
  const used = new Set(taken);
  const base = `${CUSTOM_COLOUR_PREFIX}${material.toLowerCase().replace(/_/g, "-")}-${slug(name) || "colour"}`;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
