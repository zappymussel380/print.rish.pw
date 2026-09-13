/**
 * Quotation numbers: `<PREFIX>-<year>-<sequence>`, e.g. RSP-2026-0042. The
 * prefix is the shop's own initials (admin → Site, asked by the installer).
 * Every reader accepts any valid prefix, so numbers already issued keep working
 * after a shop changes its initials — the per-year sequence is shared, so a new
 * prefix never collides with an old number either.
 */
export const QUOTATION_PREFIX_RE = /^[A-Z]{2,5}$/;
export const QUOTATION_NUMBER_RE = /^[A-Z]{2,5}-\d{4}-\d{4,}$/;
export const DEFAULT_QUOTATION_PREFIX = "RSP";

export function formatQuotationNumber(prefix: string, year: number, sequence: number): string {
  const safe = QUOTATION_PREFIX_RE.test(prefix) ? prefix : DEFAULT_QUOTATION_PREFIX;
  return `${safe}-${year}-${String(sequence).padStart(4, "0")}`;
}

/** Suggested initials for a shop name: "Acme Prints" → "AP", "print.rish.pw" →
 *  "PRP", "Printery" → "PRI". Always 2–5 letters, falls back to the default. */
export function initialsFor(brandName: string): string {
  const words = brandName
    .normalize("NFKD")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((w) => /[A-Z]/.test(w));
  let initials = words.map((w) => w.replace(/[^A-Z]/g, "")[0]).join("");
  if (initials.length < 2 && words[0]) initials = words[0].replace(/[^A-Z]/g, "").slice(0, 3);
  initials = initials.slice(0, 5);
  return QUOTATION_PREFIX_RE.test(initials) ? initials : DEFAULT_QUOTATION_PREFIX;
}
