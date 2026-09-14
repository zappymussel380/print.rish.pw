"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CUSTOM_GUIDE_LIMITS,
  CUSTOM_MATERIAL_IDS,
  CUSTOM_MATERIAL_NAME_MAX,
  DENSITY_MAX,
  DENSITY_MIN,
  MATERIAL_GUIDE_ROWS,
  ORCA_GENERIC_FILAMENTS,
  customFilamentSlot,
  genericLabel,
  startingPreset,
  type CustomMaterialGuide,
  type CustomMaterialId,
  type CustomMaterialNames,
  type OrcaGenericFilament,
  type PublicMaterial,
} from "@print/shared";
import type { SlicerProfilesState } from "@/lib/slicer-profiles";
import { errorMessage } from "./slicer-profiles-editor";

const PROFILES_API = "/api/admin/slicer-profiles";
const NAMES_API = "/api/admin/custom-materials";
const HEADERS = { "X-Requested-With": "XMLHttpRequest" };
const POLL_MS = 2500;

/**
 * The shop's own materials: four slots for whatever it prints beyond the
 * built-in list (ABS-CF, PC, PA…). Each needs a name and an OrcaSlicer filament
 * profile — started from one of OrcaSlicer's generics with the filament's real
 * density, or the shop's own exported preset — which the worker test-slices
 * before quotes use it. Switching one on, its colours and its prices live in
 * Catalog and Rates, like every other material. Optional copy for /materials
 * (strength, temperature…) is written here too; Site picks whether it shows.
 */
