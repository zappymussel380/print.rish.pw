"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Files, Plus, UploadCloud, X } from "lucide-react";
import { MAX_QUANTITY } from "@print/shared";
import { useQuoteStore } from "@/lib/quote-store";
import { clientUid } from "@/lib/uid";
import {
  ACCEPT_ATTR,
  ACCEPTED_EXTENSIONS,
  hasAcceptedExtension,
  uploadModel,
} from "@/lib/upload-client";

const MAX_PARALLEL = 2;

/** A file that matches one already in the quote (same name + size), awaiting
 *  the user's call: bump the existing quantity, or upload a separate copy. */
interface DuplicatePrompt {
  id: string;
  file: File;
  existingKey: string;
  name: string;
}

/** Run async tasks with a bounded concurrency so a bulk drop doesn't open
 *  dozens of simultaneous uploads. */
async function runPooled<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const next = queue.shift()!;
      await task(next);
    }
  });
  await Promise.all(workers);
}

export function Dropzone({ maxModels, maxUploadMb }: { maxModels: number; maxUploadMb: number }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadsRef = useRef(new Map<string, AbortController>());
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicatePrompt[]>([]);
  const { models, addUploading, setProgress, markQueued, markError, updateConfig } =
    useQuoteStore();

  useEffect(
    () => () => {
      for (const controller of uploadsRef.current.values()) controller.abort();
      uploadsRef.current.clear();
    },
  );

  // Upload a set of files, honouring the per-quote model limit at call time.
  const startUploads = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const remaining = maxModels - useQuoteStore.getState().models.length;
      if (remaining <= 0) {
        setRejected((r) => [...r, `Limit of ${maxModels} models reached`]);
        return;
      }
      const toUpload = files.slice(0, remaining);
      if (files.length > toUpload.length) {
        setRejected((r) => [...r, `Only ${remaining} more file(s) can be added`]);
      }

      const tagged = toUpload.map((file) => ({ file, key: clientUid() }));
      for (const { file, key } of tagged) addUploading(key, file.name, file.size);

      await runPooled(tagged, MAX_PARALLEL, async ({ file, key }) => {
        const controller = new AbortController();
        uploadsRef.current.set(key, controller);
        try {
          const accepted = await uploadModel(
            file,
            (frac) => setProgress(key, frac),
            controller.signal,
          );
          markQueued(key, accepted.ticket, accepted.position);
        } catch (err) {
          const message =
            err && typeof err === "object" && "message" in err
              ? String((err as { message: unknown }).message)
              : "Upload failed";
          markError(key, message);
        } finally {
          uploadsRef.current.delete(key);
        }
      });
    },
    [addUploading, markError, markQueued, maxModels, setProgress],
  );

  const accept = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      const ok: File[] = [];
      const bad: string[] = [];
      const maxUploadBytes = maxUploadMb * 1024 * 1024;
      for (const f of files) {
        if (!hasAcceptedExtension(f.name)) bad.push(`${f.name}: unsupported format`);
        else if (f.size > maxUploadBytes) bad.push(`${f.name}: larger than ${maxUploadMb} MB`);
        else ok.push(f);
      }
      setRejected(bad);

      // A file already in the quote (by name + size) is likely an accidental
      // re-upload — hold it back and ask, rather than silently duplicating.
      // Errored rows don't count, so re-dropping a failed file just retries.
      const existing = useQuoteStore.getState().models.filter((m) => m.status !== "error");
      const fresh: File[] = [];
      const dups: DuplicatePrompt[] = [];
      for (const file of ok) {
        const match = existing.find((m) => m.fileName === file.name && m.sizeBytes === file.size);
        if (match) {
          dups.push({ id: clientUid(), file, existingKey: match.key, name: file.name });
        } else {
          fresh.push(file);
        }
      }
      if (dups.length) setDuplicates((d) => [...d, ...dups]);

      await startUploads(fresh);
    },
    [maxUploadMb, startUploads],
  );

  const bumpQuantity = useCallback(
    (d: DuplicatePrompt) => {
      const model = useQuoteStore.getState().models.find((m) => m.key === d.existingKey);
      const current = model?.config.quantity ?? 1;
      updateConfig(d.existingKey, { quantity: Math.min(current + 1, MAX_QUANTITY) });
      setDuplicates((list) => list.filter((x) => x.id !== d.id));
    },
    [updateConfig],
  );

  const addAnyway = useCallback(
    (d: DuplicatePrompt) => {
      setDuplicates((list) => list.filter((x) => x.id !== d.id));
      void startUploads([d.file]);
    },
    [startUploads],
  );

  const dismissDuplicate = useCallback((id: string) => {
    setDuplicates((list) => list.filter((x) => x.id !== id));
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files.length) void accept(e.dataTransfer.files);
    },
    [accept],
  );

  const atLimit = models.length >= maxModels;

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload 3D model files"
        aria-disabled={atLimit}
        onClick={() => !atLimit && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !atLimit) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!atLimit) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className="tile group flex cursor-pointer flex-col items-center justify-center gap-4 px-6 py-14 text-center transition-colors"
        style={{
          borderStyle: "dashed",
          borderColor: dragging ? "var(--accent)" : undefined,
          background: dragging
            ? "color-mix(in srgb, var(--accent) 7%, var(--surface))"
            : undefined,
          cursor: atLimit ? "not-allowed" : "pointer",
          opacity: atLimit ? 0.6 : 1,
        }}
      >
        <span
          className="flex h-14 w-14 items-center justify-center rounded-full transition-colors"
          style={{
            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
            color: "var(--accent)",
          }}
        >
          <UploadCloud strokeWidth={1.65} className="h-7 w-7" />
        </span>
        <div>
          <p className="text-[0.95rem] font-[650]">
            {atLimit ? "Model limit reached" : "Drop your models here"}
          </p>
          <p className="mt-1 text-sm text-muted">
            {atLimit
              ? `You can attach up to ${maxModels} files per quote.`
              : "or click to browse — STL, 3MF, OBJ, AMF"}
          </p>
        </div>
        {!atLimit && (
          <span className="btn-ghost pointer-events-none text-sm">Choose files</span>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="sr-only"
          onChange={(e) => {
            if (e.target.files?.length) void accept(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <p className="mt-3 text-center text-xs text-faint">
        Accepted: {ACCEPTED_EXTENSIONS.join(", ")} · {maxUploadMb} MB per file · up to {maxModels}{" "}
        files · quantities up to {MAX_QUANTITY} per model
      </p>

      {duplicates.length > 0 && (
        <div
          role="alert"
          className="mt-4 rounded-[var(--radius-card)] border border-line bg-[color-mix(in_srgb,var(--accent)_6%,var(--surface))] p-4"
        >
          <div className="flex items-start gap-2.5">
            <Files strokeWidth={1.65} className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-[650]">Already in your quote</p>
              <p className="mt-0.5 text-xs leading-5 text-muted">
                {duplicates.length === 1 ? "This file is" : "These files are"} already added. Need
                more than one unit? Increase the quantity instead — or add a separate copy if that's
                what you meant.
              </p>
            </div>
          </div>
          <ul className="mt-3 space-y-2">
            {duplicates.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm" title={d.name}>
                  {d.name}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => bumpQuantity(d)}
                    className="btn-pill h-8 min-h-0 gap-1 px-3 py-0 text-xs"
                  >
                    <Plus strokeWidth={2.2} className="size-3.5" /> Quantity
                  </button>
                  <button
                    type="button"
                    onClick={() => addAnyway(d)}
                    className="btn-ghost h-8 min-h-0 px-3 py-0 text-xs"
                  >
                    Add copy
                  </button>
                  <button
                    type="button"
                    onClick={() => dismissDuplicate(d.id)}
                    aria-label={`Dismiss ${d.name}`}
                    className="grid size-8 shrink-0 place-items-center rounded-full text-faint transition-colors hover:text-accent"
                  >
                    <X strokeWidth={1.65} className="size-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rejected.length > 0 && (
        <ul className="mt-3 space-y-1" aria-live="polite">
          {rejected.map((r, i) => (
            <li key={`${r}-${i}`} className="text-xs" style={{ color: "var(--accent)" }}>
              Skipped: {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
