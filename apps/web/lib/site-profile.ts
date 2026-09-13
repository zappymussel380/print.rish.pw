import { cache } from "react";
import { Prisma, prisma } from "@print/db";
import {
  type SiteProfile,
  type SiteProfileInput,
  normalizeSiteProfile,
} from "@print/shared";
import { siteConfig } from "./site-config";

/** Key of the single JSON row in `AppSetting` that stores the shop's profile. */
export const SITE_PROFILE_KEY = "siteProfile";

/** The shop's name, contact details and page choices. An empty WhatsApp
 *  number falls back to the deployment's WHATSAPP_NUMBER, which is how
 *  print.rish.pw was configured before profiles existed (and is public anyway
 *  through every wa.me link). The email deliberately has no env fallback: the
 *  never-rendered CONTACT_EMAIL must not start appearing on the contact page
 *  without the owner choosing to publish it here. `cache()` dedupes the read
 *  across a request's layout and page. */
export const getSiteProfile = cache(async (): Promise<SiteProfile> => {
  let profile: SiteProfile;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SITE_PROFILE_KEY } });
    profile = normalizeSiteProfile(row?.value ?? null);
  } catch {
    // Branding must never take a page down.
    profile = normalizeSiteProfile(null);
  }
  return withEnvFallbacks(profile);
});

function withEnvFallbacks(profile: SiteProfile): SiteProfile {
  return {
    ...profile,
    contact: {
      ...profile.contact,
      whatsappNumber: profile.contact.whatsappNumber || siteConfig.whatsappNumber,
    },
  };
}

/** The stored profile exactly as saved (no env fallbacks) — what the admin form
 *  edits, so saving never copies an env value into the database. */
export async function getStoredSiteProfile(): Promise<SiteProfile> {
  const row = await prisma.appSetting.findUnique({ where: { key: SITE_PROFILE_KEY } });
  return normalizeSiteProfile(row?.value ?? null);
}

export async function saveSiteProfile(input: SiteProfileInput): Promise<SiteProfile> {
  const normalized = normalizeSiteProfile(input);
  const value = normalized as unknown as Prisma.InputJsonObject;
  await prisma.appSetting.upsert({
    where: { key: SITE_PROFILE_KEY },
    create: { key: SITE_PROFILE_KEY, value },
    update: { value },
  });
  return normalized;
}

/** wa.me link for the shop's WhatsApp, optionally with a prefilled message. */
export function profileWhatsappUrl(profile: SiteProfile, text?: string): string | null {
  const number = profile.contact.whatsappNumber;
  if (!number) return null;
  const base = `https://wa.me/${number}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}
