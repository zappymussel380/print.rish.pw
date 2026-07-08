import { encodePng } from "./png";

/** Render a triangle-soup mesh (9 floats/triangle, mm) to a shaded PNG from a
 *  fixed 3/4 view. Pure software rasteriser — no GL, no native deps — because
 *  the Orca CLI does not emit a plate thumbnail and headless-GL is fragile.
 *
 *  This runs inline on the web upload route's event loop and the parser accepts
 *  meshes up to MAX_TRIANGLES (8M), so the work is bounded two ways to keep one
 *  upload from pinning the CPU and stalling concurrent requests: `maxTriangles`
 *  stride-samples the triangles visited (bounding per-triangle setup), and an
 *  internal pixel-work budget caps total rasterisation (bounding the case of a
 *  few huge overlapping triangles that each cover the whole frame). Normal
 *  models render fully and look identical; only pathological meshes are
 *  truncated into a still-usable preview. */
export function renderThumbnail(positions: Float32Array, size: number, maxTriangles = 200_000): Buffer {
  const rgba = new Uint8Array(size * size * 4); // transparent by default
  const zbuf = new Float32Array(size * size).fill(Infinity);

  // --- view basis (Z-up world, camera above front-right) ---
  const f = normalize([-0.9, 1.15, -0.8]); // camera→scene direction
  const worldUp: Vec3 = [0, 0, 1];
  const right = normalize(cross(f, worldUp));
  const camUp = normalize(cross(right, f));
  const viewer: Vec3 = [-f[0], -f[1], -f[2]];
  const light = normalize([0.4, -0.55, 0.85]);

  // --- centre + fit scale ---
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!); maxX = Math.max(maxX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!);
    minZ = Math.min(minZ, positions[i + 2]!); maxZ = Math.max(maxZ, positions[i + 2]!);
  }
  const center: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];

  // First pass: projected extent for a snug fit.
  let maxAbs = 1e-6;
  for (let i = 0; i < positions.length; i += 3) {
    const rel: Vec3 = [positions[i]! - center[0], positions[i + 1]! - center[1], positions[i + 2]! - center[2]];
    maxAbs = Math.max(maxAbs, Math.abs(dot(rel, right)), Math.abs(dot(rel, camUp)));
  }
  const pad = size * 0.08;
  const scale = (size / 2 - pad) / maxAbs;
  const cx = size / 2;
  const cy = size / 2;

  const project = (i: number): [number, number, number, number, number, number] => {
    const rel: Vec3 = [positions[i]! - center[0], positions[i + 1]! - center[1], positions[i + 2]! - center[2]];
    const sx = dot(rel, right);
    const sy = dot(rel, camUp);
    const depth = dot(rel, f); // larger = farther
    return [cx + sx * scale, cy - sy * scale, depth, rel[0], rel[1], rel[2]];
  };

  const base: Vec3 = [205, 209, 214];

  // Two independent bounds keep this cheap regardless of the mesh:
  //  1. Stride-sample so at most `maxTriangles` triangles are visited — bounds
  //     per-triangle setup (project + normal + shading).
  //  2. A total pixel-work budget — a triangle budget alone does NOT bound
  //     rasterisation, since a few huge overlapping triangles can each cover the
  //     whole frame. We charge every triangle its bounding-box area and stop
  //     once the budget is spent. Normal models finish far under it; only
  //     pathological overdraw is truncated, into a still-usable preview.
  // (The bbox + extent passes above scan the full mesh, but those are cheap
  //  min/max with no inner pixel loop, so framing stays correct.)
  const triCount = (positions.length / 9) | 0;
  const stride = triCount > maxTriangles ? Math.ceil(triCount / maxTriangles) : 1;
  let pixelBudget = size * size * 16;
  for (let ti = 0; ti < triCount; ti += stride) {
    const t = ti * 9;
    const A = project(t);
    const B = project(t + 3);
    const C = project(t + 6);

    // Flat normal from world-space vertices.
    const ab: Vec3 = [positions[t + 3]! - positions[t]!, positions[t + 4]! - positions[t + 1]!, positions[t + 5]! - positions[t + 2]!];
    const ac: Vec3 = [positions[t + 6]! - positions[t]!, positions[t + 7]! - positions[t + 1]!, positions[t + 8]! - positions[t + 2]!];
    let n = cross(ab, ac);
    const nl = Math.hypot(n[0], n[1], n[2]);
    if (nl < 1e-12) continue;
    n = [n[0] / nl, n[1] / nl, n[2] / nl];
    if (dot(n, viewer) < 0) n = [-n[0], -n[1], -n[2]];

    const intensity = 0.34 + 0.66 * Math.max(0, dot(n, light));
    const r = Math.min(255, base[0] * intensity);
    const g = Math.min(255, base[1] * intensity);
    const b = Math.min(255, base[2] * intensity);

    pixelBudget -= rasterize(rgba, zbuf, size, A, B, C, r, g, b);
    if (pixelBudget <= 0) break;
  }

  return encodePng(rgba, size, size);
}

/** Fill one triangle; returns the number of pixels tested (its clamped bounding
 *  box area) so the caller can charge it against a global pixel-work budget. */
function rasterize(
  rgba: Uint8Array,
  zbuf: Float32Array,
  size: number,
  A: number[],
  B: number[],
  C: number[],
  r: number,
  g: number,
  b: number,
): number {
  const [ax, ay, az] = A as [number, number, number];
  const [bx, by, bz] = B as [number, number, number];
  const [cx2, cy2, cz] = C as [number, number, number];

  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx2)));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx2)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy2)));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy2)));
  if (minX > maxX || minY > maxY) return 0;

  const area = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax);
  if (Math.abs(area) < 1e-9) return 0;
  const invArea = 1 / area;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((bx - px) * (cy2 - py) - (by - py) * (cx2 - px)) * invArea;
      const w1 = ((cx2 - px) * (ay - py) - (cy2 - py) * (ax - px)) * invArea;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;

      const depth = w0 * az + w1 * bz + w2 * cz;
      const idx = y * size + x;
      if (depth >= zbuf[idx]!) continue;
      zbuf[idx] = depth;
      const o = idx * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    }
  }
  return (maxX - minX + 1) * (maxY - minY + 1);
}

type Vec3 = [number, number, number];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
