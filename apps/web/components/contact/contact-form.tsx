"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { emailSuggestions, isProbablyEmail } from "@/lib/email-hint";

/** Subjects offered — must match the allowlist in app/api/contact/route.ts. */
const SUBJECTS = [
  "Quote question",
  "Bulk / repeat order",
  "Materials & finishing",
  "Something else",
] as const;

type Status = "idle" | "sending" | "sent" | "error";

export function ContactForm() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    subject: SUBJECTS[0] as string,
    message: "",
  });
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [emailNote, setEmailNote] = useState("");
  const emailTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (emailTimer.current && clearTimeout(emailTimer.current)), []);

  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const onEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, email: value }));
    setSuggestions(emailSuggestions(value));
    // Validate a beat after typing stops, so it doesn't nag mid-type.
    if (emailTimer.current) clearTimeout(emailTimer.current);
    emailTimer.current = setTimeout(() => {
      setEmailNote(value && !isProbablyEmail(value) ? "Email looks invalid." : "");
    }, 1800);
  };

  const pickSuggestion = (s: string) => {
    setForm((f) => ({ ...f, email: s }));
    setSuggestions([]);
    setEmailNote(isProbablyEmail(s) ? "" : "Email looks invalid.");
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isProbablyEmail(form.email)) {
      setEmailNote("Email looks invalid.");
      return;
    }
    setStatus("sending");
    setError(null);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        let message = "Couldn't send that. Please try again.";
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (body.error?.message) message = body.error.message;
        } catch {
          /* non-JSON */
        }
        setError(message);
        setStatus("error");
        return;
      }
      setStatus("sent");
      setForm({ name: "", email: "", subject: SUBJECTS[0], message: "" });
      setEmailNote("");
      setSuggestions([]);
    } catch {
      setError("Network error. Please try again.");
      setStatus("error");
    }
  };

  if (status === "sent") {
    return (
      <div className="tile p-6 text-center sm:col-span-2">
        <p className="text-lg font-[650]">Sent. Thanks.</p>
        <p className="mt-2 text-sm text-muted">
          We&apos;ll reply to your email soon. For anything urgent, WhatsApp is fastest.
        </p>
        <button
          type="button"
          onClick={() => setStatus("idle")}
          className="btn-ghost mt-5"
        >
          Send another
        </button>
      </div>
    );
  }

  const sending = status === "sending";

  return (
    <form onSubmit={onSubmit} className="tile p-6 sm:col-span-2" noValidate>
      <h2 className="text-lg font-[650]">Send a message</h2>
      <p className="mt-1.5 text-sm leading-6 text-muted">
        Share the details here and it lands straight in our inbox.
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input
            name="name"
            value={form.name}
            onChange={set("name")}
            required
            maxLength={120}
            autoComplete="name"
            placeholder="What should we call you?"
            className="input-base"
          />
        </Field>
        <Field label="Email">
          <input
            name="email"
            type="email"
            value={form.email}
            onChange={onEmailChange}
            onFocus={(e) => setSuggestions(emailSuggestions(e.target.value))}
            onBlur={(e) => {
              const value = e.target.value;
              setEmailNote(value && !isProbablyEmail(value) ? "Email looks invalid." : "");
              // Delay so a suggestion click registers before the list hides.
              setTimeout(() => setSuggestions([]), 160);
            }}
            required
            maxLength={254}
            autoComplete="email"
            aria-invalid={emailNote ? true : undefined}
            placeholder="Where should we reply?"
            className="input-base"
          />
          {suggestions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Email domain suggestions">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  // Prevent the input's blur from firing before the click.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSuggestion(s)}
                  className="rounded-full border border-line bg-[color-mix(in_srgb,var(--bg)_52%,transparent)] px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-text"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {emailNote && (
            <p className="mt-1.5 text-xs text-accent" role="alert">
              {emailNote}
            </p>
          )}
        </Field>
      </div>

      <Field label="What's this about?" className="mt-4">
        <select
          name="subject"
          value={form.subject}
          onChange={set("subject")}
          className="input-base appearance-none"
        >
          {SUBJECTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Message" className="mt-4">
        <textarea
          name="message"
          rows={4}
          value={form.message}
          onChange={set("message")}
          required
          maxLength={4000}
          placeholder="Tell us about your part, quantities, deadlines. No need to be formal."
          className="input-base resize-y"
        />
      </Field>

      {status === "error" && error && (
        <p className="mt-4 text-sm text-accent" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={sending} className="btn-pill mt-6 w-full sm:w-auto">
        {sending ? (
          <>
            <Loader2 strokeWidth={2} className="h-4 w-4 animate-spin" /> Sending…
          </>
        ) : (
          <>
            Send it <Send strokeWidth={2} className="h-4 w-4" />
          </>
        )}
      </button>
    </form>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="mb-2 block text-[0.7rem] font-[650] uppercase tracking-[0.14em] text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}
