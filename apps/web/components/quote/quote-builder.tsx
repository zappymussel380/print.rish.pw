"use client";

import { useQuoteStore } from "@/lib/quote-store";
import { Dropzone } from "./dropzone";
import { ModelCard } from "./model-card";
import { SummaryBar } from "./summary-bar";

/** Client shell for the quote builder: uploads, per-model cards with live
 *  slicing + pricing, and the sticky quote summary. */
export function QuoteBuilder({ maxModels }: { maxModels: number }) {
  const models = useQuoteStore((s) => s.models);

  return (
    <div className="mx-auto mt-12 max-w-3xl">
      <Dropzone maxModels={maxModels} />

      {models.length > 0 && (
        <ul className="mt-8 space-y-4">
          {models.map((m) => (
            <ModelCard key={m.key} model={m} />
          ))}
        </ul>
      )}

      <SummaryBar />
    </div>
  );
}
