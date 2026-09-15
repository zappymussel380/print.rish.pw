"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GSTIN_RE, HSN_RE, TAX_RATE_MAX_BP, formatTaxRate, type TaxSettings } from "@print/shared";

/** GST added to quotations. When on, every new quote, checkout, PDF and
 *  WhatsApp message shows GST at this rate on the printing, setup fee and
 *  shipping, with the HSN/SAC code and the shop's GSTIN on the PDF. Issued
 *  quotations keep the GST they were issued with. */
export function TaxEditor({ initial }: { initial: TaxSettings }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [rate, setRate] = useState(String(initial.rateBp / 100));
  const [hsn, setHsn] = useState(initial.hsn);
  const [gstin, setGstin] = useState(initial.gstin);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
    setError(null);
  };
  const ratePct = Number(rate);
  const badRate = rate.trim() === "" || !Number.isFinite(ratePct) || ratePct < 0 || ratePct > TAX_RATE_MAX_BP / 100;
  const badHsn = hsn !== "" && !HSN_RE.test(hsn);
  const badGstin = gstin !== "" && !GSTIN_RE.test(gstin.toUpperCase());

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/tax", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({ enabled, ratePct, hsn: hsn.trim(), gstin: gstin.trim().toUpperCase() }),
      });
      const data = (await res.json().catch(() => null)) as (TaxSettings & { error?: { message?: string } }) | null;
      if (!res.ok || !data) {
        setError(data?.error?.message ?? "Saving GST failed.");
        return;
      }
      setView(data);
      setDirty(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  const field = "input-base mt-1.5 py-2 text-sm";
  return (
    <details className="tile mt-4 p-0 [&_summary]:list-none">
      <summary className="flex cursor-pointer items-center justify-between p-4 text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
        <span>GST · added to quotations</span>
        <span className="text-faint">{view.enabled ? formatTaxRate(view.rateBp) : "off"}</span>
      </summary>
      <div className="space-y-4 border-t border-line p-4">
        <p className="text-xs text-faint">
          When on, GST is added on top of the printing, setup fee and shipping on every new quote, and the quotation
          PDF shows the rate, your HSN/SAC code and GSTIN. Your rates stay pre-tax. Quotations are estimates, not tax
          invoices; issued ones keep the GST they were issued with.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => touch(setEnabled)(e.target.checked)} className="size-4 accent-[var(--accent)]" />
          Add GST to quotations
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="font-[600]">Rate (%)</span>
            <input inputMode="decimal" value={rate} aria-invalid={badRate} onChange={(e) => touch(setRate)(e.target.value)} className={`${field} tabular-nums ${badRate ? "border-[var(--danger)]" : ""}`} />
          </label>
          <label className="block text-sm">
            <span className="font-[600]">HSN / SAC code</span>
            <input inputMode="numeric" value={hsn} maxLength={8} placeholder="e.g. 9988" aria-invalid={badHsn} onChange={(e) => touch(setHsn)(e.target.value.trim())} className={`${field} tabular-nums ${badHsn ? "border-[var(--danger)]" : ""}`} />
          </label>
          <label className="block text-sm">
            <span className="font-[600]">Your GSTIN</span>
            <input value={gstin} maxLength={15} placeholder="15 characters" aria-invalid={badGstin} onChange={(e) => touch(setGstin)(e.target.value.toUpperCase())} className={`${field} uppercase tabular-nums ${badGstin ? "border-[var(--danger)]" : ""}`} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={save} disabled={!dirty || saving || badRate || badHsn || badGstin} className="btn-pill text-sm disabled:opacity-40">
            {saving ? "Saving…" : "Save GST"}
          </button>
          {error ? (
            <span className="text-xs text-danger" role="alert">
              {error}
            </span>
          ) : dirty ? (
            <span className="text-xs text-faint">Unsaved changes · applies to new quotes only</span>
          ) : null}
        </div>
      </div>
    </details>
  );
}
