"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FILAMENT_LINE_LABELS,
  MATERIAL_IDS,
  PRICING_BOUNDS,
  materialName,
  type FilamentLine,
  type PricingInput,
} from "@print/shared";

/**
 * Every rate the site uses, in rupees rather than paise. Grouped the way they
 * are used: what customers pay, what the pricing page says the rate covers,
 * lead time, and what filament and running the printer really cost (admin
 * profit only). Saves the whole set at once; the server refuses a save with
 * any out-of-range value and names it.
 */

type Unit = "rupees" | "percent" | "plain";

interface FieldDef {
  key: string;
  label: string;
  unit: Unit;
  suffix?: string;
  /** Bound checked before sending, on the stored (paise/ratio) value. */
  bound: { safeParse: (v: unknown) => { success: boolean } };
}

const B = PRICING_BOUNDS;
const LINES = Object.keys(FILAMENT_LINE_LABELS) as FilamentLine[];

function sections(): { title: string; hint: string; fields: FieldDef[] }[] {
  return [
    {
      title: "Customer prices",
      hint: "What every quote is built from: grams × the material's rate, plus one setup fee per order.",
      fields: [
        { key: "setupFeePaise", label: "Setup fee per order", unit: "rupees", bound: B.setupFeePaise },
        ...MATERIAL_IDS.map((m) => ({
          key: `materials.${m}.sellPerGramPaise`,
          label: `${materialName(m)} — per gram`,
          unit: "rupees" as const,
          suffix: "/ g",
          bound: B.sellPerGramPaise,
        })),
      ],
    },
    {
      title: "What the rate covers (shown to customers)",
      hint: "Informational lines on the pricing page and each quote — already inside the per-gram rate, never added on top.",
      fields: [
        ...MATERIAL_IDS.map((m) => ({
          key: `materials.${m}.costPerKgPaise`,
          label: `${materialName(m)} filament`,
          unit: "rupees" as const,
          suffix: "/ kg",
          bound: B.costPerKgPaise,
        })),
        { key: "electricityPerKwhPaise", label: "Electricity", unit: "rupees", suffix: "/ kWh", bound: B.electricityPerKwhPaise },
        { key: "kwhPerHour", label: "Printer power draw", unit: "plain", suffix: "kWh / print-hour", bound: B.kwhPerHour },
        { key: "maintenancePerGramPaise", label: "Maintenance", unit: "rupees", suffix: "/ g", bound: B.maintenancePerGramPaise },
      ],
    },
    {
      title: "Lead time",
      hint: "Drives the “ready by” date on every quote.",
      fields: [
        { key: "leadTime.printHoursPerDay", label: "Printing hours per day", unit: "plain", suffix: "h", bound: B.printHoursPerDay },
        { key: "leadTime.bufferDays", label: "Extra days (prep, QC, packing)", unit: "plain", suffix: "days", bound: B.bufferDays },
      ],
    },
    {
      title: "Your real costs (profit estimate only)",
      hint: "Never shown to customers. Filament is costed per spool line at list price + GST + shipping.",
      fields: [
        ...LINES.map((line) => ({
          key: `internal.spoolListPriceInr.${line}`,
          label: `${FILAMENT_LINE_LABELS[line]} spool`,
          unit: "plain" as const,
          suffix: "₹ / kg list",
          bound: B.spoolListPriceInr,
        })),
        { key: "internal.gstRate", label: "GST on filament", unit: "percent", suffix: "%", bound: B.gstRate },
        { key: "internal.spoolShippingPaise", label: "Shipping per spool", unit: "rupees", bound: B.spoolShippingPaise },
        { key: "internal.electricityPerKwhPaise", label: "Electricity", unit: "rupees", suffix: "/ kWh", bound: B.electricityPerKwhPaise },
        { key: "internal.electricityKwhPerHour", label: "Printer power draw", unit: "plain", suffix: "kWh / print-hour", bound: B.electricityKwhPerHour },
        { key: "internal.maintenancePerHourPaise", label: "Maintenance", unit: "rupees", suffix: "/ print-hour", bound: B.maintenancePerHourPaise },
      ],
    },
  ];
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
  o[keys.at(-1)!] = value;
}

/** Stored value → what the form shows. */
function toText(value: unknown, unit: Unit): string {
  if (typeof value !== "number") return "";
  if (unit === "rupees") return String(value / 100);
  if (unit === "percent") return String(Math.round(value * 10000) / 100);
  return String(value);
}

/** Form text → stored value, or undefined when it isn't a number. */
function fromText(text: string, unit: Unit): number | undefined {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  if (unit === "rupees") return Math.round(n * 100);
  if (unit === "percent") return Math.round(n * 100) / 10000;
  return n;
}

export function RatesEditor({ pricing }: { pricing: PricingInput }) {
  const router = useRouter();
  const defs = useMemo(() => sections(), []);
  const initial = useMemo(() => {
    const out: Record<string, string> = {};
    for (const s of defs) for (const f of s.fields) out[f.key] = toText(getPath(pricing, f.key), f.unit);
    return out;
  }, [defs, pricing]);
  const [values, setValues] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalid = new Set(
    defs.flatMap((s) =>
      s.fields
        .filter((f) => {
          const v = fromText(values[f.key] ?? "", f.unit);
          return v === undefined || !f.bound.safeParse(v).success;
        })
        .map((f) => f.key),
    ),
  );

  const save = async () => {
    if (invalid.size > 0) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      for (const s of defs) for (const f of s.fields) setPath(body, f.key, fromText(values[f.key]!, f.unit));
      const res = await fetch("/api/admin/pricing", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(data?.error?.message ?? "Saving rates failed.");
        return;
      }
      setDirty(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="tile mt-4 p-0 [&_summary]:list-none">
      <summary className="flex cursor-pointer items-center justify-between p-4 text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
        <span>Rates · prices &amp; costs</span>
        <span className="text-faint">edit</span>
      </summary>
      <div className="space-y-7 border-t border-line p-4">
        {defs.map((s) => (
          <fieldset key={s.title}>
            <legend className="text-sm font-[650]">{s.title}</legend>
            <p className="mt-0.5 text-xs text-faint">{s.hint}</p>
            <div className="mt-3 grid gap-x-5 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {s.fields.map((f) => {
                const bad = invalid.has(f.key);
                return (
                  <label key={f.key} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 text-muted">{f.label}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {f.unit === "rupees" ? <span className="text-faint">₹</span> : null}
                      <input
                        inputMode="decimal"
                        value={values[f.key] ?? ""}
                        aria-invalid={bad}
                        aria-label={`${s.title}: ${f.label}`}
                        onChange={(e) => {
                          setValues((v) => ({ ...v, [f.key]: e.target.value }));
                          setDirty(true);
                        }}
                        className={`input-base w-24 px-2 py-1.5 text-right text-sm tabular-nums ${
                          bad ? "border-[var(--accent)]" : ""
                        }`}
                      />
                      {f.suffix ? <span className="w-24 text-xs text-faint">{f.suffix}</span> : <span className="w-24" />}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving || invalid.size > 0}
            className="btn-pill text-sm disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save rates"}
          </button>
          {invalid.size > 0 ? (
            <span className="text-xs text-accent">
              {invalid.size} value{invalid.size === 1 ? " is" : "s are"} missing or out of range.
            </span>
          ) : dirty && !saving ? (
            <span className="text-xs text-faint">Unsaved changes — new quotes use the new rates; submitted quotations keep theirs.</span>
          ) : null}
          {error ? <span className="text-xs text-accent">{error}</span> : null}
        </div>
      </div>
    </details>
  );
}
