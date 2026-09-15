import { createTransport } from "nodemailer";
import { logger, safeErrorMessage } from "./logger";
import type { MailConfig } from "./mail-settings";

export interface OutgoingMail {
  subject: string;
  text: string;
  /** Where a reply goes (the customer, for contact-form messages). */
  replyTo?: string;
}

export type SendResult = { ok: true } | { ok: false; error: string };

const TIMEOUT_MS = 10_000;

/** Send one message to the shop with the configured provider. Never throws;
 *  the error text is the provider's, for the admin's test button and the log. */
export async function sendMail(config: MailConfig, mail: OutgoingMail): Promise<SendResult> {
  try {
    if (config.provider === "smtp") {
      const transport = createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: { user: config.smtp.user, pass: config.smtp.pass },
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS,
      });
      await transport.sendMail({ from: config.from, to: config.to, replyTo: mail.replyTo, subject: mail.subject, text: mail.text });
      return { ok: true };
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: config.from,
        to: [config.to],
        ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
        subject: mail.subject,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    logger.error({ status: res.status }, "Resend rejected an email");
    return { ok: false, error: `Resend answered ${res.status}${detail ? `: ${detail}` : ""}` };
  } catch (err) {
    const error = safeErrorMessage(err);
    logger.error({ error, provider: config.provider }, "Sending email failed");
    return { ok: false, error };
  }
}
