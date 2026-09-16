import { z } from "zod";
import { prisma } from "@print/db";
import {
  availabilitySchema,
  faqSettingsSchema,
  isProfileSlot,
  materialHelperInputSchema,
  normalizeAvailability,
  normalizeFaqSettings,
  normalizeMailSettings,
  normalizeMaterialHelper,
  normalizePricing,
  normalizeRetention,
  normalizeShippingSettings,
  normalizeSiteProfile,
  normalizeTax,
  pricingInputSchema,
  retentionInputSchema,
  siteProfileInputSchema,
  slotInScope,
  toPricingInput,
  type MailSettings,
  type ProfileSlot,
  type ShippingSettings,
} from "@print/shared";
import { CATALOG_AVAILABILITY_KEY, restoreCatalogAvailability } from "./catalog-availability";
import { FAQ_KEY, saveFaqSettings } from "./faq";
import { getMailConfig, getStoredMail, MAIL_KEY, saveMail } from "./mail-settings";
import { MATERIAL_HELPER_KEY, saveMaterialHelper } from "./material-helper";
import { PRICING_KEY, savePricing } from "./pricing-settings";
import { advancedProfilesEnabled } from "./printer";
import { envRetention, RETENTION_KEY, saveRetention } from "./retention-settings";
import { getShippingConfig, getStoredShipping, saveShipping, SHIPPING_KEY } from "./shipping-settings";
import { saveSiteProfile, SITE_PROFILE_KEY } from "./site-profile";
import { ProfileUploadRejected, parseProfileUpload } from "./slicer-profile-upload";
import { queueProfileUpload } from "./slicer-profiles";
import { saveTax, TAX_KEY } from "./tax-settings";

/**
 * Admin → Settings → Backup: every setting the shop has saved, and the
 * OrcaSlicer presets live on it, as one JSON file — so a reinstall (or a move
 * to another machine) gets its rates, catalog, colours, own materials, helper,
 * profile, FAQ, GST, clean-up, shipping and email back in one step.
 *
 * Passwords and API keys are never in the file: they're sealed with the
 * install's SESSION_SECRET, which a reinstall doesn't share, and a settings
 * file is the kind of thing that gets emailed around. A restore keeps the
 * install's own where the account matches, and says which to re-enter.
 */
export const BACKUP_FORMAT = "print-shop-settings";
export const BACKUP_VERSION = 1;

/** Sections in the order the file lists them, with how the admin names each. */
export const BACKUP_SECTIONS = {
  pricing: { key: PRICING_KEY, label: "Rates" },
  catalogAvailability: { key: CATALOG_AVAILABILITY_KEY, label: "Catalog, colours and your own materials" },
  materialHelper: { key: MATERIAL_HELPER_KEY, label: "Material helper" },
  siteProfile: { key: SITE_PROFILE_KEY, label: "Shop profile" },
  faq: { key: FAQ_KEY, label: "FAQ" },
  tax: { key: TAX_KEY, label: "GST" },
  retention: { key: RETENTION_KEY, label: "File clean-up" },
  shipping: { key: SHIPPING_KEY, label: "Shipping" },
  mail: { key: MAIL_KEY, label: "Email" },
} as const;
export type BackupSection = keyof typeof BACKUP_SECTIONS;
const SECTION_NAMES = Object.keys(BACKUP_SECTIONS) as BackupSection[];

export interface BackupPreset {
  slot: ProfileSlot;
  presetName: string;
  originalName: string;
  raw: Record<string, unknown>;
}

export interface SettingsBackup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  /** Only the sections the shop has saved; each normalized, secrets blanked. */
  sections: Partial<Record<BackupSection, unknown>>;
  presets: BackupPreset[];
}

const MAX_PRESETS = 32;

/** Each section as it's stored, hardened — or null to leave it out. */
function exportSection(name: BackupSection, value: unknown): unknown {
  switch (name) {
    case "pricing":
      return toPricingInput(normalizePricing(value));
    case "catalogAvailability":
      return normalizeAvailability(value);
    case "materialHelper":
      return normalizeMaterialHelper(value);
    case "siteProfile":
      return normalizeSiteProfile(value);
    case "faq":
      return normalizeFaqSettings(value);
    case "tax":
      return normalizeTax(value);
    case "retention":
      return normalizeRetention(value, envRetention());
    case "shipping": {
      const saved = normalizeShippingSettings(value);
      return saved ? { ...saved, passwordSealed: "" } : null;
    }
    case "mail": {
      const saved = normalizeMailSettings(value);
      return saved ? { ...saved, resendKeySealed: "", smtp: { ...saved.smtp, passSealed: "" } } : null;
    }
  }
}

