/** RFC 4122 UUID (versions 1–5) pattern fragment, unanchored so callers can
 * compose it into larger patterns (file names, queue reservation members). */
export const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** Anchored, case-insensitive UUID matcher for whole-string validation. */
export const UUID_RE = new RegExp(`^${UUID_PATTERN}$`, "i");
