"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CUSTOM_MATERIAL_IDS,
  CUSTOM_MATERIAL_NAME_MAX,
  DENSITY_MAX,
  DENSITY_MIN,
  ORCA_GENERIC_FILAMENTS,
  customFilamentSlot,
  genericLabel,
  startingPreset,
  type CustomMaterialId,
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
 * Catalog and Rates, like every other material.
 */
export function CustomMaterialsEditor({
  catalog,
  initial,
}: {
  catalog: { materials: PublicMaterial[] };
  initial: SlicerProfilesState;
}) {
  const router = useRouter();
  const [profiles, setProfiles] = useState(initial);
  // Only what the owner has typed and not saved yet; otherwise the saved name.
  const [drafts, setDrafts] = useState<Partial<Record<CustomMaterialId, string>>>({});
  const [generic, setGeneric] = useState<Record<string, OrcaGenericFilament>>({});
  const [density, setDensity] = useState<Record<string, string>>({});
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

  const sendPreset = async (id: CustomMaterialId, body: Blob, fileName: string) => {
    const res = await fetch(`${PROFILES_API}?slot=${encodeURIComponent(customFilamentSlot(id))}&name=${encodeURIComponent(fileName)}`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/octet-stream" },
      body,
    });
    if (!res.ok) {
      return fail(id, res.status === 413 ? "That file is too large (2 MB at most)." : await errorMessage(res, "The upload failed."));
    }
    setProfiles((await res.json()) as SlicerProfilesState);
  };

  const startFromGeneric = (id: CustomMaterialId, name: string) =>
    run(id, async () => {
      const base = generic[id] ?? ORCA_GENERIC_FILAMENTS[0];
      const d = Number(density[id]);
      if (!(d >= DENSITY_MIN && d <= DENSITY_MAX)) {
        return fail(id, `Enter your filament's density (${DENSITY_MIN}–${DENSITY_MAX} g/cm³) — it's on the spool or its datasheet.`);
      }
      const preset = JSON.stringify(startingPreset(name, base, d));
      await sendPreset(id, new Blob([preset], { type: "application/json" }), `${name} (from ${genericLabel(base)}).json`);
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
            if (file && id) void run(id, () => sendPreset(id, file, file.name));
          }}
        />

        <ul className="divide-y divide-line rounded-lg border border-line">
          {CUSTOM_MATERIAL_IDS.map((id, i) => {
            const material = catalog.materials.find((m) => m.id === id);
            const savedName = material?.setup?.named ? material.name : "";
            const slot = profiles.slots.find((s) => s.slot === customFilamentSlot(id));
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
                      {slot.live.testGrams != null ? ` · test cube ${slot.live.testGrams.toFixed(1)} g` : ""}
                    </>
                  ) : (
                    "No OrcaSlicer profile yet."
                  )}
                  {slot?.testing ? <span className="text-accent"> · testing a profile on a 20 mm cube…</span> : null}
                  {material?.enabled && material.setup?.ready ? <span> · on sale</span> : null}
                </p>
                {slot?.lastError ? (
                  <p className="text-xs text-accent" role="alert">
                    The last profile didn&apos;t pass, so nothing changed: {slot.lastError}
                  </p>
                ) : null}

                {savedName ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <select
                      aria-label={`${savedName}: OrcaSlicer generic to start from`}
                      value={generic[id] ?? ORCA_GENERIC_FILAMENTS[0]}
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
                        value={density[id] ?? ""}
                        onChange={(e) => setDensity((d) => ({ ...d, [id]: e.target.value }))}
                        placeholder="1.20"
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

                {errors[id] ? (
                  <p className="text-xs text-accent" role="alert">
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
