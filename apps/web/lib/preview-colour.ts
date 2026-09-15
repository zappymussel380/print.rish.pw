/**
 * The filament colour a model preview is drawn in. Lightness is kept between
 * 22% and 88% so the shading still shows the shape: pure black would read as a
 * flat silhouette (and vanish on the dark theme), pure white as a blank tile.
 * Hue and saturation are the filament's. Returns a #rrggbb, or null when the
 * input isn't a colour (the preview then stays neutral grey).
 */
export function previewColour(hex: string | null | undefined): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const L = Math.min(0.88, Math.max(0.22, l));
  const c = (1 - Math.abs(2 * L - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const o = L - c / 2;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const out = [r1 + o, g1 + o, b1 + o].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The grey the thumbnail renderer shades (packages/geometry thumbnail.ts). */
export const THUMB_BASE = [205, 209, 214] as const;

/** Recolour the grey thumbnail's pixels in place: each pixel's brightness
 *  against the renderer's base grey becomes the shading of `hex`. */
export function tintThumbPixels(data: Uint8ClampedArray, hex: string): void {
  const n = Number.parseInt(hex.slice(1), 16);
  const tint = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const shade = Math.min(1.3, data[i]! / THUMB_BASE[0]);
    data[i] = tint[0]! * shade;
    data[i + 1] = tint[1]! * shade;
    data[i + 2] = tint[2]! * shade;
  }
}
