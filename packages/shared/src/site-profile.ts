import type { MaterialId } from "./quote-types";
import { DEFAULT_QUOTATION_PREFIX } from "./quotation-number";
import { DEFAULT_ACCENT, type AccentId } from "./accents";

// Zod-free on purpose: the site header and context use this on every page.
// Validation lives in site-profile-schema.ts.

/**
 * The shop's identity and contact details — everything that differs between
 * one print shop running this software and the next. Admin-editable (and
 * seeded by the self-host installer), stored as one JSON app setting. The
 * defaults reproduce print.rish.pw exactly, so a shop that has never saved a
 * profile renders precisely what it always has.
 */
export interface SiteProfile {
  /** Shown in the header wordmark, page titles, PDFs and emails. */
  brandName: string;
  /** One line under the name in page metadata and the quotation PDF. */
  tagline: string;
  /** Where the shop is: "3D printing · <city>", pickup and shipping copy. */
  city: string;
  contact: {
    /** International format, digits only (e.g. 919876543210). Empty = use env. */
    whatsappNumber: string;
    /** Shown on the contact page. Empty = use env. */
    email: string;
    phone: string;
    address: string;
  };
  /** Small print in the footer. Plain text; a bare domain in it is linked. */
  footerNote: string;
  /** Materials explained on /materials, in display order. The shop's own
   *  materials can be among them once the owner has written their copy. */
  materialsPage: MaterialId[];
  /** Initials that start every quotation number (2–5 capital letters). */
  quotationPrefix: string;
  /** The site's accent colour (a preset from accents.ts). */
  accent: AccentId;
}

export const DEFAULT_SITE_PROFILE: SiteProfile = {
  brandName: "print.rish.pw",
  tagline: "instant 3D printing quotes",
  city: "Guwahati",
  contact: { whatsappNumber: "", email: "", phone: "", address: "" },
  footerNote: "A rish.pw project",
  materialsPage: ["PLA", "PETG"],
  quotationPrefix: DEFAULT_QUOTATION_PREFIX,
  accent: DEFAULT_ACCENT,
};

export const SITE_PROFILE_LIMITS = {
  brandName: 40,
  tagline: 80,
  city: 60,
  email: 254,
  phone: 24,
  address: 300,
  footerNote: 120,
} as const;

/** Split a brand for the header wordmark: the accent part is everything before
 *  the first "." or space ("print" + ".rish.pw", "Acme" + " Prints"). A brand
 *  with neither is accented whole. */
export function splitBrand(brandName: string): { accent: string; rest: string } {
  const at = brandName.search(/[. ]/);
  return at > 0
    ? { accent: brandName.slice(0, at), rest: brandName.slice(at) }
    : { accent: brandName, rest: "" };
}

/** "PLA", "PLA and PETG", "PLA, PETG and ABS". */
export function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
