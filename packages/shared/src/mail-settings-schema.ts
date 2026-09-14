import { z } from "zod";
import { MAIL_FIELD_MAX, type MailSettings } from "./mail-settings";

const email = z.email().max(MAIL_FIELD_MAX.address);

export function isMailAddress(value: string): boolean {
  return email.safeParse(value).success;
}

/** "Shop <hello@shop.in>" or "hello@shop.in": the address inside must be valid,
 *  and the display name can't smuggle header characters. */
export function isMailFrom(value: string): boolean {
  if (value.length > MAIL_FIELD_MAX.from || /[\r\n]/.test(value)) return false;
  const m = /^\s*(?:"?([^"<>]*?)"?\s*)?<([^<>]+)>\s*$/.exec(value);
  return m ? isMailAddress(m[2]!.trim()) : isMailAddress(value.trim());
}

/** A hostname or IP an SMTP server can live at. */
export function isMailHost(value: string): boolean {
  return value.length <= MAIL_FIELD_MAX.host && /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value);
}

/** What admin → Settings → Email sends. Secrets are write-only: absent or
 *  empty keeps the current one. */
export const mailSettingsInputSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(["resend", "smtp"]),
  to: z.string().trim().max(MAIL_FIELD_MAX.address),
  from: z.string().trim().max(MAIL_FIELD_MAX.from),
  resendKey: z.string().max(200).optional(),
  smtp: z
    .object({
      host: z.string().trim().max(MAIL_FIELD_MAX.host),
      port: z.number().int().min(1).max(65535),
      secure: z.boolean(),
      user: z.string().trim().max(MAIL_FIELD_MAX.address),
      pass: z.string().max(500).optional(),
    })
    .optional(),
});
export type MailSettingsInput = z.infer<typeof mailSettingsInputSchema>;

/** A stored blob, hardened: null when there is nothing usable (the caller
 *  then falls back to the environment). Invalid fields are blanked, which
 *  leaves mail off rather than half-configured. */
export function normalizeMailSettings(raw: unknown): MailSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const smtp = r.smtp && typeof r.smtp === "object" ? (r.smtp as Record<string, unknown>) : {};
  const port = typeof smtp.port === "number" && Number.isInteger(smtp.port) && smtp.port >= 1 && smtp.port <= 65535 ? smtp.port : 587;
  const to = text(r.to);
  const from = text(r.from);
  const host = text(smtp.host);
  return {
    enabled: r.enabled === true,
    provider: r.provider === "smtp" ? "smtp" : "resend",
    to: isMailAddress(to) ? to : "",
    from: isMailFrom(from) ? from : "",
    resendKeySealed: text(r.resendKeySealed),
    smtp: {
      host: isMailHost(host) ? host : "",
      port,
      secure: smtp.secure === true,
      user: text(smtp.user),
      passSealed: text(smtp.passSealed),
    },
  };
}