export function CustomMaterialsEditor({
  catalog,
  initial,
  materialNames,
}: {
  catalog: { materials: PublicMaterial[] };
  initial: SlicerProfilesState;
  /** As stored: the shop's names and the copy it wrote for /materials. */
  materialNames: CustomMaterialNames;
}) {
  const router = useRouter();
  const [profiles, setProfiles] = useState(initial);
  // Only what the owner has typed and not saved yet; otherwise the saved name.
  const [drafts, setDrafts] = useState<Partial<Record<CustomMaterialId, string>>>({});
  // Only what the owner has changed and not sent yet; otherwise what the preset
  // being tested, or else the live one, was made with.
  const [generic, setGeneric] = useState<Partial<Record<CustomMaterialId, OrcaGenericFilament>>>({});
  const [density, setDensity] = useState<Partial<Record<CustomMaterialId, string>>>({});
  // Copy for /materials the owner has edited and not saved yet.
  const [guideDrafts, setGuideDrafts] = useState<Partial<Record<CustomMaterialId, CustomMaterialGuide>>>({});
  const [pending, setPending] = useState<CustomMaterialId | null>(null);
  const [errors, setErrors] = useState<Partial<Record<CustomMaterialId, string>>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadFor = useRef<CustomMaterialId | null>(null);
  const wasBusy = useRef(initial.busy);

  const refresh = useCallback(async () => {
    const res = await fetch(PROFILES_API, { headers: HEADERS, cache: "no-store" });
    if (res.ok) setProfiles((await res.json()) as SlicerProfilesState);
  }, []);

  // Poll while a test slice runs; once it settles, refresh the dashboard so
  // Catalog knows the material can be switched on.
  useEffect(() => {
    if (profiles.busy) {
      wasBusy.current = true;
      const timer = setInterval(() => void refresh(), POLL_MS);
      return () => clearInterval(timer);
    }
    if (wasBusy.current) {
      wasBusy.current = false;
      router.refresh();
    }
    return undefined;
  }, [profiles.busy, refresh, router]);

  const slotOf = (id: CustomMaterialId) => profiles.slots.find((s) => s.slot === customFilamentSlot(id));
  const shownGeneric = (id: CustomMaterialId): OrcaGenericFilament => {
    const slot = slotOf(id);
    return generic[id] ?? slot?.pending?.startedFrom ?? slot?.live?.startedFrom ?? ORCA_GENERIC_FILAMENTS[0];
  };
  const shownDensity = (id: CustomMaterialId): string => {
    if (density[id] !== undefined) return density[id];
    const slot = slotOf(id);
    const saved = slot?.pending?.densityGcm3 ?? slot?.live?.densityGcm3;
    return saved === undefined ? "" : saved.toFixed(2);
  };

  const fail = (id: CustomMaterialId, message: string | null) => setErrors((e) => ({ ...e, [id]: message ?? undefined }));

  const run = async (id: CustomMaterialId, work: () => Promise<void>) => {
    fail(id, null);
    setPending(id);
    try {
      await work();
    } finally {
      setPending(null);
    }
  };

  const saveName = (id: CustomMaterialId, name: string) =>
    run(id, async () => {
      const res = await fetch(NAMES_API, {
        method: "PUT",
        headers: { ...HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ names: { [id]: name } }),
      });
      if (!res.ok) return fail(id, await errorMessage(res, "Saving the name failed."));
      setDrafts(({ [id]: _saved, ...rest }) => rest);
      router.refresh();
    });

  const saveGuide = (id: CustomMaterialId, guide: CustomMaterialGuide) =>
    run(id, async () => {
      const res = await fetch(NAMES_API, {
        method: "PUT",
        headers: { ...HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ guides: { [id]: guide } }),
      });
      if (!res.ok) return fail(id, await errorMessage(res, "Saving the text failed."));
      setGuideDrafts(({ [id]: _saved, ...rest }) => rest);
      router.refresh();
    });

  /** True once the preset is stored and queued for its test. */
  const sendPreset = async (id: CustomMaterialId, body: Blob, fileName: string): Promise<boolean> => {
    const res = await fetch(`${PROFILES_API}?slot=${encodeURIComponent(customFilamentSlot(id))}&name=${encodeURIComponent(fileName)}`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/octet-stream" },
      body,
    });
    if (!res.ok) {
      fail(id, res.status === 413 ? "That file is too large (2 MB at most)." : await errorMessage(res, "The upload failed."));
      return false;
    }
    setProfiles((await res.json()) as SlicerProfilesState);
    return true;
  };

  /** Drop the owner's unsent choices, so the boxes show what was just sent. */
  const settle = (id: CustomMaterialId) => {
    setGeneric(({ [id]: _g, ...rest }) => rest);
    setDensity(({ [id]: _d, ...rest }) => rest);
  };

  const startFromGeneric = (id: CustomMaterialId, name: string) =>
    run(id, async () => {
      const base = shownGeneric(id);
      const d = Number(shownDensity(id));
      if (!(d >= DENSITY_MIN && d <= DENSITY_MAX)) {
        return fail(id, `Enter your filament's density (${DENSITY_MIN}–${DENSITY_MAX} g/cm³) — it's on the spool or its datasheet.`);
      }
      const preset = JSON.stringify(startingPreset(name, base, d));
      if (await sendPreset(id, new Blob([preset], { type: "application/json" }), `${name} (from ${genericLabel(base)}).json`)) {
        settle(id);
      }
    });

  const pickFile = (id: CustomMaterialId) => {
    uploadFor.current = id;
    fail(id, null);
    fileInput.current?.click();
  };

  const removeProfile = (id: CustomMaterialId) =>
    run(id, async () => {
      const res = await fetch(`${PROFILES_API}?slot=${encodeURIComponent(customFilamentSlot(id))}`, { method: "DELETE", headers: HEADERS });
      if (!res.ok) return fail(id, await errorMessage(res, "Couldn't remove the profile."));
      setProfiles((await res.json()) as SlicerProfilesState);
      router.refresh();
    });

  return (
    <details className="tile mt-4 p-0 [&_summary]:list-none">
      <summary className="flex cursor-pointer items-center justify-between p-4 text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
        <span>Your own materials · ABS-CF, PC, PA…</span>
        <span className="text-faint">{profiles.busy ? "testing…" : "edit"}</span>
      </summary>
      <div className="space-y-4 border-t border-line p-4">
        <p className="text-xs text-faint">
          Print something that isn&apos;t in the list? Set up to four of your own. Give each a name and an OrcaSlicer
          filament profile: start from one of OrcaSlicer&apos;s generics with your filament&apos;s density, or upload the
          preset you tuned (in OrcaSlicer: the filament&apos;s settings → Export → .json). Every profile is test-sliced
          before quotes use it. Then switch the material on and add its colours in Catalog, and set its prices in Rates.
        </p>

        <input
          ref={fileInput}
          type="file"
          aria-label="OrcaSlicer filament preset"
          accept=".json,.orca_filament,application/json,application/zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            const id = uploadFor.current;
            if (file && id) {
              void run(id, async () => {
                if (await sendPreset(id, file, file.name)) settle(id);
              });
            }
          }}
        />

        <ul className="divide-y divide-line rounded-lg border border-line">
          {CUSTOM_MATERIAL_IDS.map((id, i) => {
            const material = catalog.materials.find((m) => m.id === id);
            const savedName = material?.setup?.named ? material.name : "";
            const slot = slotOf(id);
            const busy = pending === id;
            const name = drafts[id] ?? savedName;
            const nameChanged = name.trim() !== savedName;
            return (
              <li key={id} className="space-y-2 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="shrink-0 whitespace-nowrap text-xs font-[650] uppercase tracking-[0.1em] text-faint">Material {i + 1}</span>
                  <input
                    value={name}
                    onChange={(e) => setDrafts((d) => ({ ...d, [id]: e.target.value }))}
                    maxLength={CUSTOM_MATERIAL_NAME_MAX}
                    placeholder="Name customers see, e.g. ABS-CF"
                    aria-label={`Material ${i + 1} name`}
                    className="input-base min-w-0 flex-1 text-sm"
                  />
                  <button
                    type="button"
                    className="btn-ghost text-sm disabled:opacity-40"
                    disabled={busy || !nameChanged}
                    onClick={() => void saveName(id, name)}
                  >
                    {name.trim() === "" && savedName ? "Clear" : "Save name"}
                  </button>
                </div>

                <p className="text-xs text-faint">
                  {slot?.live ? (
                    <>
                      OrcaSlicer profile: <span className="text-muted">{slot.live.presetName}</span>
                      {slot.live.densityGcm3 !== undefined ? ` · density ${slot.live.densityGcm3.toFixed(2)} g/cm³` : ""}
                      {slot.live.testGrams != null ? ` · test cube ${slot.live.testGrams.toFixed(1)} g` : ""}
                    </>
                  ) : (
                    "No OrcaSlicer profile yet."
                  )}
                  {slot?.testing ? (
                    <span className="text-accent">
                      {" "}
                      · testing a profile
                      {slot.pending?.densityGcm3 !== undefined ? ` (density ${slot.pending.densityGcm3.toFixed(2)} g/cm³)` : ""} on a
                      20 mm cube…
                    </span>
                  ) : null}
                  {material?.enabled && material.setup?.ready ? <span> · on sale</span> : null}
                </p>
                {slot?.lastError ? (
                  <p className="text-xs text-danger" role="alert">
                    The last profile didn&apos;t pass, so nothing changed: {slot.lastError}
                  </p>
                ) : null}

                {savedName ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <select
                      aria-label={`${savedName}: OrcaSlicer generic to start from`}
                      value={shownGeneric(id)}
                      onChange={(e) => setGeneric((g) => ({ ...g, [id]: e.target.value as OrcaGenericFilament }))}
                      className="input-base w-auto max-w-full text-sm"
                    >
                      {ORCA_GENERIC_FILAMENTS.map((g) => (
                        <option key={g} value={g}>
                          Start from {genericLabel(g)}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1 text-xs text-faint">
                      Density
                      <input
                        inputMode="decimal"
                        value={shownDensity(id)}
                        onChange={(e) => setDensity((d) => ({ ...d, [id]: e.target.value }))}
                        placeholder="e.g. 1.24"
                        aria-label={`${savedName}: filament density in g/cm³`}
                        className="input-base w-16 text-sm"
                      />
                      g/cm³
                    </label>
                    <button type="button" className="btn-ghost text-sm disabled:opacity-40" disabled={busy || slot?.testing} onClick={() => void startFromGeneric(id, savedName)}>
                      {busy ? "Working…" : "Use this"}
                    </button>
                    <span className="text-xs text-faint">or</span>
                    <button type="button" className="btn-ghost text-sm disabled:opacity-40" disabled={busy || slot?.testing} onClick={() => pickFile(id)}>
                      Upload your preset
                    </button>
                    {slot?.live ? (
                      <button type="button" className="btn-ghost text-sm disabled:opacity-40" disabled={busy} onClick={() => void removeProfile(id)}>
                        Remove profile
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-xs text-faint">Name it first; then give it an OrcaSlicer profile.</p>
                )}

                {savedName ? (
                  <GuideFields
                    name={savedName}
                    saved={materialNames[id]?.guide ?? {}}
                    draft={guideDrafts[id]}
                    busy={busy}
                    onChange={(guide) => setGuideDrafts((d) => ({ ...d, [id]: guide }))}
                    onSave={(guide) => void saveGuide(id, guide)}
                  />
                ) : null}

                {errors[id] ? (
                  <p className="text-xs text-danger" role="alert">
                    {errors[id]}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}

const GUIDE_FIELDS: { key: keyof CustomMaterialGuide; label: string; max: number }[] = [
  { key: "subtitle", label: "What it is", max: CUSTOM_GUIDE_LIMITS.subtitle },
  ...MATERIAL_GUIDE_ROWS.map((r) => ({ key: r.key, label: r.label, max: CUSTOM_GUIDE_LIMITS.row })),
];

/** The copy /materials shows for one of the shop's own materials. Optional:
 *  with none, Site can't put it on the page. */
function GuideFields({
  name,
  saved,
  draft,
  busy,
  onChange,
  onSave,
}: {
  name: string;
  saved: CustomMaterialGuide;
  draft: CustomMaterialGuide | undefined;
  busy: boolean;
  onChange: (guide: CustomMaterialGuide) => void;
  onSave: (guide: CustomMaterialGuide) => void;
}) {
  const guide = draft ?? saved;
  const has = Object.keys(saved).length > 0;
  const changed = draft !== undefined && GUIDE_FIELDS.some((f) => (draft[f.key] ?? "").trim() !== (saved[f.key] ?? ""));
  return (
    <details className="rounded-lg border border-line [&_summary]:list-none">
      <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-xs text-faint">
        <span>Materials page text {has ? "· written" : "· optional"}</span>
        <span>edit</span>
      </summary>
      <div className="space-y-2.5 border-t border-line p-3">
        <p className="text-xs text-faint">
          How {name} compares on /materials. Blank rows read &ldquo;Ask us about this.&rdquo; Once there&apos;s some
          text, tick {name} under Site → Materials page (Site in the admin menu) to show it.
        </p>
        {GUIDE_FIELDS.map((f) => (
          <label key={f.key} className="block text-xs">
            <span className="font-[600] text-muted">{f.label}</span>
            <textarea
              rows={f.key === "subtitle" ? 1 : 2}
              maxLength={f.max}
              value={guide[f.key] ?? ""}
              placeholder={f.key === "subtitle" ? "e.g. Carbon-fibre filled nylon" : undefined}
              aria-label={`${name}: ${f.label}`}
              onChange={(e) => onChange({ ...guide, [f.key]: e.target.value })}
              className="input-base mt-1 block py-1.5 text-sm"
            />
          </label>
        ))}
        <button
          type="button"
          className="btn-ghost text-sm disabled:opacity-40"
          disabled={busy || !changed}
          onClick={() => onSave(guide)}
        >
          {busy ? "Saving…" : "Save text"}
        </button>
      </div>
    </details>
  );
}
