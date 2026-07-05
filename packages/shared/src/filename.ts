/** Upload filename handling: extension mapping and display-name sanitisation.
 *  Stored files are always named by UUID; the sanitised original name is kept
 *  only for display, so this guards rendering paths, CSV exports and PDFs. */

export const MODEL_FORMATS = {
  stl: "stl",
  "3mf": "3mf",
  obj: "obj",
  amf: "amf",
} as const;

export type ModelFormat = (typeof MODEL_FORMATS)[keyof typeof MODEL_FORMATS];

export function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
}

export function formatFromFilename(name: string): ModelFormat | null {
  const ext = extensionOf(name);
  return ext in MODEL_FORMATS ? MODEL_FORMATS[ext as keyof typeof MODEL_FORMATS] : null;
}

const MAX_NAME_CHARS = 200;

/** Sanitise an untrusted original filename for storage in the DB / display.
 *  Strips directories, control characters and exotic whitespace; caps length
 *  while preserving the extension. */
export function sanitizeOriginalName(raw: string): string {
  // Windows and POSIX path separators — keep only the basename.
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    // Control chars, zero-width chars and bidi override marks.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "model";
  }
  if (cleaned.length <= MAX_NAME_CHARS) {
    return cleaned;
  }
  const ext = extensionOf(cleaned);
  const stem = ext ? cleaned.slice(0, -(ext.length + 1)) : cleaned;
  return `${stem.slice(0, MAX_NAME_CHARS - ext.length - 2)}…${ext ? `.${ext}` : ""}`;
}
