"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { FAQ_LIMITS, type FaqEntry, type FaqSettings } from "@print/shared";

const newId = () => `custom-${Math.random().toString(36).slice(2, 10)}`;

/** The FAQ page is written from the shop's settings; here the owner hides
 *  generated answers that don't fit and adds their own (policies, services …). */
export function FaqEditor({ generated, settings }: { generated: FaqEntry[]; settings: FaqSettings }) {
  const router = useRouter();
  const [hidden, setHidden] = useState(() => new Set(settings.hidden));
  const [custom, setCustom] = useState(settings.custom);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setDirty(true);
  };
  const update = (i: number, patch: Partial<FaqEntry>) =>
    change(() => setCustom((list) => list.map((e, j) => (j === i ? { ...e, ...patch } : e))))(null);
  const move = (i: number, by: number) =>
    change(() =>
      setCustom((list) => {
        const next = [...list];
        const [item] = next.splice(i, 1);
        next.splice(i + by, 0, item!);
        return next;
      }),
    )(null);

  const incomplete = custom.some((e) => !e.q.trim() || !e.a.trim());

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/faq", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({
          custom: custom.map((e) => ({ id: e.id, q: e.q.trim(), a: e.a.trim() })),
          hidden: [...hidden],
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(data?.error?.message ?? "Saving the FAQ failed.");
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
        <span>FAQ · questions page</span>
        <span className="text-faint">edit</span>
      </summary>
      <div className="space-y-6 border-t border-line p-4">
        <fieldset>
          <legend className="text-sm font-[650]">Answered from your settings</legend>
          <p className="mt-0.5 text-xs text-faint">
            These follow your materials, colours, printer, lead time and contact details automatically. Untick any that don&apos;t fit your shop.
          </p>
          <ul className="mt-3 space-y-1.5">
            {generated.map((e) => (
              <li key={e.id}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!hidden.has(e.id)}
                    onChange={(ev) =>
                      change(() =>
                        setHidden((h) => {
                          const next = new Set(h);
                          if (ev.target.checked) next.delete(e.id);
                          else next.add(e.id);
                          return next;
                        }),
                      )(null)
                    }
                    className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
                  />
                  <span className="min-w-0">
                    <span className={hidden.has(e.id) ? "text-faint line-through" : "font-[600]"}>{e.q}</span>
                    <span className="block text-xs leading-5 text-faint">{e.a}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-[650]">Your own questions</legend>
          <p className="mt-0.5 text-xs text-faint">
            Shown after the ones above — good for your policies: custom colours, design help, payment methods, pickup hours.
          </p>
          <div className="mt-3 space-y-3">
            {custom.map((e, i) => (
              <div key={e.id} className="rounded-lg border border-line p-3">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={e.q}
                    maxLength={FAQ_LIMITS.question}
                    placeholder="Question"
                    aria-label={`Question ${i + 1}`}
                    onChange={(ev) => update(i, { q: ev.target.value })}
                    className="input-base min-w-0 flex-1 py-1.5 text-sm font-[600]"
                  />
                  <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="btn-ghost p-1.5 disabled:opacity-30">
                    <ArrowUp className="size-4" />
                  </button>
                  <button type="button" aria-label="Move down" disabled={i === custom.length - 1} onClick={() => move(i, 1)} className="btn-ghost p-1.5 disabled:opacity-30">
                    <ArrowDown className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete question ${i + 1}`}
                    onClick={() => change(() => setCustom((list) => list.filter((_, j) => j !== i)))(null)}
                    className="btn-ghost p-1.5"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
                <textarea
                  value={e.a}
                  rows={3}
                  maxLength={FAQ_LIMITS.answer}
                  placeholder="Answer"
                  aria-label={`Answer ${i + 1}`}
                  onChange={(ev) => update(i, { a: ev.target.value })}
                  className="input-base mt-2 py-2 text-sm"
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={custom.length >= FAQ_LIMITS.entries}
            onClick={() => change(() => setCustom((list) => [...list, { id: newId(), q: "", a: "" }]))(null)}
            className="btn-ghost mt-3 text-sm disabled:opacity-40"
          >
            <Plus className="size-4" /> Add a question
          </button>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={save} disabled={!dirty || saving || incomplete} className="btn-pill text-sm disabled:opacity-40">
            {saving ? "Saving…" : "Save FAQ"}
          </button>
          {incomplete ? (
            <span className="text-xs text-accent">Every question needs an answer.</span>
          ) : dirty && !saving ? (
            <span className="text-xs text-faint">Unsaved changes</span>
          ) : null}
          {error ? <span className="text-xs text-accent">{error}</span> : null}
        </div>
      </div>
    </details>
  );
}
