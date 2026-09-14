"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Pencil, Search, Trash2, X } from "lucide-react";
import {
  CUSTOM_COLOUR_GROUP,
  CUSTOM_COLOUR_NAME_MAX,
  HEX_COLOUR_RE,
  LAYER_HEIGHTS_UM,
  colourShortName,
  formatPaise,
  groupColours,
  layerHeightLabel,
  newCustomColourId,
  swatchBackground,
  type Catalog,
  type CustomColour,
  type LayerHeightUm,
  type MaterialId,
  type PublicColour,
  type PublicMaterial,
} from "@print/shared";

interface CatalogEditState {
  materials: Record<string, boolean>;
  colours: Record<string, Record<string, boolean>>;
  customColours: CustomColour[];
  layerHeights: LayerHeightUm[];
}

type EditorCatalog = { materials: PublicMaterial[]; layerHeights: LayerHeightUm[] };

function toEditState(catalog: EditorCatalog): CatalogEditState {
  const materials: Record<string, boolean> = {};
  const colours: Record<string, Record<string, boolean>> = {};
  const customColours: CustomColour[] = [];
  for (const m of catalog.materials) {
    materials[m.id] = m.enabled;
    const row: Record<string, boolean> = {};
    for (const c of m.colours) {
      row[c.id] = c.enabled;
      if (c.custom) customColours.push({ id: c.id, name: c.name, hex: c.hex, material: m.id });
    }
    colours[m.id] = row;
  }
  return { materials, colours, customColours, layerHeights: [...catalog.layerHeights] };
}

/** A material's colours as the editor shows them: its supplier palette (fixed)
 *  followed by its custom colours from the live edit state, so a colour added
 *  or renamed here appears before it is saved. */
function editorColours(m: PublicMaterial, customs: readonly CustomColour[]): PublicColour[] {
  const palette = m.colours.filter((c) => !c.custom);
  return [
    ...palette,
    ...customs
      .filter((c) => c.material === m.id)
      .map(
        (c): PublicColour => ({
          id: c.id,
          name: c.name,
          hex: c.hex,
          ...(palette.length > 0 ? { group: CUSTOM_COLOUR_GROUP } : {}),
          custom: true,
          enabled: false,
        }),
      ),
  ];
}

/** Enable/disable materials and, per material, each colour — the Numakers
 *  palette plus colours the admin defines by hex code (the only kind ABS and
 *  ASA have) — and the layer heights customers may pick. Saves the whole
 *  availability blob at once. Each material folds
 *  away (switched-off tiers start folded), and the filter narrows every tier at
 *  once — All/None then act on just the matching colours, e.g. "silk" → All. */
