"use client";

import { useId, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import {
  describePick,
  pickMaterial,
  type MaterialId,
  type NeedId,
  type PublicMaterial,
  type PublicMaterialHelper,
} from "@print/shared";

/**
 * "Help me choose": the customer ticks what matters for the part and the
 * material the shop rates best on those needs is selected for them, with one
 * line saying why. They can still change the material by hand; the line then
 * goes, since it no longer describes what's selected.
 */
export function MaterialHelper({
  helper,
  materials,
  rates,
  current,
  onPick,
}: {
  helper: PublicMaterialHelper;
  /** The materials customers can pick, in catalog order. */
  materials: readonly PublicMaterial[];
  rates: Partial<Record<MaterialId, { sellPerGramPaise: number }>>;
  current: MaterialId;
  onPick: (id: MaterialId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<NeedId[]>([]);
  const [picked, setPicked] = useState<{ id: MaterialId; reason: string } | null>(null);
  const [noMatch, setNoMatch] = useState(false);
  const panelId = useId();

  const toggle = (need: NeedId) => {
    const next = selected.includes(need) ? selected.filter((n) => n !== need) : [...selected, need];
    setSelected(next);
    const candidates = materials.map((m) => ({ id: m.id, sellPerGramPaise: rates[m.id]?.sellPerGramPaise ?? 0 }));
    const pick = pickMaterial(next, candidates, helper.scores);
    setNoMatch(next.length > 0 && pick === null);
    if (!pick) {
      setPicked(null);
      return;
    }
    const name = materials.find((m) => m.id === pick.id)?.name ?? pick.id;
    setPicked({ id: pick.id, reason: describePick(pick, name, helper.needs) });
    if (pick.id !== current) onPick(pick.id);
  };

  const reason = picked && picked.id === current ? picked.reason : null;

  return (
    <div className="sm:col-span-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-xs font-[600] text-accent hover:underline"
      >
        <Sparkles strokeWidth={1.8} className="h-3.5 w-3.5" />
        Not sure which material? Help me choose
        <ChevronDown strokeWidth={2} className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div id={panelId} className="mt-2.5">
          <p className="text-xs text-muted">Tick what matters for this part; we&apos;ll pick the material for you.</p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="What matters for this part">
            {helper.needs.map((need) => {
              const on = selected.includes(need.id);
              return (
                <button
                  key={need.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(need.id)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    on ? "border-accent bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]" : "border-line hover:border-muted"
                  }`}
                >
                  <span className={`block text-sm font-[650] ${on ? "text-accent" : "text-text"}`}>{need.label}</span>
                  {need.description ? <span className="mt-0.5 block text-[0.7rem] leading-4 text-muted">{need.description}</span> : null}
                </button>
              );
            })}
          </div>
          <p className="mt-2 min-h-5 text-xs text-muted" role="status" aria-live="polite">
            {reason ? `We picked ${reason}.` : noMatch ? "None of our materials is made for that — ask us on WhatsApp." : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
}
