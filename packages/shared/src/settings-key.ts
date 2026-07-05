import type { SliceSettings } from "./quote-types";

/**
 * Canonical cache key for a slice-settings combination.
 *
 * Deliberately a readable string rather than a hash: it is short, collision
 * free by construction, and debuggable in the database. Colour and quantity
 * never appear here — they do not affect slicing (see `SliceSettings`).
 */
export function settingsKey(s: SliceSettings): string {
  return `${s.material}:${s.layerHeightUm}:${s.infillPct}:${s.supports}`;
}
