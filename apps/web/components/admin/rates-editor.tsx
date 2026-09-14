"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  CUSTOM_MATERIAL_IDS,
  CUSTOM_MATERIAL_LINE,
  FILAMENT_LINE_LABELS,
  INTERNAL_COST,
  MATERIAL_IDS,
  MATERIAL_LINES,
  PRICING_BOUNDS,
  isCustomMaterial,
  materialName,
  spoolCostPerKgPaise,
  type CustomMaterialNames,
  type FilamentLine,
  type MaterialId,
  type PricingInput,
} from "@print/shared";

/**
 * Every rate the site uses, in rupees rather than paise, laid out so what
 * customers see sits beside what it really costs the shop: one row per
 * material (its per-gram price, the filament figure the pricing page quotes,
 * the spool it's bought as and what a gram of that lands at), then the running
 * costs the same way. Saves the whole set at once; the server refuses a save
 * with any out-of-range value and names it.
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

/** The shop's own materials read by the names it gave them; the rest, as built in. */
type NameOf = (material: MaterialId) => string;

/** A spool line's label: the shop's own materials' lines by their names. */
function lineLabel(line: FilamentLine, nameOf: NameOf): string {
  const own = CUSTOM_MATERIAL_IDS.find((id) => CUSTOM_MATERIAL_LINE[id] === line);
  return own ? nameOf(own) : FILAMENT_LINE_LABELS[line];
}

const sellKey = (m: MaterialId) => `materials.${m}.sellPerGramPaise`;
const shownKey = (m: MaterialId) => `materials.${m}.costPerKgPaise`;
const spoolKey = (line: FilamentLine) => `internal.spoolListPriceInr.${line}`;