export async function buildBackup(now = new Date()): Promise<SettingsBackup> {
  const keys = SECTION_NAMES.map((name) => BACKUP_SECTIONS[name].key);
  const [rows, presets] = await Promise.all([
    prisma.appSetting.findMany({ where: { key: { in: keys } } }),
    prisma.slicerProfileUpload.findMany({
      where: { status: "ACTIVE", slot: { not: null } },
      select: { slot: true, presetName: true, originalName: true, raw: true },
      orderBy: { slot: "asc" },
    }),
  ]);
  const sections: SettingsBackup["sections"] = {};
  for (const name of SECTION_NAMES) {
    const row = rows.find((r) => r.key === BACKUP_SECTIONS[name].key);
    if (!row) continue;
    const value = exportSection(name, row.value);
    if (value !== null) sections[name] = value;
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    sections,
    presets: presets.flatMap((p) =>
      p.slot && isProfileSlot(p.slot) && p.raw && typeof p.raw === "object" && !Array.isArray(p.raw)
        ? [{ slot: p.slot, presetName: p.presetName, originalName: p.originalName, raw: p.raw as Record<string, unknown> }]
        : [],
    ),
  };
}

// --- restore -----------------------------------------------------------------

const storedTaxSchema = z.object({ enabled: z.boolean(), rateBp: z.number().int(), hsn: z.string(), gstin: z.string() });
const objectSchema = z.record(z.string(), z.unknown());

/** The shape each section must have to be restored. The loose ones (rates,
 *  profile) are hardened field by field on save, like an admin save. */
const SECTION_SCHEMAS: Record<BackupSection, z.ZodType> = {
  pricing: pricingInputSchema,
  catalogAvailability: availabilitySchema,
  materialHelper: materialHelperInputSchema,
  siteProfile: siteProfileInputSchema,
  faq: faqSettingsSchema,
  tax: storedTaxSchema,
  retention: retentionInputSchema,
  shipping: objectSchema,
  mail: objectSchema,
};

const presetSchema = z.object({
  slot: z.string().max(64),
  presetName: z.string().max(200),
  originalName: z.string().max(255),
  raw: objectSchema,
});

export const backupEnvelopeSchema = z.object({
  format: z.string(),
  version: z.number().int(),
  exportedAt: z.string().max(64).optional(),
  sections: z.record(z.string(), z.unknown()).default({}),
  presets: z.array(presetSchema).max(MAX_PRESETS).default([]),
});

export interface RestoreReport {
  restored: string[];
  skipped: { what: string; why: string }[];
  presetsQueued: number;
  /** Passwords/keys to enter again in Settings: they're never in a backup. */
  secretsToReenter: string[];
}

export class BackupRejected extends Error {}

/** Key order doesn't survive jsonb, so compare presets canonically. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Shipping from a backup, with this install's password kept when it's for
 *  the same Shiprocket account. Null = leave this install's shipping alone. */
async function mergeShipping(incoming: ShippingSettings, report: RestoreReport): Promise<ShippingSettings | null> {
  const [stored, live] = await Promise.all([getStoredShipping(), getShippingConfig()]);
  const sameAccount = stored && stored.email.toLowerCase() === incoming.email.toLowerCase();
  const passwordSealed = sameAccount ? stored.passwordSealed : "";
  if (!passwordSealed && incoming.enabled && live.live) {
    // Restoring without a password would switch working shipping off.
    report.skipped.push({ what: "Shipping", why: "this install's shipping is working; the backup has no password for it, so it was kept" });
    return null;
  }
  if (!passwordSealed && incoming.enabled) report.secretsToReenter.push("Shiprocket password (Settings → Shipping)");
  return { ...incoming, passwordSealed };
}

/** Email from a backup, keeping this install's key/password when it's for the
 *  same provider and account. Null = leave this install's email alone. */
async function mergeMail(incoming: MailSettings, report: RestoreReport): Promise<MailSettings | null> {
  const [stored, live] = await Promise.all([getStoredMail(), getMailConfig()]);
  const resendKeySealed = stored && incoming.provider === "resend" && stored.provider === "resend" ? stored.resendKeySealed : "";
  const passSealed =
    stored && incoming.provider === "smtp" && stored.provider === "smtp" && stored.smtp.host === incoming.smtp.host && stored.smtp.user === incoming.smtp.user
      ? stored.smtp.passSealed
      : "";
  const secret = incoming.provider === "smtp" ? passSealed : resendKeySealed;
  if (!secret && incoming.enabled && live.live) {
    report.skipped.push({ what: "Email", why: "this install's email is working; the backup has no key for it, so it was kept" });
    return null;
  }
  if (!secret && incoming.enabled) {
    report.secretsToReenter.push(incoming.provider === "smtp" ? "SMTP password (Settings → Email)" : "Resend API key (Settings → Email)");
  }
  return { ...incoming, resendKeySealed, smtp: { ...incoming.smtp, passSealed } };
}

