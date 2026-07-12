"use client";

import { useQuoteStore } from "@/lib/quote-store";
import { ClearQuoteButton } from "./clear-quote-button";
import { Dropzone } from "./dropzone";
import { ModelCard } from "./model-card";
import { SessionCleanupBanner } from "./session-cleanup-banner";
import { ShippingEstimate } from "./shipping-estimate";
import { SummaryBar } from "./summary-bar";

/** Client shell for the quote builder: uploads, per-model cards with live
 *  slicing + pricing, and the sticky quote summary. */
export function QuoteBuilder({
  maxModels,
  maxUploadMb,
}: {
  maxModels: number;
  maxUploadMb: number;
}) {
  const models = useQuoteStore((s) => s.models);

  return (
    <div className="mx-auto mt-12 max-w-3xl">
      <SessionCleanupBanner />
      <Dropzone maxModels={maxModels} maxUploadMb={maxUploadMb} />

      {models.length > 0 && (
        <>
          <div className="mt-8 flex items-center justify-between gap-3">
            <p className="text-sm text-muted">
              {models.length} {models.length === 1 ? "model" : "models"}
            </p>
            <ClearQuoteButton />
          </div>
          <ul className="mt-4 space-y-4">
            {models.map((m) => (
              <ModelCard key={m.key} model={m} />
            ))}
          </ul>
          <ShippingEstimate />
        </>
      )}

      <SummaryBar />
    </div>
  );
}
