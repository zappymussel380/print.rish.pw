import { NextResponse, type NextRequest } from "next/server";
import { guardMutation, jsonError, readJsonBody } from "@/lib/api-util";
import { env } from "@/lib/env";
import { logger, safeErrorMessage } from "@/lib/logger";
import { RATE_LIMITS } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Subjects the form offers — the allowlist the server validates against.
 *  Keep in sync with components/contact/contact-form.tsx. */
const SUBJECTS = new Set([
  "Quote question",
  "Bulk / repeat order",
  "Materials & finishing",
  "Something else",
]);

const MAX = { name: 120, email: 254, subject: 40, message: 4000 } as const;

// Mirrors contact_api.py: a pragmatic "is this probably an email" check.
const EMAIL_RE = /^[^@\s]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;

// Strip control chars — name/subject land in the outbound email subject line,
// so this rules out header-injection style payloads.
function stripControl(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, " ");
}

export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "contact", RATE_LIMITS.contact);
  if (guard) return guard;

  // Reject oversized bodies before parsing. The largest legit field is the 4 000-
  // char message, so 8 KiB is ample headroom for the whole form.
  const parsedBody = await readJsonBody(request, 8 * 1024);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;

  const raw = body as Record<string, unknown>;
  const name = stripControl(String(raw.name ?? "")).trim();
  const email = stripControl(String(raw.email ?? "")).trim();
  const subject = stripControl(String(raw.subject ?? "")).trim();
  const message = String(raw.message ?? "").trim();

  if (!name || !email || !subject || !message) {
    return jsonError(400, "MISSING_FIELDS", "All fields are required.");
  }
  if (!EMAIL_RE.test(email)) {
    return jsonError(400, "BAD_EMAIL", "A valid email is required.");
  }
  if (
    name.length > MAX.name ||
    email.length > MAX.email ||
    subject.length > MAX.subject ||
    message.length > MAX.message
  ) {
    return jsonError(400, "TOO_LONG", "One of the fields is too long.");
  }
  if (!SUBJECTS.has(subject)) {
    return jsonError(400, "BAD_SUBJECT", "Invalid subject.");
  }

  let resendApiKey: string;
  let mailTo: string;
  try {
    resendApiKey = env.resendApiKey;
    mailTo = env.mailTo;
  } catch {
    logger.error("Contact form: RESEND_API_KEY / MAIL_TO not configured");
    return jsonError(500, "NOT_CONFIGURED", "Mail service is not configured.");
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.contactFrom,
        to: [mailTo],
        reply_to: email,
        subject: `[print.rish.pw] ${subject} — from ${name}`,
        text: `New message from the print.rish.pw contact form.

Name:    ${name}
Email:   ${email}
Subject: ${subject}

Message:
${message}

---
Sent via print.rish.pw contact form`,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.error({ status: res.status }, "Resend rejected contact email");
      return jsonError(502, "SEND_FAILED", "Failed to send email. Please try again.");
    }
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    logger.error({ error: safeErrorMessage(err) }, "Contact email send threw");
    return jsonError(502, "SEND_FAILED", "Failed to send email. Please try again.");
  }
}
