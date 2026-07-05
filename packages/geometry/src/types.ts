export interface ParsedModel {
  /** Triangle soup: 9 floats per triangle (three xyz vertices), millimetres. */
  positions: Float32Array;
  triangleCount: number;
  bboxMm: { x: number; y: number; z: number };
  /** Enclosed volume (signed-tetrahedron sum), cm³. Approximate for open meshes. */
  volumeCm3: number;
}

export class ModelParseError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable code surfaced to the client. */
    public readonly code:
      | "EMPTY"
      | "MALFORMED"
      | "TOO_MANY_TRIANGLES"
      | "ZIP_BOMB"
      | "UNSUPPORTED_FORMAT" = "MALFORMED",
  ) {
    super(message);
    this.name = "ModelParseError";
  }
}

/** Hard cap: a 100 MB binary STL is ~2M triangles; anything beyond 8M is
 *  either malformed or hostile. */
export const MAX_TRIANGLES = 8_000_000;
