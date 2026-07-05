import { ModelParseError, type ParsedModel } from "./types";

/** Compute bbox + volume from a triangle soup and assemble the result. */
export function finalizeModel(positions: Float32Array): ParsedModel {
  if (positions.length === 0 || positions.length % 9 !== 0) {
    throw new ModelParseError("Model contains no complete triangles", "EMPTY");
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let signedVolume = 0;

  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i]!;
    const ay = positions[i + 1]!;
    const az = positions[i + 2]!;
    const bx = positions[i + 3]!;
    const by = positions[i + 4]!;
    const bz = positions[i + 5]!;
    const cx = positions[i + 6]!;
    const cy = positions[i + 7]!;
    const cz = positions[i + 8]!;

    minX = Math.min(minX, ax, bx, cx);
    minY = Math.min(minY, ay, by, cy);
    minZ = Math.min(minZ, az, bz, cz);
    maxX = Math.max(maxX, ax, bx, cx);
    maxY = Math.max(maxY, ay, by, cy);
    maxZ = Math.max(maxZ, az, bz, cz);

    // Signed volume of tetrahedron (origin, a, b, c).
    signedVolume +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }

  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) {
    throw new ModelParseError("Model contains non-finite coordinates");
  }

  return {
    positions,
    triangleCount: positions.length / 9,
    bboxMm: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    // mm³ → cm³
    volumeCm3: Math.abs(signedVolume) / 1000,
  };
}
