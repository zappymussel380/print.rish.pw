// Zod-free: the admin editor imports these. Validation lives in
// mail-settings-schema.ts.

/**
 * Where contact-form messages go, and how they're sent: through Resend's API
 * or any SMTP server (Gmail app password, Zoho, the host's own…). Stored as
 * one JSON app setting once the owner saves it in admin → Settings; until then
 * the server's environment (RESEND_API_KEY, MAIL_TO, CONTACT_FROM) is used, so
 * an install set up that way keeps working. With neither, the contact page
 * offers WhatsApp and the shop's details instead of a form.
 */
export type MailProvider = "resend" | "smtp";

export interface MailSettings {
  enabled: boolean;
  provider: MailProvider;
  /** Who receives contact-form messages. */
  to: string;
  /** Sender, "Shop name <address>" or a bare address, on a domain the provider may send from. */
  from: string;
  /** Resend API key, sealed with the server's secret. Empty when none. */
  resendKeySealed: string;
  smtp: {
    host: string;
    port: number;
    /** TLS from the start (port 465); otherwise STARTTLS when offered. */
    secure: boolean;
    user: string;
    /** Sealed like the Resend key. */
    passSealed: string;
  };
}

/** What admin → Settings → Email shows. Never carries a secret. */
export interface MailAdminView {
  source: "saved" | "env" | "none";
  enabled: boolean;
  provider: MailProvider;
  to: string;
  from: string;
  smtp: { host: string; port: number; secure: boolean; user: string };
  hasResendKey: boolean;
  hasSmtpPass: boolean;
  /** A saved secret the server can no longer read (its secret changed). */
  secretUnreadable: boolean;
  /** The contact form sends right now. */
  live: boolean;
}

export const MAIL_FIELD_MAX = { address: 254, from: 320, host: 253 } as const;
