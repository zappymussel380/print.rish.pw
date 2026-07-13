"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import {
  CATALOG,
  formatDuration,
  formatGrams,
  formatPaise,
  settingsKey,
} from "@print/shared";
import { computePricing } from "@/lib/pricing-client";
import { submitQuotation, type CheckoutError } from "@/lib/checkout-client";
import { emailSuggestions, isProbablyEmail } from "@/lib/email-hint";
import { sliceCacheKey, useQuoteStore } from "@/lib/quote-store";

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

const isValidPhone = (v: string) => /^\d{10}$/.test(v);

/** Reduce common Indian phone entry to the bare 10-digit mobile without ever
 *  silently dropping real digits. A +91 / 91 country prefix (12 digits total)
 *  or a leading 0 trunk prefix (11 digits) is stripped only when exactly 10
 *  digits then remain; anything else is kept verbatim so validation rejects it
 *  rather than truncating a pasted "+91 98765 43210" into a wrong-but-plausible
 *  "9198765432". */
const normalizeMobile = (raw: string): string => {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
};

export function CheckoutForm() {
  const router = useRouter();
  const models = useQuoteStore((s) => s.models);
  const slices = useQuoteStore((s) => s.slices);
  const shipping = useQuoteStore((s) => s.shipping);
  const clear = useQuoteStore((s) => s.clear);

  const [form, setForm] = useState({ name: "", email: "", phone: "", city: "", notes: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<CheckoutError | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [emailNote, setEmailNote] = useState("");
  const emailTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (emailTimer.current && clearTimeout(emailTimer.current)), []);

  const { breakdown, pending, completion } = computePricing(models, slices);

  const items = useMemo(
    () =>
      models
        .filter((m) => m.status === "ready" && m.server)
        .filter((m) => slices[sliceCacheKey(m.server!.id, settingsKey(m.config))]?.status === "done")
        .map((m) => ({ modelId: m.server!.id, config: m.config, fileName: m.fileName })),
    [models, slices],
  );

  if (!breakdown || items.length === 0) {
    return (
      <div className="mx-auto mt-12 max-w-lg text-center">
        <p className="text-muted">
          {pending > 0
            ? "Your models are still being sliced. Head back and wait for pricing to finish."
            : "There are no priced models in your quote yet."}
        </p>
        <Link href="/quote" className="btn-ghost mt-6">
          Back to the quote builder
        </Link>
      </div>
    );
  }

  // Only trust the saved shipping estimate if it was priced for this exact quote.
  const quoteKey = `${breakdown.totals.grams}:${breakdown.totalPaise}`;
  const shippingValid = shipping && shipping.quoteKey === quoteKey ? shipping : null;
  const grandTotalPaise = breakdown.totalPaise + (shippingValid?.amountPaise ?? 0);

  const field = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const issue = (k: string) => error?.issues?.[k]?.[0];

  const onEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, email: value }));
    setSuggestions(emailSuggestions(value));
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
  const onPhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, phone: normalizeMobile(e.target.value) }));
  };

  const emailValid = isProbablyEmail(form.email);
  const phoneValid = isValidPhone(form.phone);
  const phoneNote = form.phone.length > 0 && !phoneValid ? "Enter a 10-digit number." : "";
  const canSubmit =
    !!form.name.trim() && !!form.city.trim() && emailValid && phoneValid && !submitting;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      // Send the saved shipping token even if the client thinks it is stale:
      // the customer chose delivery, so the server must judge the token and
      // 409 a changed quote ("re-estimate") rather than silently submitting a
      // delivery quote with zero shipping.
      const result = await submitQuotation(
        items.map(({ modelId, config }) => ({ modelId, config })),
        { ...form, notes: form.notes || undefined } as never,
        shipping?.token,
      );
      clear();
      // Keep the bearer in the URL fragment: fragments are never sent in HTTP
      // requests, proxy logs, or Referer headers. The server also set a scoped
      // HttpOnly access cookie on the submission response.
      router.push(`/quotation/${result.number}#token=${result.accessToken}`);
    } catch (err) {
      setError(err as CheckoutError);
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto mt-12 grid max-w-4xl gap-8 lg:grid-cols-[1fr_360px]">
      {/* Form */}
      <form onSubmit={onSubmit} className="order-2 lg:order-1" noValidate>
        <h2 className="section-title">Your details</h2>
        <p className="mt-2 text-sm text-muted">
          We&apos;ll generate your quotation and open WhatsApp so you can confirm with us directly.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Input label="Name" name="name" value={form.name} onChange={field("name")} error={issue("name")} required />
          <Input label="City" name="city" value={form.city} onChange={field("city")} error={issue("city")} required />

          <label className="block">
            <span className="mb-2 block text-[0.7rem] font-[650] uppercase tracking-[0.14em] text-muted">
              Email
            </span>
            <input
              name="email"
              type="email"
              inputMode="email"
              value={form.email}
              onChange={onEmailChange}
              onBlur={() => setTimeout(() => setSuggestions([]), 120)}
              className="input-base"
              aria-invalid={!!emailNote || !!issue("email")}
              required
            />
            {suggestions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Email domain suggestions">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickSuggestion(s)}
                    className="chip cursor-pointer hover:border-accent hover:text-accent"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {(emailNote || issue("email")) && (
              <span className="mt-1 block text-xs text-accent" role="alert">
                {emailNote || issue("email")}
              </span>
            )}
          </label>

          <label className="block">
            <span className="mb-2 block text-[0.7rem] font-[650] uppercase tracking-[0.14em] text-muted">
              Phone
            </span>
            <input
              name="phone"
              type="tel"
              inputMode="numeric"
              value={form.phone}
              onChange={onPhoneChange}
              placeholder="10-digit mobile"
              className="input-base"
              aria-invalid={!!phoneNote || !!issue("phone")}
              required
            />
            {(phoneNote || issue("phone")) && (
              <span className="mt-1 block text-xs text-accent" role="alert">
                {phoneNote || issue("phone")}
              </span>
            )}
          </label>
        </div>

        <p className="mt-4 max-w-2xl text-xs leading-5 text-muted">
          We store and use your contact and delivery details only to process this order. Our live
          quotation record, PDF and remaining local files have a retention period of at most 90 days
          after the order is completed or cancelled, then the next daily cleanup removes them. We
          never analyze or sell these details, or use them for marketing. Processing may share them
          with the operator&apos;s WhatsApp, Telegram and email accounts, and with the shipping
          provider. Provider and backup copies follow their own retention schedules.
        </p>

        <label className="mt-4 block">
          <span className="mb-2 block text-[0.7rem] font-[650] uppercase tracking-[0.14em] text-muted">
            Notes <span className="normal-case text-faint">(optional)</span>
          </span>
          <textarea
            name="notes"
            rows={3}
            value={form.notes}
            onChange={field("notes")}
            placeholder="Colours, deadlines, finishing, anything we should know…"
            className="input-base resize-y"
            maxLength={2000}
          />
        </label>

        {error && !error.issues && (
          <p className="mt-4 text-sm text-accent" role="alert">
            {error.message}
          </p>
        )}

        <button type="submit" disabled={!canSubmit} className="btn-pill mt-6 w-full sm:w-auto">
          {submitting ? (
            <>
              <Loader2 strokeWidth={2} className="h-4 w-4 animate-spin" /> Generating quotation…
            </>
          ) : (
            <>
              Get my quotation <ArrowRight strokeWidth={2} className="h-4 w-4" />
            </>
          )}
        </button>
        <p className="mt-3 text-xs text-faint">
          No payment now. This creates a quotation and a WhatsApp message — you confirm from there.
        </p>
      </form>

      {/* Order review */}
      <aside className="order-1 lg:order-2">
        <div className="tile p-5 lg:sticky lg:top-24">
          <p className="eyebrow text-[0.7rem]">Order summary</p>
          <ul className="mt-4 space-y-3">
            {items.map(({ modelId, config, fileName }) => {
              const slice = slices[sliceCacheKey(modelId, settingsKey(config))];
              const grams = slice?.result ? slice.result.filamentGrams * config.quantity : 0;
              return (
                <li key={modelId} className="flex items-start justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-[600]" title={fileName}>
                      {config.quantity > 1 ? `${config.quantity}× ` : ""}
                      {fileName}
                    </p>
                    <p className="text-xs text-faint">
                      {config.material} · {config.colour} · {formatGrams(grams)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
            <Row label="Materials" value={formatPaise(breakdown.totalPaise - breakdown.setupFeePaise)} />
            <Row label="Setup fee" value={formatPaise(breakdown.setupFeePaise)} />
            {shippingValid ? (
              <Row label={`Shipping (to ${shippingValid.pincode})`} value={formatPaise(shippingValid.amountPaise)} />
            ) : (
              <Row label="Shipping" value="Not included" muted />
            )}
            <Row label="Print time" value={formatDuration(breakdown.totals.printSeconds)} muted />
            {completion && <Row label="Ready by" value={dateFmt.format(completion)} muted />}
          </div>
          <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3">
            <span className="font-[650]">Total</span>
            <span className="text-xl font-[750] text-accent">{formatPaise(grandTotalPaise)}</span>
          </div>
          <p className="mt-3 text-[0.7rem] leading-5 text-faint">
            {shippingValid
              ? "Includes estimated prepaid shipping. "
              : "Shipping is not included — pickup in Guwahati or arranged over WhatsApp. "}
            Estimate from real slicing on a {CATALOG.printers[CATALOG.defaultPrinterId]!.name}. Final
            confirmation over WhatsApp.
          </p>
        </div>
      </aside>
    </div>
  );
}

function Input({
  label,
  error,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  return (
    <label className="block">
      <span className="mb-2 block text-[0.7rem] font-[650] uppercase tracking-[0.14em] text-muted">
        {label}
      </span>
      <input {...props} className="input-base" aria-invalid={!!error} />
      {error && <span className="mt-1 block text-xs text-accent">{error}</span>}
    </label>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? "text-muted" : ""}>{label}</span>
      <span className={muted ? "text-muted" : "font-[600]"}>{value}</span>
    </div>
  );
}
