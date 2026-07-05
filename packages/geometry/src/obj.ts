import { finalizeModel } from "./math";
import { MAX_TRIANGLES, ModelParseError, type ParsedModel } from "./types";

/** Minimal OBJ parser: `v` and `f` records only (geometry is all a quote
 *  needs). Faces with more than three vertices are fan-triangulated; negative
 *  indices are resolved per spec. */
export function parseObj(buf: Buffer): ParsedModel {
  const text = buf.toString("utf8");
  const vertices: number[] = [];
  const triangles: number[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("v ")) {
      const parts = line.slice(2).trim().split(/\s+/, 3);
      if (parts.length < 3) throw new ModelParseError("OBJ vertex with fewer than 3 coordinates");
      vertices.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
    } else if (line.startsWith("f ")) {
      const refs = line
        .slice(2)
        .trim()
        .split(/\s+/)
        .map((token) => {
          // "v", "v/vt", "v//vn", "v/vt/vn" — the first field is the vertex index.
          const idx = Number(token.split("/")[0]);
          if (!Number.isInteger(idx) || idx === 0) {
            throw new ModelParseError(`OBJ face has invalid vertex reference "${token}"`);
          }
          return idx;
        });
      if (refs.length < 3) continue;
      for (let i = 1; i + 1 < refs.length; i++) {
        triangles.push(refs[0]!, refs[i]!, refs[i + 1]!);
      }
      if (triangles.length / 3 > MAX_TRIANGLES) {
        throw new ModelParseError(`OBJ exceeds ${MAX_TRIANGLES} triangles`, "TOO_MANY_TRIANGLES");
      }
    }
  }

  if (triangles.length === 0) throw new ModelParseError("OBJ contains no faces", "EMPTY");
  const vertexCount = vertices.length / 3;
  const positions = new Float32Array(triangles.length * 3);

  for (let i = 0; i < triangles.length; i++) {
    let idx = triangles[i]!;
    idx = idx > 0 ? idx - 1 : vertexCount + idx;
    if (idx < 0 || idx >= vertexCount) {
      throw new ModelParseError("OBJ face references a missing vertex");
    }
    positions[i * 3] = vertices[idx * 3]!;
    positions[i * 3 + 1] = vertices[idx * 3 + 1]!;
    positions[i * 3 + 2] = vertices[idx * 3 + 2]!;
  }

  return finalizeModel(positions);
}
