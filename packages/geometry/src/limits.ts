import { BINARY_STL_HEADER_BYTES, MAX_BINARY_STL_BYTES } from "./stl";
import { MAX_3MF_PLATES } from "./threemf";

/** Multi-plate extraction shares one triangle budget, so its combined STL
 * output is one maximum STL plus at most one extra header per plate. */
export const MAX_CANONICAL_ARCHIVE_BYTES =
  MAX_BINARY_STL_BYTES + (MAX_3MF_PLATES - 1) * BINARY_STL_HEADER_BYTES;
