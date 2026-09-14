import type { SupportMode } from "./quote-types";

// Zod-free: the quote card uses it too.

/**
 * What the slicer did about supports, in words. Under Auto, OrcaSlicer adds
 * supports only where an overhang needs them, so the same setting can mean a
 * part printed with some or with none — and supports are filament the customer
 * pays for. `supportGrams` is what the slice measured (from the G-code); null
 * for slices made before it was measured.
 */
export function supportsSummary(
  mode: SupportMode,
  supportGrams: number | null | undefined,
): { label: string; detail: string } {
  const grams = supportGrams == null ? null : Math.round(supportGrams * 10) / 10;
  if (mode === "off") return { label: "Off", detail: "Off — printed without supports" };
  if (mode === "always") {
    return grams && grams > 0
      ? { label: `On (${grams} g)`, detail: `On everywhere — ${grams} g of supports` }
      : { label: "On", detail: "On everywhere" };
  }
  if (grams == null) return { label: "Auto", detail: "Auto (added where an overhang needs them)" };
  return grams > 0
    ? { label: `Auto, added (${grams} g)`, detail: `Auto — added by the slicer (${grams} g of supports)` }
    : { label: "Auto, none needed", detail: "Auto — none needed for this part" };
}
