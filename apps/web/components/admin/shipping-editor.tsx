"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PICKUP_PINCODE_RE, SHIPPING_EMAIL_MAX, type ShippingAdminView } from "@print/shared";

/** Courier estimates on the quote page, through the shop's Shiprocket API user.
 *  Until this is saved the server's environment settings are used, if any;
 *  with none, customers see no estimator and checkout says shipping is
 *  arranged afterwards. The password is write-only. */
export function ShippingEditor({ initial }: { initial: ShippingAdminView }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled || initial.source === "none");
  const [email, setEmail] = useState(initial.email);
  const [password, setPassword] = useState("");
  const [pincode, setPincode] = useState(initial.pickupPincode);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
  };
  const badPincode = pincode.trim() !== "" && !PICKUP_PINCODE_RE.test(pincode.trim());

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/shipping", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({ enabled, email: email.trim(), password, pickupPincode: pincode.trim() }),
      });
      const data = (await res.json().catch(() => null)) as (ShippingAdminView & { error?: { message?: string } }) | null;
      if (!res.ok || !data) {
        setError(data?.error?.message ?? "Saving shipping settings failed.");
        return;
      }
      setView(data);
      setPassword("");
      setDirty(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  const status = view.live
    ? view.source === "env"
      ? "On · using the server's settings (SHIPROCKET_* in .env). Saving here takes over from them."
      : "On · customers get a courier estimate on the quote page."
    : view.passwordUnreadable
      ? "Off · the saved password can't be read any more (the server's secret changed). Type it again."
      : view.source === "none"
        ? "Not set up · customers see “pickup or arranged over WhatsApp” instead of an estimate."
        : "Off · customers see “pickup or arranged over WhatsApp” instead of an estimate.";

  return (
    <details className="tile mt-4 p-0 [&_summary]:list-none">
      <summary className="flex cursor-pointer items-center justify-between p-4 text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
        <span>Shipping · courier estimates</span>
        <span className="text-faint">{view.live ? "on" : "off"}</span>
      </summary>
      <div className="space-y-4 border-t border-line p-4">
        <p className="text-xs text-faint">
          Live courier prices on the quote page come from Shiprocket. You need a Shiprocket account with an API user
          (Shiprocket → Settings → API → Configure → Create an API user) — its email and password go here, not your own
          login.
        </p>
        <p className={`text-xs ${view.live ? "text-muted" : "text-faint"}`} role="status">
          {status}
        </p>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => touch(setEnabled)(e.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          Show shipping estimates on the quote page
        </label>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="font-[600]">API user email</span>
            <input
              type="email"
              autoComplete="off"
              value={email}
              maxLength={SHIPPING_EMAIL_MAX}
              onChange={(e) => touch(setEmail)(e.target.value)}
              className="input-base mt-1.5 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="font-[600]">API user password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              maxLength={200}
              placeholder={view.hasPassword ? (view.source === "env" ? "set on the server" : "saved · leave blank to keep") : "required"}
              onChange={(e) => touch(setPassword)(e.target.value)}
              className="input-base mt-1.5 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="font-[600]">Pickup pincode</span>
            <input
              inputMode="numeric"
              value={pincode}
              maxLength={6}
              aria-invalid={badPincode}
              onChange={(e) => touch(setPincode)(e.target.value)}
              className={`input-base mt-1.5 py-2 text-sm tabular-nums ${badPincode ? "border-[var(--accent)]" : ""}`}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={save} disabled={!dirty || saving || badPincode} className="btn-pill text-sm disabled:opacity-40">
            {saving ? "Checking with Shiprocket…" : "Save shipping"}
          </button>
          {error ? (
            <span className="text-xs text-accent" role="alert">
              {error}
            </span>
          ) : dirty && !saving ? (
            <span className="text-xs text-faint">Unsaved changes · a new login is checked with Shiprocket first</span>
          ) : null}
        </div>
      </div>
    </details>
  );
}
