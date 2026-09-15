import { NextResponse, type NextRequest } from "next/server";
import { guardMutation, jsonError, readJsonBody } from "@/lib/api-util";
import { sendMail } from "@/lib/mail";
import { getMailConfig } from "@/lib/mail-settings";
import { RATE_LIMITS } from "@/lib/security";
import { getSiteProfile } from "@/lib/site-profile";

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
  // The contact page shows no form when mail isn't set up; this stops anything
  // else before it costs a rate-limit slot.
  const mail = await getMailConfig();
  if (!mail.live) {
    return jsonError(503, "NOT_CONFIGURED", "Messages by email aren't set up — please use WhatsApp or the details on the contact page.");
  }

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

  const { brandName } = await getSiteProfile();
  const sent = await sendMail(mail, {
    replyTo: email,
    subject: `[${brandName}] ${subject} — from ${name}`,
    text: `New message from the ${brandName} contact form.

Name:    ${name}
Email:   ${email}
Subject: ${subject}

Message:
${message}

---
Sent via ${brandName} contact form`,
  });
  if (!sent.ok) return jsonError(502, "SEND_FAILED", "Failed to send email. Please try again.");
  return NextResponse.json({ status: "ok" });
}
