"use client";

import { useEffect, useState } from "react";
import { Loader2, Trash2, X } from "lucide-react";
import { useQuoteStore } from "@/lib/quote-store";

/** The quote store is not persisted, so a page reload leaves the on-screen quote
 *  empty while the server session still holds the uploaded models — silently
 *  filling the per-session cap. When more models exist server-side than are on
 *  screen, offer to clear the stranded ones. */
export function SessionCleanupBanner() {
  const onScreen = useQuoteStore((s) => s.models.length);
  const [serverCount, setServerCount] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [clearing, setClearing] = useState(false);

  const refresh = async () => {
    try {
      const res = await fetch("/api/models", { headers: { "X-Requested-With": "XMLHttpRequest" } });
      const data = (await res.json()) as { count?: number };
      setServerCount(typeof data.count === "number" ? data.count : 0);
    } catch {
      setServerCount(0);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const orphans = serverCount != null ? serverCount - onScreen : 0;
  if (dismissed || orphans <= 0) return null;

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

  return (
    <div className="tile mb-6 flex flex-wrap items-center justify-between gap-3 border-[color-mix(in_srgb,var(--accent)_45%,var(--line))] p-4">
      <p className="text-sm text-muted">
        You have <span className="font-[650] text-text">{orphans}</span> earlier{" "}
        {orphans === 1 ? "upload" : "uploads"} from a previous session using up your quote (max 20).
      </p>
      <div className="flex items-center gap-2">
        <button type="button" onClick={clear} disabled={clearing} className="btn-pill text-sm">
          {clearing ? (
            <>
              <Loader2 strokeWidth={2} className="size-4 animate-spin" /> Clearing…
            </>
          ) : (
            <>
              <Trash2 strokeWidth={1.8} className="size-4" /> Clear them
            </>
          )}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="rounded-md p-2 text-faint transition-colors hover:text-accent"
        >
          <X strokeWidth={1.8} className="size-4" />
        </button>
      </div>
    </div>
  );
}
