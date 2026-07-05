"use client";

import { useCallback, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";
import { MAX_QUANTITY } from "@print/shared";
import { useQuoteStore } from "@/lib/quote-store";
import {
  ACCEPT_ATTR,
  ACCEPTED_EXTENSIONS,
  hasAcceptedExtension,
  uploadModel,
} from "@/lib/upload-client";

const MAX_PARALLEL = 3;

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

export function Dropzone({ maxModels }: { maxModels: number }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const { models, addUploading, setProgress, markReady, markError } = useQuoteStore();

  const accept = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      const ok: File[] = [];
      const bad: string[] = [];
      for (const f of files) {
        if (hasAcceptedExtension(f.name)) ok.push(f);
        else bad.push(f.name);
      }
      setRejected(bad);

      const remaining = maxModels - useQuoteStore.getState().models.length;
      if (remaining <= 0) {
        setRejected((r) => [...r, `Limit of ${maxModels} models reached`]);
        return;
      }
      const toUpload = ok.slice(0, remaining);
      if (ok.length > remaining) {
        setRejected((r) => [...r, `Only ${remaining} more file(s) can be added`]);
      }

      const tagged = toUpload.map((file) => ({ file, key: crypto.randomUUID() }));
      for (const { file, key } of tagged) addUploading(key, file.name, file.size);

      await runPooled(tagged, MAX_PARALLEL, async ({ file, key }) => {
        try {
          const model = await uploadModel(file, (frac) => setProgress(key, frac));
          markReady(key, model);
        } catch (err) {
          const message =
            err && typeof err === "object" && "message" in err
              ? String((err as { message: unknown }).message)
              : "Upload failed";
          markError(key, message);
        }
      });
    },
    [addUploading, markError, markReady, maxModels, setProgress],
  );

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
        Accepted: {ACCEPTED_EXTENSIONS.join(", ")} · up to {maxModels} files · quantities up to{" "}
        {MAX_QUANTITY} per model
      </p>

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
