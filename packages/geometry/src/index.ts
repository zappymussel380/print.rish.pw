import { parseAmf } from "./amf";
import { parseObj } from "./obj";
import { parseStl } from "./stl";
import { parse3mf } from "./threemf";
import { ModelParseError, type ParsedModel } from "./types";

export { looksLikeAsciiStl, looksLikeBinaryStl } from "./stl";
export { isZip } from "./zip";
export { MAX_TRIANGLES, ModelParseError } from "./types";
export type { ParsedModel } from "./types";

/** Parse an uploaded model file into a triangle soup + bbox + volume. */
export function parseModel(buf: Buffer, format: string): ParsedModel {
  switch (format) {
    case "stl":
      return parseStl(buf);
    case "obj":
      return parseObj(buf);
    case "3mf":
      return parse3mf(buf);
    case "amf":
      return parseAmf(buf);
    default:
      throw new ModelParseError(`Unsupported format: ${format}`, "UNSUPPORTED_FORMAT");
  }
}
