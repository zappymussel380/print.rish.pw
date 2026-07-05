"use client";

import {
  INFILL_MAX_PCT,
  INFILL_MIN_PCT,
  LAYER_HEIGHTS_UM,
  MATERIAL_IDS,
  MAX_QUANTITY,
  type ModelConfig,
  SUPPORT_MODES,
} from "@print/shared";
import { useQuoteStore } from "@/lib/quote-store";

const SUPPORT_LABEL: Record<(typeof SUPPORT_MODES)[number], string> = {
  auto: "Auto",
  off: "Off",
  always: "Always",
};

export function SettingsPanel({ modelKey, config }: { modelKey: string; config: ModelConfig }) {
  const update = useQuoteStore((s) => s.updateConfig);
  const set = (patch: Partial<ModelConfig>) => update(modelKey, patch);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Material">
        <Segmented
          value={config.material}
          options={MATERIAL_IDS.map((m) => ({ value: m, label: m }))}
          onChange={(v) => set({ material: v })}
        />
      </Field>

      <Field label="Colour">
        <Segmented
          value={config.colour}
          options={[
            { value: "black", label: "Black" },
            { value: "white", label: "White" },
          ]}
          onChange={(v) => set({ colour: v })}
        />
      </Field>

      <Field label="Layer height">
        <Segmented
          value={config.layerHeightUm}
          options={LAYER_HEIGHTS_UM.map((um) => ({ value: um, label: `${(um / 1000).toFixed(2)}mm` }))}
          onChange={(v) => set({ layerHeightUm: v })}
        />
      </Field>

      <Field label="Supports">
        <Segmented
          value={config.supports}
          options={SUPPORT_MODES.map((s) => ({ value: s, label: SUPPORT_LABEL[s] }))}
          onChange={(v) => set({ supports: v })}
        />
      </Field>

      <Field label={`Infill · ${config.infillPct}%`}>
        <input
          type="range"
          min={INFILL_MIN_PCT}
          max={INFILL_MAX_PCT}
          step={5}
          value={config.infillPct}
          onChange={(e) => set({ infillPct: Number(e.target.value) })}
          aria-label={`Infill density ${config.infillPct} percent`}
          className="range-accent w-full"
        />
      </Field>

      <Field label="Quantity">
        <div className="flex items-center gap-2">
          <Stepper
            value={config.quantity}
            onChange={(q) => set({ quantity: q })}
            min={1}
            max={MAX_QUANTITY}
          />
        </div>
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-[0.7rem] font-[650] uppercase tracking-[0.14em] text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex w-full rounded-full border border-line p-0.5" role="group">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded-full px-3 py-1.5 text-sm font-[600] transition-colors ${
              active ? "text-bg" : "text-muted hover:text-text"
            }`}
            style={active ? { background: "var(--accent)" } : undefined}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Stepper({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  return (
    <div className="inline-flex items-center rounded-full border border-line">
      <button
        type="button"
        aria-label="Decrease quantity"
        onClick={() => onChange(clamp(value - 1))}
        disabled={value <= min}
        className="grid size-9 place-items-center rounded-l-full text-muted transition-colors hover:text-accent disabled:opacity-30"
      >
        −
      </button>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value) || min))}
        aria-label="Quantity"
        className="w-12 border-x border-line bg-transparent py-1.5 text-center text-sm font-[600] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      <button
        type="button"
        aria-label="Increase quantity"
        onClick={() => onChange(clamp(value + 1))}
        disabled={value >= max}
        className="grid size-9 place-items-center rounded-r-full text-muted transition-colors hover:text-accent disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}
