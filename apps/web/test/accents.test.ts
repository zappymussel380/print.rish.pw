import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCENTS, ACCENT_IDS, DEFAULT_ACCENT, accentCss, isAccentId } from "@print/shared";

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// The page's own tokens, read from the stylesheet so a palette change there
// re-checks every accent.
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const token = (block: string, name: string) => {
  const hex = new RegExp(`${block.replace(/[[\]"]/g, "\\$&")}\\s*\\{[^}]*--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css)?.[1];
  if (!hex) throw new Error(`no --${name} in ${block}`);
  return hex;
};
const themes = {
  light: { bg: token('html[data-theme="light"]', "bg"), surface: token('html[data-theme="light"]', "surface") },
  dark: { bg: token('html[data-theme="dark"]', "bg"), surface: token('html[data-theme="dark"]', "surface") },
};

describe("accent presets", () => {
  it("red is the default and matches the stylesheet", () => {
    expect(DEFAULT_ACCENT).toBe("red");
    expect(token('html[data-theme="light"]', "accent")).toBe(ACCENTS.red.light);
    expect(token('html[data-theme="dark"]', "accent")).toBe(ACCENTS.red.dark);
    expect(accentCss("red")).toBe("");
  });

  it("stay readable in both themes: accent text on the page, page-coloured text on an accent button", () => {
    for (const id of ACCENT_IDS) {
      for (const theme of ["light", "dark"] as const) {
        const accent = ACCENTS[id][theme];
        for (const ground of [themes[theme].bg, themes[theme].surface]) {
          expect(contrast(accent, ground), `${id} ${theme} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("repaint --accent for both themes, however the theme was chosen", () => {
    const blue = accentCss("blue");
    expect(blue).toContain(`html:root{--accent:${ACCENTS.blue.light}}`);
    expect(blue).toContain(`html:root:not([data-theme]){--accent:${ACCENTS.blue.dark}}`);
    expect(blue).toContain(`html:root[data-theme="dark"]{--accent:${ACCENTS.blue.dark}}`);
    expect(blue).not.toMatch(/[<>]/);
  });

  it("know their own ids", () => {
    expect(isAccentId("teal")).toBe(true);
    for (const bad of ["", "toString", "Red", 3, null]) expect(isAccentId(bad), String(bad)).toBe(false);
  });
});
