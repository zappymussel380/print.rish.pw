import type { Element } from "@xmldom/xmldom";
import { finalizeModel } from "./math";
import { MAX_TRIANGLES, ModelParseError, type ParsedModel } from "./types";
import { parseXml } from "./xml";
import { extractZipEntry, isZip } from "./zip";

/** AMF units → millimetres. */
const UNIT_TO_MM: Record<string, number> = {
  millimeter: 1,
  millimetre: 1,
  inch: 25.4,
  feet: 304.8,
  meter: 1000,
  metre: 1000,
  micron: 0.001,
};

/**
 * AMF parser. AMF is XML, optionally delivered inside a zip container (the
 * spec's preferred form). Reads every <mesh> under every <object>.
 */
export function parseAmf(buf: Buffer): ParsedModel {
  let xml = buf;
  if (isZip(buf)) {
    const entry = extractZipEntry(buf, (name) => name.toLowerCase().endsWith(".amf"));
    if (!entry) throw new ModelParseError("Zip container has no .amf entry");
    xml = entry;
  }

  const doc = parseXml(xml.toString("utf8"), "AMF");
  const root = doc.documentElement;
  if (!root || root.localName !== "amf") {
    throw new ModelParseError("Not an AMF file (missing <amf> root)");
  }
  const scale = UNIT_TO_MM[(root.getAttribute("unit") ?? "millimeter").toLowerCase()] ?? 1;

  const parts: Float32Array[] = [];
  let totalTriangles = 0;

  for (const mesh of byLocalName(root, "mesh")) {
    const verticesEl = byLocalName(mesh, "vertices")[0];
    if (!verticesEl) continue;
    const coords: number[] = [];
    for (const vertex of byLocalName(verticesEl, "vertex")) {
      const c = byLocalName(vertex, "coordinates")[0];
      if (!c) continue;
      coords.push(
        Number(textOf(c, "x")) * scale,
        Number(textOf(c, "y")) * scale,
        Number(textOf(c, "z")) * scale,
      );
    }
    const vertexCount = coords.length / 3;

    for (const volume of byLocalName(mesh, "volume")) {
      const tris = byLocalName(volume, "triangle");
      totalTriangles += tris.length;
      if (totalTriangles > MAX_TRIANGLES) {
        throw new ModelParseError(`AMF exceeds ${MAX_TRIANGLES} triangles`, "TOO_MANY_TRIANGLES");
      }
      const positions = new Float32Array(tris.length * 9);
      tris.forEach((t, i) => {
        (["v1", "v2", "v3"] as const).forEach((tag, j) => {
          const idx = Number(textOf(t, tag));
          if (!Number.isInteger(idx) || idx < 0 || idx >= vertexCount) {
            throw new ModelParseError("AMF triangle references a missing vertex");
          }
          positions[i * 9 + j * 3] = coords[idx * 3]!;
          positions[i * 9 + j * 3 + 1] = coords[idx * 3 + 1]!;
          positions[i * 9 + j * 3 + 2] = coords[idx * 3 + 2]!;
        });
      });
      parts.push(positions);
    }
  }

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  if (total === 0) throw new ModelParseError("AMF contains no triangles", "EMPTY");
  const positions = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    positions.set(p, offset);
    offset += p.length;
  }
  return finalizeModel(positions);
}

type XmlElement = Element;

function byLocalName(parent: XmlElement, localName: string): XmlElement[] {
  const result: XmlElement[] = [];
  const all = parent.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i]!;
    if (el.localName === localName) result.push(el as XmlElement);
  }
  return result;
}

function textOf(parent: XmlElement, localName: string): string {
  return byLocalName(parent, localName)[0]?.textContent?.trim() ?? "";
}