export function CatalogEditor({
  catalog,
  rates,
}: {
  catalog: EditorCatalog;
  rates: Catalog;
}) {
  const router = useRouter();
  const [state, setState] = useState<CatalogEditState>(() => toEditState(catalog));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(catalog.materials.map((m) => [m.id, m.enabled])),
  );
  const needle = filter.trim().toLowerCase();

  const mutate = (fn: (draft: CatalogEditState) => void) => {
    setState((prev) => {
      const next: CatalogEditState = {
        materials: { ...prev.materials },
        colours: Object.fromEntries(
          Object.entries(prev.colours).map(([m, cs]) => [m, { ...cs }]),
        ),
        customColours: prev.customColours.map((c) => ({ ...c })),
        layerHeights: [...prev.layerHeights],
      };
      fn(next);
      return next;
    });
    setDirty(true);
  };

  const setColours = (material: string, ids: string[], on: boolean) =>
    mutate((d) => {
      for (const id of ids) d.colours[material]![id] = on;
    });

  const saveCustom = (material: MaterialId, draft: { id?: string; name: string; hex: string }) =>
    mutate((d) => {
      const existing = draft.id ? d.customColours.find((c) => c.id === draft.id) : undefined;
      if (existing) {
        existing.name = draft.name;
        existing.hex = draft.hex;
        return;
      }
      const taken = catalog.materials.flatMap((m) => m.colours.map((c) => c.id));
      const id = newCustomColourId(material, draft.name, [
        ...taken,
        ...d.customColours.map((c) => c.id),
      ]);
      d.customColours.push({ id, name: draft.name, hex: draft.hex, material });
      // A colour is added because it is in stock: offer it straight away.
      d.colours[material]![id] = true;
    });

  const deleteCustom = (material: string, id: string) =>
    mutate((d) => {
      d.customColours = d.customColours.filter((c) => c.id !== id);
      delete d.colours[material]![id];
    });

  const save = async () => {
    setSaving(true);
    try {
      const colours: Record<string, string[]> = {};
      for (const m of catalog.materials) {
        colours[m.id] = editorColours(m, state.customColours)
          .filter((c) => state.colours[m.id]?.[c.id])
          .map((c) => c.id);
      }
      const res = await fetch("/api/admin/catalog", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({
          materials: state.materials,
          colours,
          customColours: state.customColours,
          layerHeights: state.layerHeights,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        alert(data.error?.message ?? "Saving catalog changes failed.");
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
        <span>Catalog · materials &amp; colours</span>
        <span className="text-faint">manage</span>
      </summary>
      <div className="space-y-5 border-t border-line p-4">
        <fieldset>
          <legend className="text-sm font-[650]">Layer heights offered</legend>
          <p className="mt-0.5 text-xs text-faint">
            Untick any your printer doesn&apos;t print at. With only one left, customers just see it, with nothing to
            choose.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            {LAYER_HEIGHTS_UM.map((um) => {
              const on = state.layerHeights.includes(um);
              const last = on && state.layerHeights.length === 1;
              return (
                <label key={um} className="flex items-center gap-2 text-sm" title={last ? "At least one layer height stays on" : undefined}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={last}
                    onChange={(e) => {
                      // Read now: by the time the state updater runs, React
                      // has put the controlled box back to its old value.
                      const checked = e.target.checked;
                      mutate((d) => {
                        d.layerHeights = LAYER_HEIGHTS_UM.filter((h) => (h === um ? checked : d.layerHeights.includes(h)));
                      });
                    }}
                    className="size-4 accent-[var(--accent)]"
                  />
                  {layerHeightLabel(um)}
                </label>
              );
            })}
          </div>
        </fieldset>

        <label className="relative block">
          <span className="sr-only">Filter colours</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter colours — e.g. silk, glow, translucent"
            className="input-base w-full pl-9 text-sm"
          />
        </label>
        {catalog.materials.map((m) => {
          // The shop's own materials appear here once named (Your own materials).
          if (m.setup && !m.setup.named) return null;
          const all = editorColours(m, state.customColours);
          const enabledCount = all.filter((c) => state.colours[m.id]?.[c.id]).length;
          const materialOn = state.materials[m.id];
          const shown = needle ? all.filter((c) => c.name.toLowerCase().includes(needle)) : all;
          if (needle && shown.length === 0) return null;
          const open = needle ? true : expanded[m.id];
          const shownIds = shown.map((c) => c.id);
          return (
            <div key={m.id}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-label={`${open ? "Collapse" : "Expand"} ${m.name}`}
                    onClick={() => setExpanded((e) => ({ ...e, [m.id]: !e[m.id] }))}
                    disabled={Boolean(needle)}
                    className="grid size-6 place-items-center rounded text-faint hover:text-text disabled:opacity-40"
                  >
                    <ChevronDown className={`size-4 transition-transform ${open ? "" : "-rotate-90"}`} />
                  </button>
                  <label className="flex items-center gap-2 text-sm font-[650]">
                    <input
                      type="checkbox"
                      checked={materialOn}
                      // One of the shop's own materials can't go on sale before it has a profile.
                      disabled={Boolean(m.setup?.problem) && !materialOn}
                      onChange={(e) => mutate((d) => (d.materials[m.id] = e.target.checked))}
                      className="size-4 accent-[var(--accent)] disabled:opacity-40"
                    />
                    {m.name}
                    <span className="text-xs font-[450] text-faint">
                      {formatPaise(rates.materials[m.id].sellPerGramPaise)}/g ·{" "}
                      {enabledCount}/{all.length} colours
                    </span>
                  </label>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <button type="button" className="btn-ghost" onClick={() => setColours(m.id, shownIds, true)}>
                    {needle ? `All ${shown.length}` : "All"}
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => setColours(m.id, shownIds, false)}>
                    None
                  </button>
                </div>
              </div>
              {m.setup?.problem ? (
                <p className="mt-1 pl-8 text-xs text-faint">
                  {materialOn ? "Not on sale yet: " : ""}
                  {m.setup.problem} See Your own materials below.
                </p>
              ) : null}
              {open ? (
                <div className="mt-3 space-y-3">
                  <div className={`space-y-3 ${materialOn ? "" : "pointer-events-none opacity-40"}`}>
                    {/* Multi-line tiers (Aesthetic PLA, PETG Premium) split into their
                        filament lines, each with its own All/None; custom colours
                        form their own section wherever there is a palette too. */}
                    {groupColours(shown).map(({ group, colours }) => {
                      const ids = colours.map((c) => c.id);
                      const groupOn = colours.filter((c) => state.colours[m.id]?.[c.id]).length;
                      return (
                        <div key={group ?? "all"}>
                          {group ? (
                            <div className="mb-1.5 flex items-center justify-between gap-3">
                              <span className="text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-muted">
                                {group}
                                <span className="ml-2 font-[450] normal-case tracking-normal text-faint">
                                  {groupOn}/{colours.length}
                                </span>
                              </span>
                              <span className="flex items-center gap-3 text-xs">
                                <button
                                  type="button"
                                  aria-label={`Enable all ${group}`}
                                  className="text-faint hover:text-text"
                                  onClick={() => setColours(m.id, ids, true)}
                                >
                                  All
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Disable all ${group}`}
                                  className="text-faint hover:text-text"
                                  onClick={() => setColours(m.id, ids, false)}
                                >
                                  None
                                </button>
                              </span>
                            </div>
                          ) : null}
                          <div className="flex flex-wrap gap-1.5">
                            {colours.map((c) => (
                              <ColourPill
                                key={c.id}
                                colour={c}
                                on={state.colours[m.id]?.[c.id] ?? false}
                                onToggle={(on) => mutate((d) => (d.colours[m.id]![c.id] = on))}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    {all.length === 0 ? (
                      <p className="text-xs text-faint">
                        No colours yet — add the ones you have in stock below.
                      </p>
                    ) : null}
                  </div>
                  {/* Stays usable while the material is off, so its colours can be
                      set up before it is switched on. */}
                  <CustomColours
                    material={m}
                    customs={state.customColours.filter((c) => c.material === m.id)}
                    onSave={(draft) => saveCustom(m.id, draft)}
                    onDelete={(id) => deleteCustom(m.id, id)}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="btn-pill text-sm disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          {dirty && !saving ? <span className="text-xs text-faint">Unsaved changes</span> : null}
        </div>
      </div>
    </details>
  );
}

function ColourPill({
  colour,
  on,
  onToggle,
}: {
  colour: PublicColour;
  on: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={colour.custom ? `${colour.name} (${colour.hex})` : colour.name}
      onClick={() => onToggle(!on)}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        on ? "border-accent text-text" : "border-line text-faint hover:text-muted"
      }`}
    >
      <span className="size-3 rounded-full border border-line" style={{ background: swatchBackground(colour) }} />
      {colour.custom ? colour.name : colourShortName(colour)}
    </button>
  );
}

interface ColourDraft {
  id?: string;
  name: string;
  hex: string;
}

const EMPTY_DRAFT: ColourDraft = { name: "", hex: "#1F1F1F" };

/** Add, rename/recolour and delete the admin-defined colours of one material.
 *  The native colour input and the hex field edit the same value, so a hex code
 *  copied from a supplier's site can be pasted straight in. */
function CustomColours({
  material,
  customs,
  onSave,
  onDelete,
}: {
  material: PublicMaterial;
  customs: CustomColour[];
  onSave: (draft: ColourDraft) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState<ColourDraft>(EMPTY_DRAFT);
  const [hexText, setHexText] = useState(EMPTY_DRAFT.hex);
  const name = draft.name.trim();
  const duplicate = customs.some(
    (c) => c.id !== draft.id && c.name.toLowerCase() === name.toLowerCase(),
  );

  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setHexText(EMPTY_DRAFT.hex);
  };

  // The field keeps exactly what was typed or pasted ("d00000" and "#d00000"
  // both work); only a complete, valid code updates the colour itself.
  const hexFromText = (text: string) => (text.startsWith("#") ? text : `#${text}`).toUpperCase();
  const hexTextValid = HEX_COLOUR_RE.test(hexFromText(hexText));
  // Never add a colour while the field shows something other than what would be saved.
  const valid = name.length > 0 && hexTextValid && !duplicate;
  const setHex = (text: string) => {
    setHexText(text);
    const hex = hexFromText(text);
    if (HEX_COLOUR_RE.test(hex)) setDraft((d) => ({ ...d, hex }));
  };

  const submit = () => {
    if (!valid) return;
    onSave({ ...(draft.id ? { id: draft.id } : {}), name, hex: draft.hex });
    reset();
  };

  return (
    <div className="rounded-lg border border-dashed border-line p-3">
      <p className="text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-muted">
        {draft.id ? "Edit colour" : `Add a ${material.name} colour`}
      </p>
      {customs.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {customs.map((c) => (
            <li
              key={c.id}
              className="inline-flex items-center gap-1 rounded-full border border-line py-0.5 pl-2 pr-1 text-xs text-muted"
            >
              <span className="size-3 rounded-full border border-line" style={{ background: c.hex }} />
              {c.name}
              <span className="font-mono text-[0.65rem] text-faint">{c.hex}</span>
              <button
                type="button"
                aria-label={`Edit ${c.name}`}
                className="grid size-5 place-items-center rounded-full text-faint hover:text-text"
                onClick={() => {
                  setDraft({ id: c.id, name: c.name, hex: c.hex });
                  setHexText(c.hex);
                }}
              >
                <Pencil className="size-3" />
              </button>
              <button
                type="button"
                aria-label={`Delete ${c.name}`}
                className="grid size-5 place-items-center rounded-full text-faint hover:text-text"
                onClick={() => {
                  if (confirm(`Delete ${c.name}? Existing quotations keep its name.`)) {
                    if (draft.id === c.id) reset();
                    onDelete(c.id);
                  }
                }}
              >
                <Trash2 className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={draft.name}
          maxLength={CUSTOM_COLOUR_NAME_MAX}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), submit())}
          placeholder="Colour name, e.g. Signal Orange"
          aria-label="Colour name"
          className="input-base min-w-0 flex-1 basis-48 py-1.5 text-sm"
        />
        <input
          type="color"
          value={draft.hex.toLowerCase()}
          onChange={(e) => setHex(e.target.value.toUpperCase())}
          aria-label="Pick colour"
          className="h-8 w-10 cursor-pointer rounded border border-line bg-transparent p-0.5"
        />
        <input
          type="text"
          value={hexText}
          maxLength={7}
          onChange={(e) => setHex(e.target.value.trim())}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), submit())}
          aria-label="Hex code"
          aria-invalid={!hexTextValid}
          spellCheck={false}
          className={`input-base w-24 py-1.5 font-mono text-sm ${
            hexTextValid ? "" : "border-[var(--accent)]"
          }`}
        />
        <button type="button" onClick={submit} disabled={!valid} className="btn-ghost text-sm disabled:opacity-40">
          {draft.id ? "Update" : "Add"}
        </button>
        {draft.id ? (
          <button type="button" onClick={reset} aria-label="Cancel editing" className="btn-ghost text-sm">
            <X className="size-4" />
          </button>
        ) : null}
      </div>
      {duplicate ? (
        <p className="mt-1.5 text-xs text-faint">{material.name} already has a colour with that name.</p>
      ) : null}
    </div>
  );
}
