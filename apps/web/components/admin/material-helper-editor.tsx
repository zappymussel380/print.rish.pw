"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import {
  BUILT_IN_NEED_COPY,
  BUILT_IN_NEEDS,
  NEED_SCORE_LABELS,
  OWN_NEED_LIMITS,
  OWN_NEEDS,
  type MaterialHelperSettings,
  type MaterialId,
  type NeedId,
  type NeedScore,
  type OwnNeed,
  type PublicMaterial,
} from "@print/shared";

/** "Help me choose" on the quote page: which needs customers can tick (the
 *  four built in, each switchable, plus up to four of the shop's own) and how
 *  each material on sale rates on every one. The best-rated material for what
 *  a customer ticks is picked for them — cheapest on a tie. */
export function MaterialHelperEditor({ initial, catalog }: { initial: MaterialHelperSettings; catalog: { materials: PublicMaterial[] } }) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = (fn: (draft: MaterialHelperSettings) => void) => {
    setState((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
    setError(null);
  };

  const onSale = catalog.materials.filter((m) => m.enabled);
  const ownIds = OWN_NEEDS.filter((id) => state.own[id]);
  const freeSlot = OWN_NEEDS.find((id) => !state.own[id]);
  const columns: { id: NeedId; label: string }[] = [
    ...BUILT_IN_NEEDS.filter((id) => state.builtIn[id]).map((id) => ({ id, label: BUILT_IN_NEED_COPY[id].label })),
    ...ownIds.filter((id) => state.own[id]!.enabled).map((id) => ({ id, label: state.own[id]!.label || "Unnamed" })),
  ];
  const blankLabel = ownIds.some((id) => !state.own[id]!.label.trim());
  const liveNeeds = columns.length;

  const addNeed = () => {
    if (!freeSlot) return;
    mutate((d) => {
      d.own[freeSlot] = { label: "", description: "", enabled: true };
    });
  };
  const removeNeed = (id: OwnNeed) =>
    mutate((d) => {
      delete d.own[id];
      // A need added later in this slot starts unrated, not with these scores.
      for (const scores of Object.values(d.scores)) if (scores) delete scores[id];
    });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/material-helper", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify(state),
      });
      const data = (await res.json().catch(() => null)) as (MaterialHelperSettings & { error?: { message?: string } }) | null;
      if (!res.ok || !data) {
        setError(data?.error?.message ?? "Saving the material helper failed.");
        return;
      }
      setState(data);
      setDirty(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  const field = "input-base py-1.5 text-sm";
  return (
    <details className="tile mt-4 p-0 [&_summary]:list-none">
      <summary className="flex cursor-pointer items-center justify-between p-4 text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
        <span>Material helper · &ldquo;Help me choose&rdquo;</span>
        <span className="text-faint">{state.enabled ? `${liveNeeds} need${liveNeeds === 1 ? "" : "s"}` : "off"}</span>
      </summary>
      <div className="space-y-5 border-t border-line p-4">
        <p className="text-xs text-faint">
          On the quote page, customers who aren&apos;t sure which material to pick can tick what matters for their part.
          The material on sale that rates best on those needs is picked for them (the cheaper one on a tie), with a line
          saying why. They can still change it.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={(e) => mutate((d) => void (d.enabled = e.target.checked))}
            className="size-4 accent-[var(--accent)]"
          />
          Show &ldquo;Help me choose&rdquo; to customers
        </label>

        <div>
          <p className="text-sm font-[600]">Needs</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {BUILT_IN_NEEDS.map((id) => (
              <label key={id} className="flex items-start gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={state.builtIn[id]}
                  onChange={(e) => mutate((d) => void (d.builtIn[id] = e.target.checked))}
                  className="mt-0.5 size-4 accent-[var(--accent)]"
                />
                <span>
                  <span className="block font-[600]">{BUILT_IN_NEED_COPY[id].label}</span>
                  <span className="block text-xs text-muted">{BUILT_IN_NEED_COPY[id].description}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <p className="text-sm font-[600]">Your own needs</p>
          <p className="mt-1 text-xs text-faint">Up to four more, such as &ldquo;Food contact&rdquo; or &ldquo;Flexible&rdquo;. Rate each material on them below.</p>
          <div className="mt-2 space-y-2">
            {ownIds.map((id) => {
              const need = state.own[id]!;
              return (
                <div key={id} className="grid gap-2 rounded-lg border border-line p-2.5 sm:grid-cols-[auto_minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-center">
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={need.enabled}
                      onChange={(e) => mutate((d) => void (d.own[id]!.enabled = e.target.checked))}
                      className="size-4 accent-[var(--accent)]"
                    />
                    On
                  </label>
                  <input
                    value={need.label}
                    maxLength={OWN_NEED_LIMITS.label}
                    placeholder="Name, e.g. Flexible"
                    aria-label="Need name"
                    aria-invalid={!need.label.trim()}
                    onChange={(e) => mutate((d) => void (d.own[id]!.label = e.target.value))}
                    className={`${field} ${!need.label.trim() ? "border-[var(--danger)]" : ""}`}
                  />
                  <input
                    value={need.description}
                    maxLength={OWN_NEED_LIMITS.description}
                    placeholder="What it means for the part (optional)"
                    aria-label="Need description"
                    onChange={(e) => mutate((d) => void (d.own[id]!.description = e.target.value))}
                    className={field}
                  />
                  <button
                    type="button"
                    onClick={() => removeNeed(id)}
                    className="justify-self-end rounded-md p-2 text-faint transition-colors hover:text-danger"
                    aria-label={`Remove ${need.label || "this need"}`}
                  >
                    <Trash2 strokeWidth={1.8} className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
          {freeSlot ? (
            <button type="button" onClick={addNeed} className="btn-ghost mt-2 text-sm">
              <Plus strokeWidth={1.8} className="h-4 w-4" /> Add a need
            </button>
          ) : null}
        </div>

        <div>
          <p className="text-sm font-[600]">How each material rates</p>
          <p className="mt-1 text-xs text-faint">
            Materials appear here once they&apos;re on sale (Catalog, above). &ldquo;—&rdquo; means it&apos;s never picked for that need.
          </p>
          {onSale.length === 0 || columns.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Switch on a material and a need to rate them.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[0.68rem] uppercase tracking-[0.1em] text-faint">
                    <th className="py-2 pr-3 font-[650]">Material</th>
                    {columns.map((c) => (
                      <th key={c.id} className="px-2 py-2 font-[650]">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {onSale.map((m) => (
                    <tr key={m.id} className="border-b border-line">
                      <td className="py-2 pr-3 font-[600]">{m.name}</td>
                      {columns.map((c) => (
                        <td key={c.id} className="px-2 py-1.5">
                          <select
                            value={state.scores[m.id as MaterialId]?.[c.id] ?? 0}
                            onChange={(e) =>
                              mutate((d) => {
                                const scores = (d.scores[m.id as MaterialId] ??= {});
                                scores[c.id] = Number(e.target.value) as NeedScore;
                              })
                            }
                            aria-label={`${m.name}: ${c.label}`}
                            className="input-base w-auto px-2 py-1 text-xs"
                          >
                            {([0, 1, 2, 3] as const).map((score) => (
                              <option key={score} value={score}>
                                {NEED_SCORE_LABELS[score]}
                              </option>
                            ))}
                          </select>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={save} disabled={!dirty || saving || blankLabel} className="btn-pill text-sm disabled:opacity-40">
            {saving ? "Saving…" : "Save material helper"}
          </button>
          {error ? (
            <span className="text-xs text-danger" role="alert">
              {error}
            </span>
          ) : blankLabel ? (
            <span className="text-xs text-danger">Name each of your own needs, or remove it.</span>
          ) : dirty ? (
            <span className="text-xs text-faint">Unsaved changes</span>
          ) : null}
        </div>
      </div>
    </details>
  );
}
