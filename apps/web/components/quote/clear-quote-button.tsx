"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { isIngestPending, useQuoteStore } from "@/lib/quote-store";
import { deleteModel } from "@/lib/upload-client";

/** Resets the quote builder to a clean slate. Confirms inline first (it throws
 *  away every uploaded model), and best-effort deletes ready server records so
 *  cleared uploads don't linger until the retention window. */
export function ClearQuoteButton() {
  const [confirming, setConfirming] = useState(false);
  const clear = useQuoteStore((s) => s.clear);
  const pending = useQuoteStore((s) => s.models.some((model) => isIngestPending(model.status)));

  const onClear = () => {
    if (useQuoteStore.getState().models.some((model) => isIngestPending(model.status))) return;
    const ready = useQuoteStore.getState().models.filter((m) => m.status === "ready" && m.server);
    for (const m of ready) void deleteModel(m.server!.id).catch(() => {});
    clear();
    setConfirming(false);
  };

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-2 text-sm">
        <span className="text-muted">Clear everything?</span>
        <button
          type="button"
          onClick={onClear}
          disabled={pending}
          className="font-[650] text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          Yes, clear
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-muted transition-colors hover:text-text"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      disabled={pending}
      title={pending ? "Available after model checking finishes" : undefined}
      aria-label={pending ? "Clear quote unavailable while models are processing" : undefined}
      className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      <RotateCcw strokeWidth={1.65} className="size-4" />
      Clear quote
    </button>
  );
}
