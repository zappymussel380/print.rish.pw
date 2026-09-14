"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import {
  defaultLayerHeight,
  groupColours,
  INFILL_MAX_PCT,
  INFILL_MIN_PCT,
  layerHeightLabel,
  type LayerHeightUm,
  type MaterialId,
  materialName,
  MAX_QUANTITY,
  type ModelConfig,
  SUPPORT_MODES,
  swatchBackground,
} from "@print/shared";
import { useQuoteStore } from "@/lib/quote-store";
import { useCatalog } from "@/lib/use-catalog";

/** Past this many enabled materials a segmented control no longer fits a phone. */
const MAX_SEGMENTED_MATERIALS = 3;

const MATERIAL_INFO =
  "PLA is stiff and easy to print — ideal for prototypes, models and display pieces. PETG is tougher and more heat- and moisture-resistant — better for functional or outdoor parts.";
const PREMIUM_INFO =
  " Aesthetic PLA covers silk, matte, metallic, starlight, glow and wood finishes; the carbon-fibre and premium PETG tiers suit stiff functional parts and translucent pieces. Each is charged at its own per-gram rate.";
const PREMIUM_TIERS: readonly MaterialId[] = ["PLA_AESTHETIC", "PLA_CF", "PETG_PREMIUM"];
const ENGINEERING_INFO =
  " ABS and ASA handle heat best (around 95–100 °C) and are tough enough for functional parts; ASA also resists sun and weather, so it is the pick for outdoor parts that must last.";
const ENGINEERING_TIERS: readonly MaterialId[] = ["ABS", "ASA"];

const LAYER_HEIGHT_INFO: Record<LayerHeightUm, string> = {
  120: "0.12 mm gives the finest detail but prints slowest",
  160: "0.16 mm balances detail and print time",
  200: "0.20 mm is the fastest and most economical, with more visible layer lines",
};

/** What the layer-height tip says about the heights this shop offers. */
function layerHeightInfo(offered: readonly LayerHeightUm[], fallback: LayerHeightUm): string {
  if (offered.length === 1) return `The thickness of each printed layer. Every part is printed at ${layerHeightLabel(offered[0]!)}.`;
  const parts = offered.map((um) => (um === fallback ? `${LAYER_HEIGHT_INFO[um]} (the default)` : LAYER_HEIGHT_INFO[um]));
  return `The thickness of each printed layer. ${parts.join("; ")}.`;
}

const SUPPORT_LABEL: Record<(typeof SUPPORT_MODES)[number], string> = {
  auto: "Auto",
  off: "Off",
  always: "Always",
};

