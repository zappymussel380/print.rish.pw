import { cache } from "react";
import { type Prisma, prisma } from "@print/db";
import { normalizeMailSettings, type MailAdminView, type MailProvider, type MailSettings } from "@print/shared";
import { env } from "./env";
import { openSecret } from "./secret-box";

/** Key of the JSON row in `AppSetting` holding admin → Settings → Email. */
export const MAIL_KEY = "mail";

/** Purposes the mail secrets are sealed for (see secret-box). */
export const RESEND_KEY_PURPOSE = "mail-resend-key";
export const SMTP_PASS_PURPOSE = "mail-smtp-pass";

/** The settings contact-form mail is sent with right now. */
export interface MailConfig {
  source: MailAdminView["source"];
  /** The contact form sends: switched on and fully set up. */
  live: boolean;
  enabled: boolean;
  provider: MailProvider;
  to: string;
  from: string;
  /** In the clear, server-side only; empty when none. */
  resendKey: string;
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
  secretUnreadable: boolean;
}

/** What admin saved, or null when it never has. */
export async function getStoredMail(): Promise<MailSettings | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: MAIL_KEY } });
  return normalizeMailSettings(row?.value ?? null);
}

/** The environment's settings (Resend only), as installs used before
 *  admin → Settings → Email existed. */
function fromEnv(): MailConfig {
  const resendKey = process.env.RESEND_API_KEY ?? "";
  const to = process.env.MAIL_TO ?? "";
  const configured = resendKey !== "" && to !== "";
  return {
    source: configured ? "env" : "none",
    live: configured,
    enabled: configured,
    provider: "resend",
    to,
    from: env.contactFrom,
    resendKey,
    smtp: { host: "", port: 587, secure: false, user: "", pass: "" },
    secretUnreadable: false,
  };
}

function fromSaved(saved: MailSettings): MailConfig {
  const open = (sealed: string, purpose: string) => (sealed ? openSecret(sealed, purpose) : "");
  const resendKey = open(saved.resendKeySealed, RESEND_KEY_PURPOSE);
  const pass = open(saved.smtp.passSealed, SMTP_PASS_PURPOSE);
  const secret = saved.provider === "smtp" ? pass : resendKey;
  const ready =
    saved.to !== "" &&
    saved.from !== "" &&
    (saved.provider === "resend" ? Boolean(resendKey) : saved.smtp.host !== "" && saved.smtp.user !== "" && Boolean(pass));
  return {
    source: "saved",
    live: saved.enabled && ready,
    enabled: saved.enabled,
    provider: saved.provider,
    to: saved.to,
    from: saved.from,
    resendKey: resendKey ?? "",
    smtp: { ...saved.smtp, pass: pass ?? "" },
    secretUnreadable: secret === null,
  };
}

/** Saved settings win; otherwise the environment. */
export function resolveMailConfig(saved: MailSettings | null): MailConfig {
  return saved ? fromSaved(saved) : fromEnv();
}

/** The live settings. A database hiccup falls back to the environment, so the
 *  contact page never breaks over it. */
export const getMailConfig = cache(async (): Promise<MailConfig> => {
  try {
    return resolveMailConfig(await getStoredMail());
  } catch {
    return fromEnv();
  }
});

export function toMailAdminView(config: MailConfig): MailAdminView {
  const { host, port, secure, user } = config.smtp;
  return {
    source: config.source,
    enabled: config.enabled,
    provider: config.provider,
    to: config.to,
    from: config.from,
    smtp: { host, port, secure, user },
    hasResendKey: config.resendKey !== "",
    hasSmtpPass: config.smtp.pass !== "",
    secretUnreadable: config.secretUnreadable,
    live: config.live,
  };
}

export async function saveMail(settings: MailSettings): Promise<void> {
  const value = settings as unknown as Prisma.InputJsonObject;
  await prisma.appSetting.upsert({
    where: { key: MAIL_KEY },
    create: { key: MAIL_KEY, value },
    update: { value },
  });
}
