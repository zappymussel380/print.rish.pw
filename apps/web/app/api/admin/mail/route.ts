import { NextResponse, type NextRequest } from "next/server";
import { isMailAddress, isMailFrom, isMailHost, mailSettingsInputSchema, type MailSettings } from "@print/shared";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import {
  RESEND_KEY_PURPOSE,
  SMTP_PASS_PURPOSE,
  getMailConfig,
  getStoredMail,
  resolveMailConfig,
  saveMail,
  toMailAdminView,
} from "@/lib/mail-settings";
import { sealSecret } from "@/lib/secret-box";
import { assertSameOrigin } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;

/** Admin: the contact-form mail settings in use, without secrets. */
export async function GET() {
  const auth = await requireAdminApi();
  if (auth) return auth;
  return NextResponse.json(toMailAdminView(await getMailConfig()));
}

/** Admin: save the contact-form mail settings. Switching mail on needs a
 *  recipient, a sender and the provider's credentials (typed now, or the ones
 *  already in use — a first save keeps the environment's Resend key). Secrets
 *  are sealed; "Send test email" checks them against the provider. */
export async function PUT(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = mailSettingsInputSchema.safeParse(body.value);
  if (!parsed.success) return jsonError(422, "BAD_REQUEST", "Invalid email settings payload");
  const input = parsed.data;

  const current = resolveMailConfig(await getStoredMail());
  const resendKey = input.resendKey || current.resendKey;
  const smtp = {
    host: input.smtp?.host ?? current.smtp.host,
    port: input.smtp?.port ?? current.smtp.port,
    secure: input.smtp?.secure ?? current.smtp.secure,
    user: input.smtp?.user ?? current.smtp.user,
    pass: input.smtp?.pass || current.smtp.pass,
  };

  const issues: string[] = [];
  if (input.to !== "" && !isMailAddress(input.to)) issues.push("the send-to address");
  if (input.from !== "" && !isMailFrom(input.from)) issues.push('the sender (an address, or "Shop <address>")');
  if (smtp.host !== "" && !isMailHost(smtp.host)) issues.push("the SMTP server");
  if (input.enabled) {
    if (input.to === "") issues.push("a send-to address");
    if (input.from === "") issues.push("a sender");
    if (input.provider === "resend" && resendKey === "") issues.push("a Resend API key");
    if (input.provider === "smtp") {
      if (smtp.host === "") issues.push("an SMTP server");
      if (smtp.user === "") issues.push("an SMTP user");
      if (smtp.pass === "") issues.push("an SMTP password");
    }
  }
  if (issues.length > 0) {
    return jsonError(422, "INVALID_FIELDS", `${input.enabled ? "To send email, check" : "Check"} ${[...new Set(issues)].join(", ")}.`);
  }

  const next: MailSettings = {
    enabled: input.enabled,
    provider: input.provider,
    to: input.to,
    from: input.from,
    // Both providers' secrets are kept, so switching back doesn't lose one.
    resendKeySealed: resendKey ? sealSecret(resendKey, RESEND_KEY_PURPOSE) : "",
    smtp: {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      user: smtp.user,
      passSealed: smtp.pass ? sealSecret(smtp.pass, SMTP_PASS_PURPOSE) : "",
    },
  };
  await saveMail(next);
  return NextResponse.json(toMailAdminView(resolveMailConfig(next)));
}
