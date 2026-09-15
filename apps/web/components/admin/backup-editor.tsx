"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Upload } from "lucide-react";

interface RestoreReport {
  restored: string[];
  skipped: { what: string; why: string }[];
  presetsQueued: number;
  secretsToReenter: string[];
}

/** How the file's sections read in the confirm step; mirrors BACKUP_SECTIONS
 *  in lib/settings-backup.ts (kept here so the page doesn't ship the server's
 *  zod schemas). */
const SECTION_LABELS: Record<string, string> = {
  pricing: "Rates",
  catalogAvailability: "Catalog, colours and your own materials",
  materialHelper: "Material helper",
  siteProfile: "Shop profile",
  faq: "FAQ",
  tax: "GST",
  retention: "File clean-up",
  shipping: "Shipping",
  mail: "Email",
};

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/** Admin → Settings → Backup & restore: every setting the shop has saved and
 *  its live slicer presets, as one file to download before a reinstall and
 *  restore after. Passwords and API keys are never in it. */
export function BackupEditor() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<RestoreReport | null>(null);

  const restore = async (file: File) => {
    setError(null);
    setReport(null);
    let text: string;
    let parsed: { sections?: Record<string, unknown>; presets?: unknown[]; exportedAt?: string } | null = null;
    try {
      text = await file.text();
      parsed = JSON.parse(text);
    } catch {
      setError("That file isn't a settings backup (it isn't JSON).");
      return;
    }
    const sections = Object.keys(parsed?.sections ?? {}).map((k) => SECTION_LABELS[k] ?? k);
    const presets = Array.isArray(parsed?.presets) ? parsed.presets.length : 0;
    const made = parsed?.exportedAt && !Number.isNaN(Date.parse(parsed.exportedAt)) ? ` made ${dateFmt.format(new Date(parsed.exportedAt))}` : "";
    const what = [
      ...sections,
      ...(presets > 0 ? [`${presets} slicer preset${presets === 1 ? "" : "s"} (test-sliced again before they go live)`] : []),
    ];
    if (what.length === 0) {
      setError("That backup has no settings in it.");
      return;
    }
    if (!confirm(`Restore the backup${made}? This replaces this shop's:\n\n• ${what.join("\n• ")}\n\nQuotations and uploads aren't touched.`)) return;

    setBusy(true);
    try {
      const res = await fetch("/api/admin/backup", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: text,
      });
      const data = (await res.json().catch(() => null)) as (RestoreReport & { error?: { message?: string } }) | null;
      if (!res.ok || !data) {
        setError(data?.error?.message ?? (res.status === 413 ? "That file is too large to be a settings backup." : "Restoring failed."));
        return;
      }
      setReport(data);
      router.refresh();
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <details className="tile mt-4 p-0 [&_summary]:list-none">
      <summary className="flex cursor-pointer items-center justify-between p-4 text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
        <span>Backup &amp; restore · your settings</span>
        <span className="text-faint">file</span>
      </summary>
      <div className="space-y-4 border-t border-line p-4">
        <p className="text-xs text-faint">
          One file with everything you&apos;ve set up here: rates, catalog and colours, your own materials and their
          OrcaSlicer presets, the material helper, shop profile, FAQ, GST, file clean-up, shipping and email. Download it
          before reinstalling or moving the shop, then restore it once you&apos;re signed in again. Passwords and API keys
          are never in the file — you&apos;ll re-enter those. Quotations and uploads aren&apos;t included; they&apos;re in the
          database backup.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <a href="/api/admin/backup" download className="btn-pill text-sm">
            <Download strokeWidth={1.8} className="h-4 w-4" /> Download backup
          </a>
          <button type="button" disabled={busy} onClick={() => input.current?.click()} className="btn-ghost text-sm disabled:opacity-40">
            <Upload strokeWidth={1.8} className="h-4 w-4" /> {busy ? "Restoring…" : "Restore from file…"}
          </button>
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void restore(file);
            }}
          />
        </div>
        {error ? (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {report ? (
          <div className="space-y-1.5 rounded-lg border border-line p-3 text-xs text-muted" role="status">
            <p className="font-[600] text-text">
              Restored{report.restored.length > 0 ? `: ${report.restored.join(", ")}` : " nothing"}.
            </p>
            {report.presetsQueued > 0 ? (
              <p>
                {report.presetsQueued} slicer preset{report.presetsQueued === 1 ? " is" : "s are"} being test-sliced; each goes
                live when its test passes (Filament → Your own materials shows progress).
              </p>
            ) : null}
            {report.secretsToReenter.length > 0 ? <p>Enter again: {report.secretsToReenter.join("; ")}.</p> : null}
            {report.skipped.map((s) => (
              <p key={s.what}>
                Skipped {s.what}: {s.why}.
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
