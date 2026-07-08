"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useQuoteStore } from "@/lib/quote-store";
import type { UploadedModelDto } from "@/lib/upload-client";

/** The quote store is not persisted, so a page reload leaves the on-screen quote
 *  empty while the server session still holds the uploaded models — silently
 *  filling the per-session cap. When models exist server-side but not on screen,
 *  offer to restore them into the quote or clear the queue. */
export function SessionCleanupBanner() {
  const models = useQuoteStore((s) => s.models);
  const restoreModels = useQuoteStore((s) => s.restoreModels);
  const [serverModels, setServerModels] = useState<UploadedModelDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const refresh = async () => {
    try {
      const res = await fetch("/api/models?include=models", {
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      const data = (await res.json()) as { models?: UploadedModelDto[] };
      setServerModels(Array.isArray(data.models) ? data.models : []);
    } catch {
      setServerModels([]);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const visibleServerIds = new Set(models.map((m) => m.server?.id).filter((id): id is string => !!id));
  const queuedModels = serverModels.filter((model) => !visibleServerIds.has(model.id));
  const queuedCount = queuedModels.length;
  if (!loaded || queuedCount <= 0) return null;

  const clear = async () => {
    setClearing(true);
    try {
      // Preserve every model still on screen (read live at click time). Without
      // this the server would delete active unattached uploads too, stranding
      // the current quote — the UI would keep showing a model whose file is gone.
      const keep = useQuoteStore
        .getState()
        .models.map((m) => m.server?.id)
        .filter((id): id is string => !!id);
      await fetch("/api/models", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({ keep }),
      });
      await refresh();
    } finally {
      setClearing(false);
    }
  };

  const reload = () => {
    setRestoring(true);
    try {
      restoreModels(queuedModels);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="tile mb-6 flex flex-wrap items-center justify-between gap-3 border-[color-mix(in_srgb,var(--accent)_45%,var(--line))] p-4">
      <p className="text-sm text-muted">
        You have <span className="font-[650] text-text">{queuedCount}</span>{" "}
        {queuedCount === 1 ? "uploaded model" : "uploaded models"} saved in this browser. Reload{" "}
        {queuedCount === 1 ? "it" : "them"} into the quote or clear the queue.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={reload}
          disabled={restoring || clearing}
          className="btn-pill whitespace-nowrap text-sm"
        >
          {restoring ? (
            <>
              <Loader2 strokeWidth={2} className="size-4 animate-spin" /> Reloading...
            </>
          ) : (
            <>
              <RefreshCw strokeWidth={1.8} className="size-4" /> Reload models
            </>
          )}
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={clearing || restoring}
          className="btn-ghost whitespace-nowrap text-sm"
        >
          {clearing ? (
            <>
              <Loader2 strokeWidth={2} className="size-4 animate-spin" /> Clearing...
            </>
          ) : (
            <>
              <Trash2 strokeWidth={1.8} className="size-4" /> Clear queue
            </>
          )}
        </button>
      </div>
    </div>
  );
}
