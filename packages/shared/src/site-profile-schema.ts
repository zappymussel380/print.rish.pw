import { z } from "zod";
import { MATERIAL_IDS } from "./quote-types";
import { QUOTATION_PREFIX_RE } from "./quotation-number";
import { ACCENT_IDS, type AccentId } from "./accents";
import { DEFAULT_SITE_PROFILE, SITE_PROFILE_LIMITS, type SiteProfile } from "./site-profile";

/** Validation for site-profile.ts, kept out of it so the profile's defaults and
 *  helpers reach the browser without zod. */

const text = (max: number) => z.string().trim().max(max);
const L = SITE_PROFILE_LIMITS;

/** Strict per-field schemas, shared by the normaliser and the admin form. */
export const siteProfileFieldSchemas = {
  brandName: text(L.brandName).min(1),
  tagline: text(L.tagline),
  city: text(L.city),
  whatsappNumber: z
    .string()
    .transform((v) => v.replace(/[\s()+-]/g, ""))
    .pipe(z.string().regex(/^(?:[0-9]{8,15})?$/)),
  email: z.union([z.literal(""), z.string().trim().pipe(z.email().max(L.email))]),
  phone: z.union([z.literal(""), text(L.phone).regex(/^\+?[0-9][0-9 ()-]{5,22}$/)]),
  address: text(L.address),
  footerNote: text(L.footerNote),
  materialsPage: z.array(z.enum(MATERIAL_IDS)).min(1).max(MATERIAL_IDS.length),
  quotationPrefix: z.string().trim().toUpperCase().pipe(z.string().regex(QUOTATION_PREFIX_RE)),
  accent: z.enum(ACCENT_IDS as [AccentId, ...AccentId[]]),
};

/** Wire/storage shape: loose on purpose, hardened field by field below. */
export const siteProfileInputSchema = z.object({
  brandName: z.unknown().optional(),
  tagline: z.unknown().optional(),
  city: z.unknown().optional(),
  contact: z
    .object({
      whatsappNumber: z.unknown().optional(),
      email: z.unknown().optional(),
      phone: z.unknown().optional(),
      address: z.unknown().optional(),
    })
    .optional(),
  footerNote: z.unknown().optional(),
  materialsPage: z.unknown().optional(),
  quotationPrefix: z.unknown().optional(),
  accent: z.unknown().optional(),
});
export type SiteProfileInput = z.infer<typeof siteProfileInputSchema>;

function pick<T>(schema: z.ZodType<T, unknown>, value: unknown, fallback: T): T {
  if (value === undefined) return fallback;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/** Harden a stored/submitted profile: fill what is missing from the defaults,
 *  replace anything invalid, de-duplicate the materials list. Never throws. */
export function normalizeSiteProfile(raw: unknown): SiteProfile {
  const d = DEFAULT_SITE_PROFILE;
  const parsed = siteProfileInputSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ...d, contact: { ...d.contact }, materialsPage: [...d.materialsPage] };
  const input = parsed.data;
  const F = siteProfileFieldSchemas;
  const materials = pick(F.materialsPage, input.materialsPage, d.materialsPage);
  return {
    brandName: pick(F.brandName, input.brandName, d.brandName),
    tagline: pick(F.tagline, input.tagline, d.tagline),
    city: pick(F.city, input.city, d.city),
    contact: {
      whatsappNumber: pick(F.whatsappNumber, input.contact?.whatsappNumber, d.contact.whatsappNumber),
      email: pick(F.email, input.contact?.email, d.contact.email),
      phone: pick(F.phone, input.contact?.phone, d.contact.phone),
      address: pick(F.address, input.contact?.address, d.contact.address),
    },
    footerNote: pick(F.footerNote, input.footerNote, d.footerNote),
    materialsPage: [...new Set(materials)],
    quotationPrefix: pick(F.quotationPrefix, input.quotationPrefix, d.quotationPrefix),
    accent: pick(F.accent, input.accent, d.accent),
  };
}

/** Fields present in `raw` that a save would have to discard, as dotted paths.
 *  Saves with any issue are refused so a typo is reported, not replaced. */
export function findSiteProfileIssues(raw: unknown): string[] {
  const parsed = siteProfileInputSchema.safeParse(raw ?? {});
  if (!parsed.success) return ["(payload)"];
  const input = parsed.data;
  const F = siteProfileFieldSchemas;
  const issues: string[] = [];
  const check = (path: string, schema: z.ZodType<unknown, unknown>, value: unknown) => {
    if (value !== undefined && !schema.safeParse(value).success) issues.push(path);
  };
  check("brandName", F.brandName, input.brandName);
  check("tagline", F.tagline, input.tagline);
  check("city", F.city, input.city);
  check("contact.whatsappNumber", F.whatsappNumber, input.contact?.whatsappNumber);
  check("contact.email", F.email, input.contact?.email);
  check("contact.phone", F.phone, input.contact?.phone);
  check("contact.address", F.address, input.contact?.address);
  check("footerNote", F.footerNote, input.footerNote);
  check("materialsPage", F.materialsPage, input.materialsPage);
  check("quotationPrefix", F.quotationPrefix, input.quotationPrefix);
  check("accent", F.accent, input.accent);
  return issues;
}