/**
 * Put a backup back. Every section in it is checked before anything is
 * written, and one that doesn't check out refuses the whole restore — a half
 * restore would leave a shop that matches neither install. Presets go through
 * the same test slice as an upload before they're live.
 */
export async function restoreBackup(raw: unknown): Promise<RestoreReport> {
  const envelope = backupEnvelopeSchema.safeParse(raw);
  if (!envelope.success || envelope.data.format !== BACKUP_FORMAT) {
    throw new BackupRejected("That isn't a settings backup from this shop's admin (Settings → Backup).");
  }
  const { version, sections, presets } = envelope.data;
  if (version > BACKUP_VERSION) {
    throw new BackupRejected("That backup was made by a newer version of the shop. Update this install first, then restore it.");
  }
  if (version < 1) throw new BackupRejected("That backup's version isn't one this install knows.");

  const report: RestoreReport = { restored: [], skipped: [], presetsQueued: 0, secretsToReenter: [] };
  const bad: string[] = [];
  const valid: Partial<Record<BackupSection, unknown>> = {};
  for (const [name, value] of Object.entries(sections)) {
    if (!(name in BACKUP_SECTIONS)) {
      report.skipped.push({ what: name, why: "not a setting this install has" });
      continue;
    }
    const section = name as BackupSection;
    const parsed = SECTION_SCHEMAS[section].safeParse(value);
    const usable =
      parsed.success &&
      (section !== "shipping" || normalizeShippingSettings(value) !== null) &&
      (section !== "mail" || normalizeMailSettings(value) !== null) &&
      (section !== "retention" || normalizeRetention(value, envRetention()) !== null);
    if (!usable) bad.push(BACKUP_SECTIONS[section].label);
    else valid[section] = parsed.data;
  }
  if (bad.length > 0) {
    throw new BackupRejected(`Nothing was restored: ${bad.join(", ")} in that file ${bad.length === 1 ? "isn't" : "aren't"} valid.`);
  }

  for (const section of SECTION_NAMES) {
    if (!(section in valid)) continue;
    const value = valid[section];
    switch (section) {
      case "pricing":
        await savePricing(value as z.infer<typeof pricingInputSchema>);
        break;
      case "catalogAvailability":
        await restoreCatalogAvailability(value);
        break;
      case "materialHelper":
        await saveMaterialHelper(normalizeMaterialHelper(value));
        break;
      case "siteProfile":
        await saveSiteProfile(value as z.infer<typeof siteProfileInputSchema>);
        break;
      case "faq":
        await saveFaqSettings(value as z.infer<typeof faqSettingsSchema>);
        break;
      case "tax":
        await saveTax(normalizeTax(value));
        break;
      case "retention":
        await saveRetention(normalizeRetention(value, envRetention())!);
        break;
      case "shipping": {
        const merged = await mergeShipping(normalizeShippingSettings(value)!, report);
        if (!merged) continue;
        await saveShipping(merged);
        break;
      }
      case "mail": {
        const merged = await mergeMail(normalizeMailSettings(value)!, report);
        if (!merged) continue;
        await saveMail(merged);
        break;
      }
    }
    report.restored.push(BACKUP_SECTIONS[section].label);
  }

  await restorePresets(presets, report);
  return report;
}

async function restorePresets(presets: z.infer<typeof presetSchema>[], report: RestoreReport): Promise<void> {
  if (presets.length === 0) return;
  const advanced = advancedProfilesEnabled();
  const live = await prisma.slicerProfileUpload.findMany({
    where: { status: "ACTIVE", slot: { not: null } },
    select: { slot: true, raw: true },
  });
  for (const preset of presets) {
    const what = `Preset "${preset.presetName}"`;
    if (!isProfileSlot(preset.slot)) {
      report.skipped.push({ what, why: "it's for a slot this install doesn't have" });
      continue;
    }
    if (!slotInScope(preset.slot, advanced)) {
      report.skipped.push({ what, why: "this install uses the installer's profiles for that (advanced mode is off)" });
      continue;
    }
    if (live.some((row) => row.slot === preset.slot && canonical(row.raw) === canonical(preset.raw))) {
      report.skipped.push({ what, why: "already live here" });
      continue;
    }
    let upload;
    try {
      upload = parseProfileUpload(new TextEncoder().encode(JSON.stringify(preset.raw)), `${preset.presetName}.json`, preset.slot);
    } catch (error) {
      if (!(error instanceof ProfileUploadRejected)) throw error;
      report.skipped.push({ what, why: error.message });
      continue;
    }
    try {
      await queueProfileUpload(upload, preset.originalName);
      report.presetsQueued += 1;
    } catch {
      report.skipped.push({ what, why: "its test slice couldn't be queued; upload it again from Filament" });
    }
  }
}
