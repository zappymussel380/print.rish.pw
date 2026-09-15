/**
 * How much of a slice's filament goes into supports, read from OrcaSlicer's
 * G-code: its `; FEATURE:` comments name what the following moves print.
 * Only moves that travel in X/Y while pushing filament count, so the
 * retract/unretract pairs around travel moves don't. Handles relative (M83,
 * what the Bambu profiles use) and absolute (M82, G92 resets) extrusion.
 *
 * Measured 2026-09-14 on Orca 2.4.1, A1 PLA 0.20 mm: a 30 mm overhanging cap
 * gave 832.9 mm of support out of 1775 mm, i.e. 2.55 g of the 5.44 g —
 * against 2.52 g more than the same part sliced with supports off.
 */
export function supportShare(gcode: string): { supportMm: number; totalMm: number } | null {
  let support = false;
  let relative = false;
  let lastE = 0;
  let supportMm = 0;
  let totalMm = 0;
  let start = 0;
  while (start < gcode.length) {
    let end = gcode.indexOf("\n", start);
    if (end === -1) end = gcode.length;
    const line = gcode.slice(start, end);
    start = end + 1;
    const c = line.charCodeAt(0);
    if (c === 59 /* ; */) {
      const m = /^;\s*FEATURE:\s*(.*)$/.exec(line);
      if (m) support = /^support/i.test(m[1]!.trim());
      continue;
    }
    if (c !== 71 && c !== 77 /* G, M */) continue;
    if (line.startsWith("M83")) relative = true;
    else if (line.startsWith("M82")) relative = false;
    else if (line.startsWith("G92")) {
      const e = /\bE(-?\d*\.?\d+)/.exec(line);
      if (e) lastE = Number(e[1]);
    } else if (/^G[0-3]\b/.test(line)) {
      const e = /\bE(-?\d*\.?\d+)/.exec(line);
      if (!e) continue;
      const value = Number(e[1]);
      const delta = relative ? value : value - lastE;
      if (!relative) lastE = value;
      if (delta > 0 && /\b[XY]-?\d/.test(line)) {
        totalMm += delta;
        if (support) supportMm += delta;
      }
    }
  }
  return totalMm > 0 ? { supportMm, totalMm } : null;
}

/** Grams of supports, as the share of the slice's own weight (so Orca's
 *  density and flow ratio carry over), to two decimals; null when unknown. */
export function supportGramsOf(gcode: string, filamentGrams: number): number | null {
  const share = supportShare(gcode);
  if (!share) return null;
  return Math.round(((filamentGrams * share.supportMm) / share.totalMm) * 100) / 100;
}
