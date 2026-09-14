import { z } from "zod";
import { MATERIAL_IDS } from "./quote-types";
import { CUSTOM_COLOUR_NAME_MAX, CUSTOM_ID_RE, HEX_COLOUR_RE, MAX_CUSTOM_COLOURS, type CustomColour } from "./custom-colours";

export const customColourSchema = z.object({
  id: z.string().max(64).regex(CUSTOM_ID_RE),
  name: z.string().trim().min(1).max(CUSTOM_COLOUR_NAME_MAX),
  hex: z.string().regex(HEX_COLOUR_RE),
  material: z.enum(MATERIAL_IDS),
});

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
