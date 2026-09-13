"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProfileSlot } from "@print/shared";
import type { SlicerProfilesState } from "@/lib/slicer-profiles";

const API = "/api/admin/slicer-profiles";
const HEADERS = { "X-Requested-With": "XMLHttpRequest" };
const POLL_MS = 2500;

const STATUS_TEXT: Record<SlicerProfilesState["uploads"][number]["status"], string> = {
  testing: "Test slicing…",
  failed: "Failed — nothing changed",
  live: "Live",
  replaced: "Replaced",
};

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return data?.error?.message ?? fallback;
}

/** Advanced mode: the owner's own OrcaSlicer presets. Every upload is test
 *  sliced by the worker before it replaces what's live; a slot without an
 *  upload keeps the preset the installer set up. */
export function SlicerProfilesEditor({ initial }: { initial: SlicerProfilesState }) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [pendingSlot, setPendingSlot] = useState<ProfileSlot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadSlot = useRef<ProfileSlot | null>(null);
  const wasBusy = useRef(initial.busy);

  const refresh = useCallback(async () => {
    const res = await fetch(API, { headers: HEADERS, cache: "no-store" });
    if (res.ok) setState((await res.json()) as SlicerProfilesState);
  }, []);

  // Poll while a test slice runs; once it settles, refresh the rest of the
  // dashboard too (a new printer changes the build volume shown elsewhere).
  useEffect(() => {
    if (state.busy) {
      wasBusy.current = true;
      const timer = setInterval(() => void refresh(), POLL_MS);
      return () => clearInterval(timer);
    }
    if (wasBusy.current) {
      wasBusy.current = false;
      router.refresh();
    }
    return undefined;
  }, [state.busy, refresh, router]);

  const pick = (slot: ProfileSlot) => {
    uploadSlot.current = slot;
    setError(null);
    setNotice(null);
    fileInput.current?.click();
  };

  const upload = async (file: File) => {
    const slot = uploadSlot.current;
    if (!slot) return;
    setPendingSlot(slot);
    try {
      const res = await fetch(`${API}?slot=${encodeURIComponent(slot)}&name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { ...HEADERS, "Content-Type": "application/octet-stream" },
        body: file,
      });
      if (!res.ok) {
        setError(res.status === 413 ? "That file is too large (2 MB at most)." : await errorMessage(res, "The upload failed."));
        return;
      }
      const next = (await res.json()) as SlicerProfilesState & { ignored?: string[] };
      setState(next);
      if (next.ignored?.length) {
        setNotice(
          `Not used from the bundle: ${next.ignored.join(", ")}. Upload filament presets on their material's row.`,
        );
      }
    } finally {
      setPendingSlot(null);
    }
  };

  const switchToInstalled = async (slot: ProfileSlot) => {
    setError(null);
    setNotice(null);
    setPendingSlot(slot);
    try {
      const res = await fetch(`${API}?slot=${encodeURIComponent(slot)}`, { method: "DELETE", headers: HEADERS });
      if (!res.ok) {
        setError(await errorMessage(res, "Couldn't switch back to the installed preset."));
        return;
      }
      setState((await res.json()) as SlicerProfilesState);
      router.refresh();
    } finally {
      setPendingSlot(null);
    }
  };

  const { printer } = state;
  return (
    <details className="tile mt-4 p-0 [&_summary]:list-none">
      <summary className="flex cursor-pointer items-center justify-between p-4 text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
        <span>Slicer profiles · advanced mode</span>
        <span className="text-faint">{state.busy ? "testing…" : "edit"}</span>
      </summary>
      <div className="space-y-6 border-t border-line p-4">
        <div>
          <p className="text-sm font-[650]">
            {printer.name} · {printer.bedMm.join(" × ")} mm · {printer.nozzleMm} mm nozzle
          </p>
          <p className="mt-1 text-xs text-faint">
            Upload presets you&apos;ve tuned in OrcaSlicer: a whole printer as a bundle (File → Export → Export
            Preset Bundle → Printer bundle) or single presets as .json. Every upload is test-sliced before it
            replaces anything, and a row without an upload keeps the preset the installer set up.
          </p>
        </div>

        <input
          ref={fileInput}
          type="file"
          aria-label="OrcaSlicer preset or bundle"
          accept=".json,.orca_printer,.orca_filament,application/json,application/zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />

        <ul className="divide-y divide-line rounded-lg border border-line">
          {state.slots.map((row) => {
            const busy = pendingSlot === row.slot;
            return (
              <li key={row.slot} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
                <div className="min-w-[12rem] flex-1">
                  <p className="text-sm font-[600]">{row.label}</p>
                  <p className="mt-0.5 text-xs text-faint">
                    {row.live ? (
                      <>
                        <span className="text-muted">{row.live.presetName}</span> · {row.live.originalName}
                        {row.live.testGrams != null ? ` · test cube ${row.live.testGrams.toFixed(1)} g` : ""}
                      </>
                    ) : (
                      "Installed preset"
                    )}
                    {row.testing ? <span className="text-accent"> · testing an upload…</span> : null}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn-ghost text-sm disabled:opacity-40" disabled={busy} onClick={() => pick(row.slot)}>
                    {busy ? "Working…" : row.slot === "machine" ? "Upload printer" : "Upload"}
                  </button>
                  {row.live ? (
                    <button type="button" className="btn-ghost text-sm disabled:opacity-40" disabled={busy} onClick={() => void switchToInstalled(row.slot)}>
                      Use installed
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>

        {error ? (
          <p className="text-xs text-accent" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="text-xs text-faint">{notice}</p> : null}

        {state.uploads.length > 0 ? (
          <div>
            <p className="text-sm font-[650]">Recent uploads</p>
            <ul className="mt-2 space-y-2">
              {state.uploads.map((u) => (
                <li key={u.batchId} className="text-xs">
                  <p>
                    <span className="font-[600] text-muted">{u.originalName}</span>{" "}
                    <span className={u.status === "failed" ? "text-accent" : "text-faint"}>· {STATUS_TEXT[u.status]}</span>
                  </p>
                  {u.error ? <p className="mt-0.5 text-accent">{u.error}</p> : null}
                  {u.presets
                    .filter((p) => p.note)
                    .map((p) => (
                      <p key={p.presetName} className="mt-0.5 text-faint">
                        {p.presetName}: {p.note}
                      </p>
                    ))}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}
