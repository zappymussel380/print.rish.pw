import { parseAmf } from "./amf";
import { parseObj } from "./obj";
import { parseStl } from "./stl";
import { parse3mf } from "./threemf";
import { ModelParseError, type ParsedModel } from "./types";

export {
  BINARY_STL_HEADER_BYTES,
  looksLikeAsciiStl,
  looksLikeBinaryStl,
  MAX_BINARY_STL_BYTES,
  serializeBinaryStl,
} from "./stl";
export {
  extract3mfPlates,
  extract3mfSourceConfig,
  inspect3mfUpload,
  MAX_3MF_PLATES,
  PREARRANGED_PLATE_STL_HEADER,
} from "./threemf";
export type { ThreeMfSourceConfig, ThreeMfUploadInspection } from "./threemf";
export { extractZipEntry, isZip } from "./zip";
export { renderThumbnail } from "./thumbnail";
export { MAX_TEXT_MODEL_BYTES, MAX_TRIANGLES, MAX_VERTICES, ModelParseError } from "./types";
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