export function SettingsPanel({
  modelKey,
  config,
  sourceConfig,
  lockedConfig,
}: {
  modelKey: string;
  config: ModelConfig;
  sourceConfig?: Partial<ModelConfig>;
  lockedConfig?: Partial<Record<keyof ModelConfig, true>>;
}) {
  const update = useQuoteStore((s) => s.updateConfig);
  const set = (patch: Partial<ModelConfig>) => update(modelKey, patch);
  const supportLocked = lockedConfig?.supports === true;

  const catalog = useCatalog();
  const enabledMaterials = catalog.materials.filter((m) => m.enabled);
  const currentMaterial = catalog.materials.find((m) => m.id === config.material);
  const enabledColours = (currentMaterial?.colours ?? []).filter((c) => c.enabled);
  const layerHeights = catalog.layerHeights;
  const fallbackLayer = defaultLayerHeight(layerHeights);
  const anyEnabled = (ids: readonly MaterialId[]) => enabledMaterials.some((m) => ids.includes(m.id));
  const materialInfo =
    MATERIAL_INFO +
    (anyEnabled(PREMIUM_TIERS) ? PREMIUM_INFO : "") +
    (anyEnabled(ENGINEERING_TIERS) ? ENGINEERING_INFO : "");

  const chooseMaterial = (v: MaterialId) => {
    const next = catalog.materials.find((m) => m.id === v);
    const nextColours = (next?.colours ?? []).filter((c) => c.enabled);
    const firstColour = nextColours[0]?.id;
    const keepColour = nextColours.some((c) => c.id === config.colour);
    set({
      material: v,
      ...(keepColour || firstColour === undefined ? {} : { colour: firstColour }),
    });
  };

  // Keep the selection valid as availability loads or the operator changes it:
  // fall back to the first enabled material, and reset the colour when it isn't
  // offered in the chosen material.
  useEffect(() => {
    if (enabledMaterials.length === 0) return;
    if (!enabledMaterials.some((m) => m.id === config.material)) {
      set({ material: enabledMaterials[0]!.id });
    }
  }, [catalog, config.material]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!layerHeights.includes(config.layerHeightUm)) set({ layerHeightUm: fallbackLayer });
  }, [catalog, config.layerHeightUm]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (enabledColours.length === 0) return;
    if (!enabledColours.some((c) => c.id === config.colour)) {
      set({ colour: enabledColours[0]!.id });
    }
  }, [catalog, config.material, config.colour]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        label="Material"
        info={materialInfo}
        notice={sourceNotice("material", config, sourceConfig)}
      >
        {enabledMaterials.length > MAX_SEGMENTED_MATERIALS ? (
          <select
            value={config.material}
            onChange={(e) => chooseMaterial(e.target.value as MaterialId)}
            className="input-base w-full text-sm"
          >
            {enabledMaterials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : (
          <Segmented
            value={config.material}
            options={enabledMaterials.map((m) => ({ value: m.id as MaterialId, label: m.name }))}
            onChange={chooseMaterial}
          />
        )}
      </Field>

      <Field
        label="Colour"
        info="The filament colour your part is printed in. Colour has no effect on the price — ask on WhatsApp if you'd like a colour that isn't listed."
      >
        {enabledColours.length > 0 ? (
          <ColourSelect
            value={config.colour}
            options={enabledColours}
            onChange={(v) => set({ colour: v })}
          />
        ) : (
          <p className="text-sm text-muted">No colours available — please ask on WhatsApp.</p>
        )}
      </Field>

      <Field
        label="Layer height"
        info={layerHeightInfo(layerHeights, fallbackLayer)}
        notice={layerHeights.length > 1 ? sourceNotice("layerHeightUm", config, sourceConfig) : undefined}
      >
        {layerHeights.length > 1 ? (
          <Segmented
            value={config.layerHeightUm}
            options={layerHeights.map((um) => ({ value: um, label: `${(um / 1000).toFixed(2)}mm` }))}
            onChange={(v) => set({ layerHeightUm: v })}
          />
        ) : (
          // Nothing to choose: say what every part is printed at.
          <span className="block text-sm text-muted">{layerHeightLabel(layerHeights[0]!)}</span>
        )}
      </Field>

      <Field
        label="Supports"
        info={
          <>
            Temporary scaffolding printed under steep overhangs so they don't droop or fail.
            Turning supports off can lower the price, but parts with overhangs may fail to print
            without them. Leave this on Auto because it adds supports only where the model actually
            needs them.
            {supportLocked
              ? " Support mode is locked because this 3MF plate included support instructions. We keep it as imported so the generated print matches the file's intended setup."
              : ""}
          </>
        }
        notice={sourceNotice("supports", config, sourceConfig)}
      >
        <Segmented
          value={config.supports}
          options={SUPPORT_MODES.map((s) => ({ value: s, label: SUPPORT_LABEL[s] }))}
          disabledValues={supportLocked ? SUPPORT_MODES.filter((s) => s !== config.supports) : []}
          onChange={(v) => set({ supports: v })}
        />
      </Field>

      <Field label={`Infill · ${config.infillPct}%`} notice={sourceNotice("infillPct", config, sourceConfig)}>
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

function Field({
  label,
  info,
  notice,
  children,
}: {
  label: string;
  info?: React.ReactNode;
  notice?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 flex items-center gap-1.5 text-[0.7rem] font-[650] uppercase tracking-[0.14em] text-muted">
        {label}
        {info ? <InfoTip label={label}>{info}</InfoTip> : null}
      </span>
      {children}
      {notice ? (
        <span className="mt-2 block rounded-md border border-accent/35 bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-3 py-2 text-xs leading-5 text-muted">
          {notice}
        </span>
      ) : null}
    </label>
  );
}

function sourceNotice(
  key: "material" | "layerHeightUm" | "infillPct" | "supports",
  config: ModelConfig,
  sourceConfig?: Partial<ModelConfig>,
): string | undefined {
  const sourceValue = sourceConfig?.[key];
  if (sourceValue === undefined || config[key] === sourceValue) return undefined;
  return `Changed from the 3MF profile (${sourceValueLabel(key, sourceValue)}). This may print differently than the uploaded file intended.`;
}

function sourceValueLabel(
  key: "material" | "layerHeightUm" | "infillPct" | "supports",
  value: NonNullable<Partial<ModelConfig>[typeof key]>,
): string {
  if (key === "layerHeightUm" && typeof value === "number") return `${(value / 1000).toFixed(2)}mm`;
  if (key === "infillPct" && typeof value === "number") return `${value}%`;
  if (key === "material" && typeof value === "string") return materialName(value);
  if (key === "supports" && typeof value === "string") {
    return value in SUPPORT_LABEL ? SUPPORT_LABEL[value as keyof typeof SUPPORT_LABEL] : value;
  }
  return String(value);
}

/** A tap/click info affordance next to a setting label. Opens a small popover
 *  explaining the option; closes on outside click, Escape or scroll. Kept as a
 *  popover (not a hover tooltip) so it works on touch devices too, and rendered
 *  through a portal with fixed positioning so it escapes the model card's
 *  `overflow-hidden` clip. It flips above the icon near the viewport bottom and
 *  clamps horizontally so it never runs off-screen. */
function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; above: boolean } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hover opens; leaving the icon or popover closes after a short grace period
  // (so the pointer can travel from the icon to the popover without it closing).
  const openNow = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setOpen(true);
  };
  const closeSoon = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => void (hoverTimer.current && clearTimeout(hoverTimer.current)), []);

  useEffect(() => {
    if (!open) return;

    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (!b) return;
      const half = 116;
      const margin = 12;
      const left = Math.max(
        margin + half,
        Math.min(window.innerWidth - margin - half, b.left + b.width / 2),
      );
      const above = b.bottom + 8 + 170 > window.innerHeight;
      setCoords({ top: above ? b.top - 8 : b.bottom + 8, left, above });
    };
    place();

    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const close = () => setOpen(false);

    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
        aria-label={`What is ${label.toLowerCase()}?`}
        aria-expanded={open}
        className="grid size-4 place-items-center rounded-full text-faint transition-colors hover:text-accent"
      >
        <Info strokeWidth={2} className="size-3.5" />
      </button>
      {open && coords
        ? createPortal(
            <span
              ref={popRef}
              role="tooltip"
              onMouseEnter={openNow}
              onMouseLeave={closeSoon}
              style={{
                position: "fixed",
                top: coords.top,
                left: coords.left,
                transform: coords.above ? "translate(-50%, -100%)" : "translateX(-50%)",
              }}
              className="z-50 w-56 max-w-[min(16rem,72vw)] rounded-lg border border-line bg-surface p-3 text-[0.72rem] font-normal normal-case leading-5 tracking-normal text-muted shadow-[0_10px_30px_rgba(0,0,0,0.45)]"
            >
              {children}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  disabledValues = [],
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  disabledValues?: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex w-full rounded-full border border-line p-0.5" role="group">
      {options.map((o) => {
        const active = o.value === value;
        const disabled = disabledValues.includes(o.value);
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded-full px-3 py-1.5 text-sm font-[600] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
              active ? "text-bg" : "text-muted hover:text-text disabled:hover:text-muted"
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

/** A wrapping grid of colour swatches; the selected swatch is ringed and its
 *  name shown beneath. Each swatch is a labelled toggle button for a11y. Tiers
 *  that span several filament lines (matte, silk …) get a label per line. */
function ColourSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { id: string; name: string; hex: string; stops?: readonly string[]; group?: string }[];
  onChange: (id: string) => void;
}) {
  const selected = options.find((o) => o.id === value);
  return (
    <div>
      <div className="space-y-2.5" role="group" aria-label="Colour">
        {groupColours(options).map(({ group, colours }) => (
          <div key={group ?? "all"}>
            {group ? (
              <span className="mb-1.5 block text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
                {group}
              </span>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {colours.map((o) => {
                const active = o.id === value;
                return (
                  <button
                    key={o.id}
                    type="button"
                    aria-pressed={active}
                    aria-label={o.name}
                    title={o.name}
                    onClick={() => onChange(o.id)}
                    className={`size-7 rounded-full border border-line transition-transform hover:scale-110 ${
                      active ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : ""
                    }`}
                    style={{ background: swatchBackground(o) }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <span className="mt-2 block text-xs text-muted">{selected?.name ?? "—"}</span>
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