/** Every field, keyed by its path in the pricing input. */
function fieldDefs(nameOf: NameOf): Record<string, FieldDef> {
  const list: FieldDef[] = [
    { key: "setupFeePaise", label: "Setup fee per order", unit: "rupees", bound: B.setupFeePaise },
    ...MATERIAL_IDS.flatMap((m): FieldDef[] => [
      { key: sellKey(m), label: `${nameOf(m)}: customers pay`, unit: "rupees", suffix: "/ g", bound: B.sellPerGramPaise },
      { key: shownKey(m), label: `${nameOf(m)}: shown as filament`, unit: "rupees", suffix: "/ kg", bound: B.costPerKgPaise },
    ]),
    ...LINES.map((line): FieldDef => ({
      key: spoolKey(line),
      label: `${lineLabel(line, nameOf)}: your spool`,
      unit: "plain",
      suffix: "₹ / kg list",
      bound: B.spoolListPriceInr,
    })),
    { key: "electricityPerKwhPaise", label: "Electricity (shown)", unit: "rupees", suffix: "/ kWh", bound: B.electricityPerKwhPaise },
    { key: "internal.electricityPerKwhPaise", label: "Electricity (yours)", unit: "rupees", suffix: "/ kWh", bound: B.electricityPerKwhPaise },
    { key: "kwhPerHour", label: "Power draw (shown)", unit: "plain", suffix: "kWh / print-h", bound: B.kwhPerHour },
    { key: "internal.electricityKwhPerHour", label: "Power draw (yours)", unit: "plain", suffix: "kWh / print-h", bound: B.electricityKwhPerHour },
    { key: "maintenancePerGramPaise", label: "Maintenance (shown)", unit: "rupees", suffix: "/ g", bound: B.maintenancePerGramPaise },
    { key: "internal.maintenancePerHourPaise", label: "Maintenance (yours)", unit: "rupees", suffix: "/ print-h", bound: B.maintenancePerHourPaise },
    { key: "internal.gstRate", label: "GST on filament", unit: "percent", suffix: "%", bound: B.gstRate },
    { key: "internal.spoolShippingPaise", label: "Shipping per spool", unit: "rupees", bound: B.spoolShippingPaise },
    { key: "leadTime.printHoursPerDay", label: "Printing hours per day", unit: "plain", suffix: "h", bound: B.printHoursPerDay },
    { key: "leadTime.bufferDays", label: "Extra days (prep, QC, packing)", unit: "plain", suffix: "days", bound: B.bufferDays },
  ];
  return Object.fromEntries(list.map((f) => [f.key, f]));
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

const TH = "px-2 pb-2 text-left align-bottom text-[0.68rem] font-[650] uppercase tracking-[0.08em] text-faint";
const TD = "px-2 py-1.5 align-middle";

export function RatesEditor({
  pricing,
  materialNames,
}: {
  pricing: PricingInput;
  /** The shop's names for its own materials. */
  materialNames?: CustomMaterialNames;
}) {
  const router = useRouter();
  const nameOf: NameOf = (m) => materialName(m, materialNames);
  const defs = useMemo(() => fieldDefs((m) => materialName(m, materialNames)), [materialNames]);
  const initial = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of Object.values(defs)) out[f.key] = toText(getPath(pricing, f.key), f.unit);
    return out;
  }, [defs, pricing]);
  const [values, setValues] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUnnamed, setShowUnnamed] = useState(false);

  const stored = (key: string) => fromText(values[key] ?? "", defs[key]!.unit);
  const invalid = new Set(
    Object.values(defs)
      .filter((f) => {
        const v = stored(f.key);
        return v === undefined || !f.bound.safeParse(v).success;
      })
      .map((f) => f.key),
  );

  // Unnamed custom slots are off sale; tucked away unless one needs fixing.
  const named = MATERIAL_IDS.filter((m) => !isCustomMaterial(m) || materialNames?.[m]?.name);
  const unnamed = MATERIAL_IDS.filter((m) => !named.includes(m));
  const unnamedBad = unnamed.some((m) => [sellKey(m), shownKey(m), ...MATERIAL_LINES[m].map(spoolKey)].some((k) => invalid.has(k)));
  const unnamedOpen = showUnnamed || unnamedBad;

  // What a gram of a spool line lands at, from the form as it stands.
  const gstRate = stored("internal.gstRate");
  const spoolShippingPaise = stored("internal.spoolShippingPaise");
  const costPerGramPaise = (line: FilamentLine): number | null => {
    const list = stored(spoolKey(line));
    if (list === undefined || gstRate === undefined || spoolShippingPaise === undefined) return null;
    return spoolCostPerKgPaise(list, { ...INTERNAL_COST, gstRate, spoolShippingPaise }) / 1000;
  };

  const input = (key: string, width = "w-20") => {
    const f = defs[key]!;
    const bad = invalid.has(key);
    return (
      <span className="flex items-center gap-1">
        {f.unit === "rupees" ? <span className="text-faint">₹</span> : null}
        <input
          inputMode="decimal"
          value={values[key] ?? ""}
          aria-invalid={bad}
          aria-label={f.label}
          onChange={(e) => {
            setValues((v) => ({ ...v, [key]: e.target.value }));
            setDirty(true);
          }}
          className={`input-base ${width} px-2 py-1.5 text-right text-sm tabular-nums ${bad ? "border-[var(--accent)]" : ""}`}
        />
        {f.suffix ? <span className="whitespace-nowrap text-xs text-faint">{f.suffix}</span> : null}
      </span>
    );
  };

  /** Your cost per gram for a line, flagged when it isn't below the price. */
  const costCell = (line: FilamentLine, m: MaterialId): ReactNode => {
    const cost = costPerGramPaise(line);
    if (cost === null) return <span className="text-faint">—</span>;
    const sell = stored(sellKey(m));
    const under = sell !== undefined && cost >= sell;
    return (
      <span className={`tabular-nums ${under ? "text-accent" : "text-muted"}`} title={under ? "At or above what customers pay per gram" : undefined}>
        ₹{(cost / 100).toFixed(2)}
        <span className="text-xs text-faint"> / g</span>
        {under ? <span className="text-xs"> · not covered</span> : null}
      </span>
    );
  };

  const materialRows = (m: MaterialId) => {
    const lines = MATERIAL_LINES[m];
    const single = lines.length === 1 ? lines[0]! : null;
    return (
      <Fragment key={m}>
        <tr className="border-t border-line">
          <th scope="row" className={`${TD} text-left font-[600]`}>
            {nameOf(m)}
          </th>
          <td className={TD}>{input(sellKey(m))}</td>
          <td className={TD}>{input(shownKey(m), "w-24")}</td>
          <td className={`${TD} border-l border-line`}>{single ? input(spoolKey(single), "w-24") : null}</td>
          <td className={TD}>{single ? costCell(single, m) : null}</td>
        </tr>
        {single
          ? null
          : lines.map((line) => (
              <tr key={line}>
                <th scope="row" className={`${TD} pl-5 text-left text-xs font-[450] text-muted`}>
                  {lineLabel(line, nameOf)}
                </th>
                <td className={TD} />
                <td className={TD} />
                <td className={`${TD} border-l border-line`}>{input(spoolKey(line), "w-24")}</td>
                <td className={TD}>{costCell(line, m)}</td>
              </tr>
            ))}
      </Fragment>
    );
  };

  const save = async () => {
    if (invalid.size > 0) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      for (const f of Object.values(defs)) setPath(body, f.key, fromText(values[f.key]!, f.unit));
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
        {/* A fieldset is min-content wide by default; min-w-0 lets the tables scroll inside it at phone widths. */}
        <fieldset className="min-w-0">
          <legend className="text-sm font-[650]">Materials</legend>
          <p className="mt-0.5 text-xs text-faint">
            Every quote is grams × the material&apos;s rate, plus one setup fee per order. &ldquo;Shown as
            filament&rdquo; is only a line on the pricing page and each quote, already inside the rate. Your spool
            prices and costs are never shown to customers: a gram costs you the list price + GST + shipping, ÷ 1000.
          </p>
          <label className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted">Setup fee per order</span>
            {input("setupFeePaise")}
          </label>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-sm">
              <thead>
                <tr>
                  <th className={TH} scope="col">
                    Material
                  </th>
                  <th className={TH} scope="col" colSpan={2}>
                    Customers see
                  </th>
                  <th className={`${TH} border-l border-line`} scope="col" colSpan={2}>
                    Your real cost
                  </th>
                </tr>
                <tr>
                  <th className={TH} />
                  <th className={TH} scope="col">
                    Price per gram
                  </th>
                  <th className={TH} scope="col">
                    Shown as filament
                  </th>
                  <th className={`${TH} border-l border-line`} scope="col">
                    Spool (list)
                  </th>
                  <th className={TH} scope="col">
                    Filament per gram
                  </th>
                </tr>
              </thead>
              <tbody>
                {named.map(materialRows)}
                {unnamed.length > 0 ? (
                  <tr className="border-t border-line">
                    <td colSpan={5} className={TD}>
                      <button
                        type="button"
                        className="text-xs text-faint underline decoration-dotted underline-offset-2"
                        aria-expanded={unnamedOpen}
                        onClick={() => setShowUnnamed((v) => !v)}
                        disabled={unnamedBad}
                      >
                        {unnamedOpen ? "Hide" : "Show"} {unnamed.length} unnamed material slot{unnamed.length === 1 ? "" : "s"} (name
                        them in Your own materials)
                      </button>
                    </td>
                  </tr>
                ) : null}
                {unnamedOpen ? unnamed.map(materialRows) : null}
              </tbody>
            </table>
          </div>
        </fieldset>

        <fieldset className="min-w-0">
          <legend className="text-sm font-[650]">Running costs</legend>
          <p className="mt-0.5 text-xs text-faint">
            The pricing page explains the rate with the left column; the profit estimate uses the right.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-sm">
              <thead>
                <tr>
                  <th className={TH} />
                  <th className={TH} scope="col">
                    Customers see
                  </th>
                  <th className={`${TH} border-l border-line`} scope="col">
                    Your real cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Electricity", "electricityPerKwhPaise", "internal.electricityPerKwhPaise"],
                    ["Printer power draw", "kwhPerHour", "internal.electricityKwhPerHour"],
                    ["Maintenance", "maintenancePerGramPaise", "internal.maintenancePerHourPaise"],
                    ["GST on filament", null, "internal.gstRate"],
                    ["Shipping per spool", null, "internal.spoolShippingPaise"],
                  ] as const
                ).map(([label, shown, yours]) => (
                  <tr key={label} className="border-t border-line">
                    <th scope="row" className={`${TD} text-left font-[600]`}>
                      {label}
                    </th>
                    <td className={TD}>{shown ? input(shown) : <span className="text-faint">—</span>}</td>
                    <td className={`${TD} border-l border-line`}>{input(yours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </fieldset>

        <fieldset className="min-w-0">
          <legend className="text-sm font-[650]">Lead time</legend>
          <p className="mt-0.5 text-xs text-faint">Drives the &ldquo;ready by&rdquo; date on every quote.</p>
          <div className="mt-3 grid gap-x-5 gap-y-2.5 sm:grid-cols-2">
            {(["leadTime.printHoursPerDay", "leadTime.bufferDays"] as const).map((key) => (
              <label key={key} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 text-muted">{defs[key]!.label}</span>
                {input(key)}
              </label>
            ))}
          </div>
        </fieldset>

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
