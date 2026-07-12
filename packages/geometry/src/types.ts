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
      | "TOO_COMPLEX"
      | "ZIP_BOMB"
      | "UNSUPPORTED_FORMAT" = "MALFORMED",
  ) {
    super(message);
    this.name = "ModelParseError";
  }
}

/** Complexity cap independent of transport size. Four million triangles already
 * require roughly 144 MiB for the normalized triangle soup; allowing the full
 * 300 MiB upload ceiling to dictate allocations would make memory exhaustion
 * trivial with a syntactically valid file. */
export const MAX_TRIANGLES = 4_000_000;
export const MAX_VERTICES = 1_000_000;

/** Text formats create a decoded string plus parser-side arrays. Keep their
 * ceiling below the binary upload ceiling so one request cannot multiply into
 * several hundred MiB of live JavaScript objects. */
export const MAX_TEXT_MODEL_BYTES = 32 * 1024 * 1024;
