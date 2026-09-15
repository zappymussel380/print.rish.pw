import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAdminApi } from "@/lib/api-util";
import { sendMail } from "@/lib/mail";
import { getMailConfig } from "@/lib/mail-settings";
import { assertSameOrigin, rateLimit } from "@/lib/security";
import { getSiteProfile } from "@/lib/site-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin: send a test message with the saved settings, and say exactly what
 *  the provider answered. Rate-limited — it sends real mail. */
export async function POST(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");

  const limit = await rateLimit("mailTest", "admin", 5, 600);
  if (!limit.allowed) return jsonError(429, "RATE_LIMITED", "That's a few test emails already — try again in a few minutes.");

  const mail = await getMailConfig();
  if (!mail.live) return jsonError(409, "NOT_LIVE", "Save working settings with email switched on first.");

  const { brandName } = await getSiteProfile();
  const sent = await sendMail(mail, {
    subject: `[${brandName}] Test email`,
    text: `This is a test from ${brandName}'s admin dashboard (Settings → Email).\n\nContact-form messages will arrive here, sent via ${mail.provider === "smtp" ? `SMTP (${mail.smtp.host})` : "Resend"}.`,
  });
  if (!sent.ok) return jsonError(502, "SEND_FAILED", sent.error);
  return NextResponse.json({ status: "sent", to: mail.to });
}
