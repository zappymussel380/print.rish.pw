// Zod-free: the root layout and the admin editor both use these.

/**
 * The site's accent colour — header wordmark, buttons, links, prices, chips —
 * chosen by the shop from a few presets (admin → Site). Each has a shade for
 * the light theme and one for the dark theme, picked so text in the accent and
 * the page-coloured text on an accent button both stay readable (WCAG AA,
 * 4.5:1; a test holds every preset to it). Red is the original look. Errors
 * keep their own red (`--danger`), whatever the accent.
 *
 * `pdf` is the shade the quotation PDF (white paper) uses: the light-theme one,
 * except red, which keeps the PDF's original coral.
 */
export const ACCENTS = {
  red: { label: "Red", light: "#c23a3a", dark: "#ff5555", pdf: "#ff5555" },
  orange: { label: "Orange", light: "#b3470d", dark: "#ff8a4c", pdf: "#b3470d" },
  amber: { label: "Amber", light: "#946000", dark: "#f2b53a", pdf: "#946000" },
  green: { label: "Green", light: "#2e7a32", dark: "#5ccf66", pdf: "#2e7a32" },
  teal: { label: "Teal", light: "#0e776f", dark: "#3ccfc2", pdf: "#0e776f" },
  blue: { label: "Blue", light: "#2360c4", dark: "#6ea8ff", pdf: "#2360c4" },
  indigo: { label: "Indigo", light: "#4d44c4", dark: "#9b95ff", pdf: "#4d44c4" },
  violet: { label: "Violet", light: "#7f33c0", dark: "#c28bff", pdf: "#7f33c0" },
  pink: { label: "Pink", light: "#b92d70", dark: "#ff70ae", pdf: "#b92d70" },
} as const satisfies Record<string, { label: string; light: string; dark: string; pdf: string }>;

export type AccentId = keyof typeof ACCENTS;
export const ACCENT_IDS = Object.keys(ACCENTS) as AccentId[];
export const DEFAULT_ACCENT: AccentId = "red";

export function isAccentId(value: unknown): value is AccentId {
  return typeof value === "string" && Object.hasOwn(ACCENTS, value);
}

/** CSS that repaints `--accent` for a preset, in both themes and whichever
 *  way the theme was chosen (system setting or the toggle). `html:root` out-
 *  ranks the stylesheet's `:root`/`html[data-theme]` rules, so it applies
 *  wherever it lands in the page. Empty for the default, which the stylesheet
 *  already has, unless `always` (a preview has to beat another accent). */
export function accentCss(id: AccentId, always = false): string {
  if (id === DEFAULT_ACCENT && !always) return "";
  const { light, dark } = ACCENTS[id];
  return [
    `html:root{--accent:${light}}`,
    `@media (prefers-color-scheme: dark){html:root:not([data-theme]){--accent:${dark}}}`,
    `html:root[data-theme="light"]{--accent:${light}}`,
    `html:root[data-theme="dark"]{--accent:${dark}}`,
  ].join("");
}
