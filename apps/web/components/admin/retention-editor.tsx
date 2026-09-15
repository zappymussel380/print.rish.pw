"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RETENTION_BOUNDS, type RetentionSettings } from "@print/shared";

const B = RETENTION_BOUNDS;
const HEADERS = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };

type Preview = { uploads: number; finishedFiles: number };

/** How long customer files and finished quotations are kept, and a manual
 *  purge. The worker's daily sweep follows the saved policy; a purge only ever
 *  removes files (uploads never quoted, finished quotations' models), never a
 *  quotation, its PDF, or anything still open. */
export function RetentionEditor({ initial, saved }: { initial: RetentionSettings; saved: boolean }) {
  const router = useRouter();
  const [uploadDays, setUploadDays] = useState(String(initial.uploadRetentionDays));
  const [fileDays, setFileDays] = useState(String(initial.fileRetentionDays));
  const [keepQuotes, setKeepQuotes] = useState(initial.quotationRetentionDays === null);
  const [quoteDays, setQuoteDays] = useState(String(initial.quotationRetentionDays ?? 90));
  const [isSaved, setIsSaved] = useState(saved);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [purgeDays, setPurgeDays] = useState("30");
  const [preview, setPreview] = useState<{ days: number; counts: Preview } | null>(null);
  const [purging, setPurging] = useState<"preview" | "run" | null>(null);
  const [purgeMessage, setPurgeMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const touch = (set: (v: string) => void) => (v: string) => {
    set(v);
    setDirty(true);
    setError(null);
  };
  const days = (text: string, b: { min: number; max: number }) => {
    const n = Number(text);
    return Number.isInteger(n) && n >= b.min && n <= b.max ? n : null;
  };
  const upload = days(uploadDays, B.uploadRetentionDays);
  const files = days(fileDays, B.fileRetentionDays);
  const quotes = keepQuotes ? null : days(quoteDays, B.quotationRetentionDays);
  const valid = upload !== null && files !== null && (keepQuotes || quotes !== null);
  const purgeN = days(purgeDays, B.purgeOlderThanDays);

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/retention", {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ uploadRetentionDays: upload, fileRetentionDays: files, quotationRetentionDays: quotes }),
      });
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setError(data?.error?.message ?? "Saving the clean-up policy failed.");
        return;
      }
      setIsSaved(true);
      setDirty(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  const fetchPreview = async (n: number): Promise<Preview | null> => {
    const res = await fetch(`/api/admin/retention/purge?olderThanDays=${n}`, { headers: HEADERS, cache: "no-store" });
    return res.ok ? ((await res.json()) as Preview) : null;
  };

  const runPreview = async () => {
    if (purgeN === null) return;
    setPurging("preview");
    setPurgeMessage(null);
    try {
      const counts = await fetchPreview(purgeN);
      if (counts) setPreview({ days: purgeN, counts });
      else setPurgeMessage({ ok: false, text: "Couldn't count the files." });
    } finally {
      setPurging(null);
    }
  };

  const runPurge = async () => {
    if (!preview) return;
    const { days: n, counts: before } = preview;
    if (!confirm(`Delete ${describe(before)} older than ${n} days? Quotations and their PDFs are kept. This can't be undone.`)) return;
    setPurging("run");
    setPurgeMessage(null);
    try {
      const res = await fetch("/api/admin/retention/purge", { method: "POST", headers: HEADERS, body: JSON.stringify({ olderThanDays: n }) });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setPurgeMessage({ ok: false, text: data?.error?.message ?? "The purge couldn't start." });
        return;
      }
      // The worker does the deleting; watch the counts fall.
      let after = before;
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 1500));
        const now = await fetchPreview(n);
        if (!now) break;
        after = now;
        if (now.uploads === 0 && now.finishedFiles === 0) break;
      }
      setPreview({ days: n, counts: after });
      const removed = { uploads: before.uploads - after.uploads, finishedFiles: before.finishedFiles - after.finishedFiles };
      setPurgeMessage(
        removed.uploads + removed.finishedFiles > 0
          ? { ok: true, text: `Done: deleted ${describe(removed)}.` }
          : { ok: true, text: "Queued. The worker will finish it shortly; check again in a minute." },
      );
      router.refresh();
    } finally {
      setPurging(null);
    }
  };

  const input = "input-base w-20 px-2 py-1.5 text-right text-sm tabular-nums";

  return (
    <details className="tile mt-4 p-0 [&_summary]:list-none">
      <summary className="flex cursor-pointer items-center justify-between p-4 text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
        <span>File clean-up · uploads &amp; old quotations</span>
        <span className="text-faint">edit</span>
      </summary>
      <div className="space-y-6 border-t border-line p-4">
        <fieldset className="min-w-0 space-y-3">
          <legend className="text-sm font-[650]">Keep, then delete automatically (every day)</legend>
          {!isSaved ? (
            <p className="text-xs text-faint">These are the server&apos;s defaults until you save your own.</p>
          ) : null}
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 text-muted">Uploads that never became a quotation</span>
            <input inputMode="numeric" value={uploadDays} onChange={(e) => touch(setUploadDays)(e.target.value)} aria-invalid={upload === null} className={`${input} ${upload === null ? "border-[var(--danger)]" : ""}`} />
            <span className="w-16 text-xs text-faint">days</span>
          </label>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 text-muted">Model files of finished quotations (after completed, delivered or cancelled)</span>
            <input inputMode="numeric" value={fileDays} onChange={(e) => touch(setFileDays)(e.target.value)} aria-invalid={files === null} className={`${input} ${files === null ? "border-[var(--danger)]" : ""}`} />
            <span className="w-16 text-xs text-faint">days</span>
          </label>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 text-muted">Finished quotations themselves (record, PDF, customer details)</span>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={keepQuotes}
                onChange={(e) => {
                  setKeepQuotes(e.target.checked);
                  setDirty(true);
                }}
                className="size-4 accent-[var(--accent)]"
              />
              keep for good
            </label>
            {keepQuotes ? (
              <span className="w-[8.5rem]" />
            ) : (
              <>
                <input inputMode="numeric" value={quoteDays} onChange={(e) => touch(setQuoteDays)(e.target.value)} aria-invalid={quotes === null} aria-label="Finished quotations: days" className={`${input} ${quotes === null ? "border-[var(--danger)]" : ""}`} />
                <span className="w-16 text-xs text-faint">days</span>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={save} disabled={!dirty || saving || !valid} className="btn-pill text-sm disabled:opacity-40">
              {saving ? "Saving…" : "Save clean-up policy"}
            </button>
            {error ? (
              <span className="text-xs text-danger" role="alert">
                {error}
              </span>
            ) : !valid ? (
              <span className="text-xs text-danger">Uploads 1–365 days, files 1–3650, quotations 7–3650 (or keep for good).</span>
            ) : dirty ? (
              <span className="text-xs text-faint">Unsaved changes · the FAQ&apos;s privacy answer follows these too</span>
            ) : null}
          </div>
        </fieldset>

        <fieldset className="min-w-0 space-y-3 border-t border-line pt-5">
          <legend className="text-sm font-[650]">Purge now</legend>
          <p className="text-xs text-faint">
            Frees disk space at once: deletes uploads that never became a quotation and the model files of finished
            quotations, older than the days you pick. Quotations, their PDFs and anything still open are never touched.
          </p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Older than</span>
            <input
              inputMode="numeric"
              value={purgeDays}
              aria-label="Purge files older than, in days"
              onChange={(e) => {
                setPurgeDays(e.target.value);
                setPreview(null);
                setPurgeMessage(null);
              }}
              className={`${input} ${purgeN === null ? "border-[var(--danger)]" : ""}`}
            />
            <span className="text-xs text-faint">days</span>
            <button type="button" onClick={runPreview} disabled={purgeN === null || purging !== null} className="btn-ghost text-sm disabled:opacity-40">
              {purging === "preview" ? "Counting…" : "See what it would delete"}
            </button>
          </div>
          {preview ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-muted">
                {preview.counts.uploads + preview.counts.finishedFiles === 0
                  ? `Nothing older than ${preview.days} days to delete.`
                  : `Would delete ${describe(preview.counts)}.`}
              </span>
              {preview.counts.uploads + preview.counts.finishedFiles > 0 ? (
                <button
                  type="button"
                  onClick={runPurge}
                  disabled={purging !== null}
                  className="btn-ghost text-sm text-danger disabled:opacity-40"
                >
                  {purging === "run" ? "Deleting…" : "Delete them now"}
                </button>
              ) : null}
            </div>
          ) : null}
          {purgeMessage ? (
            <p className={`text-xs ${purgeMessage.ok ? "text-muted" : "text-danger"}`} role={purgeMessage.ok ? "status" : "alert"}>
              {purgeMessage.text}
            </p>
          ) : null}
        </fieldset>
      </div>
    </details>
  );
}

function describe({ uploads, finishedFiles }: Preview): string {
  const parts = [];
  if (uploads > 0) parts.push(`${uploads} upload${uploads === 1 ? "" : "s"} never quoted`);
  if (finishedFiles > 0) parts.push(`the files of ${finishedFiles} finished quotation model${finishedFiles === 1 ? "" : "s"}`);
  return parts.join(" and ") || "nothing";
}
