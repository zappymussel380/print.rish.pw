import type { Document, Element } from "@xmldom/xmldom";
import { finalizeModel } from "./math";
import { MAX_TRIANGLES, ModelParseError, type ParsedModel } from "./types";
import { parseXml } from "./xml";
import { extractZipEntry, isZip } from "./zip";

/**
 * 3MF parser: unzips 3D/3dmodel.model and reads mesh vertices/triangles.
 * Handles multiple <object> meshes and <item> transforms (row-major 4x3
 * matrices per the 3MF core spec). Component references are resolved one
 * level deep, which covers slicer-exported files.
 */
export function parse3mf(buf: Buffer): ParsedModel {
  if (!isZip(buf)) throw new ModelParseError("Not a 3MF file (missing zip signature)");
  const modelXml = extractZipEntry(buf, (name) => name.toLowerCase().endsWith("3dmodel.model"));
  if (!modelXml) throw new ModelParseError("3MF is missing 3D/3dmodel.model");

  const doc = parseXml(modelXml.toString("utf8"), "3MF model");
  const root = doc.documentElement;
  if (!root) throw new ModelParseError("3MF model has no root element");
  const meshesById = new Map<string, Float32Array>();
  const componentRefs = new Map<string, { id: string; transform: number[] | null }[]>();

  for (const object of elements(root, "object")) {
    const id = object.getAttribute("id") ?? "";
    const mesh = firstElement(object, "mesh");
    if (mesh) {
      meshesById.set(id, meshToTriangles(mesh));
      continue;
    }
    const components = firstElement(object, "components");
    if (components) {
      componentRefs.set(
        id,
        elements(components, "component").map((c) => ({
          id: c.getAttribute("objectid") ?? "",
          transform: parseTransform(c.getAttribute("transform")),
        })),
      );
    }
  }

  if (meshesById.size === 0) throw new ModelParseError("3MF contains no mesh geometry", "EMPTY");

  const build = firstElement(root, "build");
  const parts: Float32Array[] = [];

  const items = build ? elements(build, "item") : [];
  if (items.length === 0) {
    // No build section — take every mesh as-is.
    parts.push(...meshesById.values());
  } else {
    for (const item of items) {
      const objectId = item.getAttribute("objectid") ?? "";
      const itemTransform = parseTransform(item.getAttribute("transform"));
      for (const { meshId, transform } of resolveObject(objectId, componentRefs)) {
        const mesh = meshesById.get(meshId);
        if (!mesh) continue;
        parts.push(applyTransform(mesh, combine(transform, itemTransform)));
      }
    }
  }

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  if (total / 9 > MAX_TRIANGLES) {
    throw new ModelParseError(`3MF exceeds ${MAX_TRIANGLES} triangles`, "TOO_MANY_TRIANGLES");
  }
  const positions = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    positions.set(p, offset);
    offset += p.length;
  }
  return finalizeModel(positions);
}

function resolveObject(
  id: string,
  componentRefs: Map<string, { id: string; transform: number[] | null }[]>,
): { meshId: string; transform: number[] | null }[] {
  const refs = componentRefs.get(id);
  if (!refs) return [{ meshId: id, transform: null }];
  return refs.map((ref) => ({ meshId: ref.id, transform: ref.transform }));
}

function meshToTriangles(mesh: Element): Float32Array {
  const verticesEl = firstElement(mesh, "vertices");
  const trianglesEl = firstElement(mesh, "triangles");
  if (!verticesEl || !trianglesEl) throw new ModelParseError("3MF mesh missing vertices/triangles");

  const verts: number[] = [];
  for (const v of elements(verticesEl, "vertex")) {
    verts.push(
      Number(v.getAttribute("x")),
      Number(v.getAttribute("y")),
      Number(v.getAttribute("z")),
    );
  }
  const tris = elements(trianglesEl, "triangle");
  if (tris.length > MAX_TRIANGLES) {
    throw new ModelParseError(`3MF exceeds ${MAX_TRIANGLES} triangles`, "TOO_MANY_TRIANGLES");
  }
  const positions = new Float32Array(tris.length * 9);
  const vertexCount = verts.length / 3;
  tris.forEach((t, i) => {
    (["v1", "v2", "v3"] as const).forEach((attr, j) => {
      const idx = Number(t.getAttribute(attr));
      if (!Number.isInteger(idx) || idx < 0 || idx >= vertexCount) {
        throw new ModelParseError("3MF triangle references a missing vertex");
      }
      positions[i * 9 + j * 3] = verts[idx * 3]!;
      positions[i * 9 + j * 3 + 1] = verts[idx * 3 + 1]!;
      positions[i * 9 + j * 3 + 2] = verts[idx * 3 + 2]!;
    });
  });
  return positions;
}

/** 3MF transform: 12 space-separated numbers, row-major 4×3. */
function parseTransform(attr: string | null): number[] | null {
  if (!attr) return null;
  const nums = attr.trim().split(/\s+/).map(Number);
  return nums.length === 12 && nums.every(Number.isFinite) ? nums : null;
}

function combine(a: number[] | null, b: number[] | null): number[] | null {
  if (!a) return b;
  if (!b) return a;
  // c = a then b (both 4×3 affine, row-vector convention).
  const c = new Array<number>(12);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      c[row * 3 + col] =
        a[row * 3]! * b[col]! +
        a[row * 3 + 1]! * b[3 + col]! +
        a[row * 3 + 2]! * b[6 + col]! +
        (row === 3 ? b[9 + col]! : 0);
    }
  }
  return c;
}

function applyTransform(positions: Float32Array, m: number[] | null): Float32Array {
  if (!m) return positions;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    out[i] = x * m[0]! + y * m[3]! + z * m[6]! + m[9]!;
    out[i + 1] = x * m[1]! + y * m[4]! + z * m[7]! + m[10]!;
    out[i + 2] = x * m[2]! + y * m[5]! + z * m[8]! + m[11]!;
  }
  return out;
}

// --- tiny DOM helpers (xmldom lacks querySelector) ---
function elements(parent: Element | Document, localName: string): Element[] {
  const result: Element[] = [];
  const all = ("getElementsByTagName" in parent ? parent : (parent as Document)).getElementsByTagName(
    "*",
  );
  for (let i = 0; i < all.length; i++) {
    const el = all[i]!;
    if (el.localName === localName) result.push(el as unknown as Element);
  }
  return result;
}

function firstElement(parent: Element, localName: string): Element | null {
  return elements(parent, localName)[0] ?? null;
}
