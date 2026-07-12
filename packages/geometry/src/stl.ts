import { finalizeModel } from "./math";
import {
  MAX_TEXT_MODEL_BYTES,
  MAX_TRIANGLES,
  ModelParseError,
  type ParsedModel,
} from "./types";

const BINARY_HEADER_BYTES = 84;
const BYTES_PER_TRIANGLE = 50;

export function looksLikeBinaryStl(buf: Buffer): boolean {
  if (buf.length < BINARY_HEADER_BYTES) return false;
  const declared = buf.readUInt32LE(80);
  return buf.length === BINARY_HEADER_BYTES + declared * BYTES_PER_TRIANGLE;
}

export function looksLikeAsciiStl(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(buf.length, 64 * 1024)).toString("latin1").toLowerCase();
  return head.trimStart().startsWith("solid") && head.includes("facet");
}

export function parseStl(buf: Buffer): ParsedModel {
  if (looksLikeBinaryStl(buf)) return parseBinaryStl(buf);
  if (looksLikeAsciiStl(buf)) return parseAsciiStl(buf);
  // Some exporters write binary STLs starting with "solid" but with a correct
  // triangle-count header; binary check above already handles those. Anything
  // else is malformed.
  throw new ModelParseError("Not a valid STL file (neither binary nor ASCII structure matches)");
}

export function serializeBinaryStl(positions: Float32Array, name = "model"): Buffer {
  if (positions.length === 0 || positions.length % 9 !== 0) {
    throw new ModelParseError("Model contains no complete triangles", "EMPTY");
  }
  const count = positions.length / 9;
  if (count > MAX_TRIANGLES) {
    throw new ModelParseError(`STL exceeds ${MAX_TRIANGLES} triangles`, "TOO_MANY_TRIANGLES");
  }

  const buf = Buffer.alloc(BINARY_HEADER_BYTES + count * BYTES_PER_TRIANGLE);
  buf.write(name.slice(0, 80), 0, "ascii");
  buf.writeUInt32LE(count, 80);

  for (let t = 0; t < count; t++) {
    const src = t * 9;
    const dst = BINARY_HEADER_BYTES + t * BYTES_PER_TRIANGLE;
    const normal = triangleNormal(positions, src);
    buf.writeFloatLE(normal[0], dst);
    buf.writeFloatLE(normal[1], dst + 4);
    buf.writeFloatLE(normal[2], dst + 8);
    for (let f = 0; f < 9; f++) {
      buf.writeFloatLE(positions[src + f]!, dst + 12 + f * 4);
    }
    buf.writeUInt16LE(0, dst + 48);
  }

  return buf;
}

function triangleNormal(positions: Float32Array, i: number): [number, number, number] {
  const ax = positions[i]!;
  const ay = positions[i + 1]!;
  const az = positions[i + 2]!;
  const bx = positions[i + 3]!;
  const by = positions[i + 4]!;
  const bz = positions[i + 5]!;
  const cx = positions[i + 6]!;
  const cy = positions[i + 7]!;
  const cz = positions[i + 8]!;

  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return len > 0 ? [nx / len, ny / len, nz / len] : [0, 0, 0];
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
  if (buf.length > MAX_TEXT_MODEL_BYTES) {
    throw new ModelParseError(
      `ASCII STL exceeds the ${MAX_TEXT_MODEL_BYTES / 1024 / 1024} MiB text-format limit`,
      "TOO_COMPLEX",
    );
  }
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
