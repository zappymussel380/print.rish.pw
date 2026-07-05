import { finalizeModel } from "./math";
import { MAX_TRIANGLES, ModelParseError, type ParsedModel } from "./types";

const BINARY_HEADER_BYTES = 84;
const BYTES_PER_TRIANGLE = 50;

export function looksLikeBinaryStl(buf: Buffer): boolean {
  if (buf.length < BINARY_HEADER_BYTES) return false;
  const declared = buf.readUInt32LE(80);
  return buf.length === BINARY_HEADER_BYTES + declared * BYTES_PER_TRIANGLE;
}

export function looksLikeAsciiStl(buf: Buffer): boolean {
  const head = buf.subarray(0, 512).toString("latin1").trimStart().toLowerCase();
  return head.startsWith("solid") && buf.toString("latin1").includes("facet");
}

export function parseStl(buf: Buffer): ParsedModel {
  if (looksLikeBinaryStl(buf)) return parseBinaryStl(buf);
  if (looksLikeAsciiStl(buf)) return parseAsciiStl(buf);
  // Some exporters write binary STLs starting with "solid" but with a correct
  // triangle-count header; binary check above already handles those. Anything
  // else is malformed.
  throw new ModelParseError("Not a valid STL file (neither binary nor ASCII structure matches)");
}

function parseBinaryStl(buf: Buffer): ParsedModel {
  const count = buf.readUInt32LE(80);
  if (count === 0) throw new ModelParseError("STL contains no triangles", "EMPTY");
  if (count > MAX_TRIANGLES) {
    throw new ModelParseError(`STL exceeds ${MAX_TRIANGLES} triangles`, "TOO_MANY_TRIANGLES");
  }
  const positions = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    // Skip the 12-byte normal; read 9 vertex floats.
    const base = BINARY_HEADER_BYTES + t * BYTES_PER_TRIANGLE + 12;
    for (let f = 0; f < 9; f++) {
      positions[t * 9 + f] = buf.readFloatLE(base + f * 4);
    }
  }
  return finalizeModel(positions);
}

function parseAsciiStl(buf: Buffer): ParsedModel {
  const text = buf.toString("latin1");
  const vertexRe = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const coords: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = vertexRe.exec(text)) !== null) {
    coords.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (coords.length > MAX_TRIANGLES * 9) {
      throw new ModelParseError(`STL exceeds ${MAX_TRIANGLES} triangles`, "TOO_MANY_TRIANGLES");
    }
  }
  // Drop a trailing partial facet if the file is truncated.
  const usable = coords.length - (coords.length % 9);
  if (usable === 0) throw new ModelParseError("ASCII STL contains no triangles", "EMPTY");
  return finalizeModel(new Float32Array(coords.slice(0, usable)));
}
