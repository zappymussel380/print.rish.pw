"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MAIL_FIELD_MAX, type MailAdminView, type MailProvider } from "@print/shared";

/** Where contact-form messages go, through Resend or any SMTP server. Until
 *  this is saved the server's environment settings are used, if any; with
 *  none, the contact page shows WhatsApp and the shop's details instead of a
 *  form. Secrets are write-only. */
export function MailEditor({ initial }: { initial: MailAdminView }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled || initial.source === "none");
  const [provider, setProvider] = useState<MailProvider>(initial.provider);
  const [to, setTo] = useState(initial.to);
  const [from, setFrom] = useState(initial.from);
  const [resendKey, setResendKey] = useState("");
  const [host, setHost] = useState(initial.smtp.host);
  const [port, setPort] = useState(String(initial.smtp.port));
  const [secure, setSecure] = useState(initial.smtp.secure);
  const [user, setUser] = useState(initial.smtp.user);
  const [pass, setPass] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
    setMessage(null);
  };
  const portNumber = Number(port);
  const badPort = !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535;

  const call = async (url: string, init: RequestInit) => {
    const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" } });
    const data = (await res.json().catch(() => null)) as (Record<string, unknown> & { error?: { message?: string } }) | null;
    return { ok: res.ok, data };
  };

  const save = async () => {
    setBusy("save");
    setMessage(null);
    try {
      const { ok, data } = await call("/api/admin/mail", {
        method: "PUT",
        body: JSON.stringify({
          enabled,
          provider,
          to: to.trim(),
          from: from.trim(),
          resendKey,
          smtp: { host: host.trim(), port: portNumber, secure, user: user.trim(), pass },
        }),
      });
      if (!ok || !data) {
        setMessage({ ok: false, text: data?.error?.message ?? "Saving email settings failed." });
        return;
      }
      setView(data as unknown as MailAdminView);
      setResendKey("");
      setPass("");
      setDirty(false);
      setMessage({ ok: true, text: "Saved. Send a test email to check it works." });
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setMessage(null);
    try {
      const { ok, data } = await call("/api/admin/mail/test", { method: "POST" });
      setMessage(
        ok
          ? { ok: true, text: `Test email sent to ${String(data?.to ?? view.to)}. Check the inbox (and spam).` }
          : { ok: false, text: data?.error?.message ?? "The test email failed." },
      );
    } finally {
      setBusy(null);
    }
  };

  const status = view.live
    ? view.source === "env"
      ? "On · using the server's settings (RESEND_API_KEY and MAIL_TO in .env). Saving here takes over from them."
      : `On · contact-form messages go to ${view.to}.`
    : view.secretUnreadable
      ? "Off · a saved password or key can't be read any more (the server's secret changed). Type it again."
      : view.source === "none"
        ? "Not set up · the contact page shows WhatsApp and your details instead of a form."
        : "Off · the contact page shows WhatsApp and your details instead of a form.";

  const field = "input-base mt-1.5 py-2 text-sm";
  const secretPlaceholder = (has: boolean) => (has ? (view.source === "env" ? "set on the server" : "saved · leave blank to keep") : "required");

  return (
    <details className="tile mt-4 p-0 [&_summary]:list-none">
      <summary className="flex cursor-pointer items-center justify-between p-4 text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
        <span>Email · contact form</span>
        <span className="text-faint">{view.live ? "on" : "off"}</span>
      </summary>
      <div className="space-y-4 border-t border-line p-4">
        <p className="text-xs text-faint">
          Messages from the contact page are emailed to you. Send them through Resend (free tier; verify your domain
          there) or any SMTP server — a Gmail or Zoho app password works.
        </p>
        <p className={`text-xs ${view.live ? "text-muted" : "text-faint"}`} role="status">
          {status}
        </p>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => touch(setEnabled)(e.target.checked)} className="size-4 accent-[var(--accent)]" />
          Show the contact form and email its messages to me
        </label>

        <fieldset className="min-w-0">
          <legend className="text-sm font-[600]">Send with</legend>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {(["resend", "smtp"] as const).map((p) => (
              <label key={p} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="mail-provider"
                  checked={provider === p}
                  onChange={() => touch(setProvider)(p)}
                  className="size-4 accent-[var(--accent)]"
                />
                {p === "resend" ? "Resend" : "SMTP server"}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-[600]">Send messages to</span>
            <input type="email" value={to} maxLength={MAIL_FIELD_MAX.address} onChange={(e) => touch(setTo)(e.target.value)} className={field} />
          </label>
          <label className="block text-sm">
            <span className="font-[600]">From</span>
            <span className="ml-2 text-xs text-faint">e.g. Shop name &lt;hello@yourshop.in&gt;</span>
            <input value={from} maxLength={MAIL_FIELD_MAX.from} onChange={(e) => touch(setFrom)(e.target.value)} className={field} />
          </label>

          {provider === "resend" ? (
            <label className="block text-sm sm:col-span-2">
              <span className="font-[600]">Resend API key</span>
              <input
                type="password"
                autoComplete="new-password"
                value={resendKey}
                maxLength={200}
                placeholder={secretPlaceholder(view.hasResendKey)}
                onChange={(e) => touch(setResendKey)(e.target.value)}
                className={field}
              />
            </label>
          ) : (
            <>
              <label className="block text-sm">
                <span className="font-[600]">SMTP server</span>
                <input value={host} maxLength={MAIL_FIELD_MAX.host} placeholder="smtp.gmail.com" onChange={(e) => touch(setHost)(e.target.value)} className={field} />
              </label>
              <div className="flex items-end gap-3">
                <label className="block w-24 text-sm">
                  <span className="font-[600]">Port</span>
                  <input
                    inputMode="numeric"
                    value={port}
                    aria-invalid={badPort}
                    onChange={(e) => touch(setPort)(e.target.value)}
                    className={`${field} tabular-nums ${badPort ? "border-[var(--danger)]" : ""}`}
                  />
                </label>
                <label className="mb-2.5 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={secure} onChange={(e) => touch(setSecure)(e.target.checked)} className="size-4 accent-[var(--accent)]" />
                  TLS from the start (port 465)
                </label>
              </div>
              <label className="block text-sm">
                <span className="font-[600]">SMTP user</span>
                <input autoComplete="off" value={user} maxLength={MAIL_FIELD_MAX.address} onChange={(e) => touch(setUser)(e.target.value)} className={field} />
              </label>
              <label className="block text-sm">
                <span className="font-[600]">SMTP password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={pass}
                  maxLength={500}
                  placeholder={secretPlaceholder(view.hasSmtpPass)}
                  onChange={(e) => touch(setPass)(e.target.value)}
                  className={field}
                />
              </label>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={save} disabled={!dirty || busy !== null || badPort} className="btn-pill text-sm disabled:opacity-40">
            {busy === "save" ? "Saving…" : "Save email"}
          </button>
          <button type="button" onClick={test} disabled={dirty || busy !== null || !view.live} className="btn-ghost text-sm disabled:opacity-40">
            {busy === "test" ? "Sending…" : "Send test email"}
          </button>
          {message ? (
            <span className={`text-xs ${message.ok ? "text-muted" : "text-danger"}`} role={message.ok ? "status" : "alert"}>
              {message.text}
            </span>
          ) : dirty ? (
            <span className="text-xs text-faint">Unsaved changes</span>
          ) : null}
        </div>
      </div>
    </details>
  );
}
