"use client";

import { useRef, useState } from "react";
import { Loader2, Truck } from "lucide-react";
import { formatPaise, settingsKey } from "@print/shared";
import { computePricing } from "@/lib/pricing-client";
import { sliceCacheKey, useQuoteStore } from "@/lib/quote-store";

interface Estimate {
  amountPaise: number;
  days: string | null;
  /** Server-signed proof of this exact amount; checkout verifies it. */
  token: string;
}
type Status = "idle" | "loading" | "done" | "error";

/** Delivery-pincode shipping estimator. Appears once a quote is priced; the
 *  server rebuilds the parcel weight + declared value from the session's sliced
 *  models (the client only names which models). Presented as our own estimate —
 *  not added to the total. */
export function ShippingEstimate() {
  const models = useQuoteStore((s) => s.models);
  const slices = useQuoteStore((s) => s.slices);
  const setShipping = useQuoteStore((s) => s.setShipping);
  const { breakdown, ingesting } = computePricing(models, slices);

  const [pincode, setPincode] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<Estimate | null>(null);
  // The (pincode + quote) signature the shown result was fetched for. A result
  // is only rendered while this still matches the live quote, so changing the
  // pincode, quantity, settings, or model list hides a now-stale amount.
  const [resultKey, setResultKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const valid = /^\d{6}$/.test(pincode);
  const quoteKey = breakdown ? `${breakdown.totals.grams}:${breakdown.totalPaise}` : "";
  const currentKey = breakdown ? `${pincode}:${quoteKey}` : "";

  // Always-current pincode+quote signature, read by the async handler so a
  // response for a pincode/quote the user has since changed is discarded rather
  // than shown or (worse) carried into checkout. Syncing during render keeps it
  // exact — an effect would lag a frame behind the fetch it needs to gate.
  const sigRef = useRef(currentKey);
  sigRef.current = currentKey;

  if (!breakdown || ingesting > 0) return null;

  const showResult = status === "done" && result && resultKey === currentKey;

  const items = models
    .filter((m) => m.status === "ready" && m.server)
    .filter((m) => {
      const s = slices[sliceCacheKey(m.server!.id, settingsKey(m.config))];
      return s?.status === "done" && s.result;
    })
    .map((m) => ({ modelId: m.server!.id, config: m.config }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const submittedKey = currentKey;
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/shipping", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({ deliveryPincode: pincode, items }),
      });
      // Discard a response the user has moved on from (pincode changed mid-
      // flight, or an earlier request resolving out of order after a newer one).
      // Leaving `setShipping` untouched here is the key point: a stale amount
      // must never reach checkout.
      if (submittedKey !== sigRef.current) return;
      const data = (await res.json().catch(() => ({}))) as {
        estimate?: Estimate;
        error?: { message?: string };
      };
      if (!res.ok) {
        setError(data.error?.message ?? "Couldn't estimate shipping. Please try again.");
        setStatus("error");
        setShipping(null); // a failed estimate must not leave a prior one carried to checkout
        return;
      }
      setResult(data.estimate ?? null);
      setResultKey(submittedKey);
      setStatus("done");
      // Carry the estimate to checkout, tagged with the quote it was priced for.
      setShipping(
        data.estimate
          ? {
              pincode,
              amountPaise: data.estimate.amountPaise,
              days: data.estimate.days,
              token: data.estimate.token,
              quoteKey,
            }
          : null,
      );
    } catch {
      if (submittedKey !== sigRef.current) return;
      setError("Network error — please try again.");
      setStatus("error");
      setShipping(null);
    }
  };

  const onPincodeChange = (raw: string) => {
    setPincode(raw.replace(/\D/g, "").slice(0, 6));
    // A changed pincode invalidates the previous lookup outright: hide the shown
    // result, drop any loading/error state, and clear the estimate carried to
    // checkout so the old pincode+amount can never be submitted.
    setStatus("idle");
    setError(null);
    setResult(null);
    setResultKey(null);
    setShipping(null);
  };

  return (
    <div className="tile mt-6 p-5">
      <div className="flex items-center gap-2">
        <Truck strokeWidth={1.65} className="size-5 text-accent" aria-hidden="true" />
        <h2 className="text-sm font-[650]">Estimate shipping</h2>
      </div>
      <p className="mt-1.5 text-xs leading-5 text-muted">
        Estimated prepaid shipping from Guwahati for your parts + 200&nbsp;g of packaging. Final
        shipping is confirmed over WhatsApp.
      </p>

      <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-center gap-2">
        <input
          inputMode="numeric"
          value={pincode}
          onChange={(e) => onPincodeChange(e.target.value)}
          placeholder="Delivery pincode"
          aria-label="Delivery pincode"
          className="input-base max-w-[11rem]"
        />
        <button type="submit" disabled={!valid || status === "loading"} className="btn-pill text-sm">
          {status === "loading" ? (
            <>
              <Loader2 strokeWidth={2} className="size-4 animate-spin" /> Checking…
            </>
          ) : (
            "Estimate"
          )}
        </button>
      </form>

      {showResult && (
        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-line bg-[color-mix(in_srgb,var(--surface)_60%,transparent)] p-3">
          <div>
            <p className="text-sm font-[650]">Estimated shipping</p>
            {result.days && (
              <p className="mt-0.5 text-xs text-muted">
                Delivery in ~{result.days} day{result.days === "1" ? "" : "s"}
              </p>
            )}
          </div>
          <p className="text-lg font-[700] text-accent">{formatPaise(result.amountPaise)}</p>
        </div>
      )}

      {status === "error" && error && (
        <p className="mt-3 text-xs text-accent" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
