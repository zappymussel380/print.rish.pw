import {
  CATALOG,
  type QuoteBreakdown,
  type QuoteLineInput,
  estimateCompletionDate,
  priceQuote,
  settingsKey,
} from "@print/shared";
import { type QuoteModel, type SliceState, sliceCacheKey } from "./quote-store";

export interface LivePricing {
  breakdown: QuoteBreakdown | null;
  /** Models still waiting on a slice result. */
  pending: number;
  /** Models whose slice failed. */
  failed: number;
  /** Ready models contributing to the quote. */
  priced: number;
  completion: Date | null;
}

/** Derive the current quote from the model list + slice cache. Only ready
 *  models with a completed slice at their current settings contribute. */
export function computePricing(
  models: QuoteModel[],
  slices: Record<string, SliceState>,
): LivePricing {
  const inputs: QuoteLineInput[] = [];
  let pending = 0;
  let failed = 0;

  for (const m of models) {
    if (m.status !== "ready" || !m.server) continue;
    const slice = slices[sliceCacheKey(m.server.id, settingsKey(m.config))];
    if (!slice || slice.status === "queued" || slice.status === "slicing") {
      pending++;
      continue;
    }
    if (slice.status === "failed" || !slice.result) {
      failed++;
      continue;
    }
    inputs.push({ modelId: m.server.id, config: m.config, stats: slice.result });
  }

  if (inputs.length === 0) {
    return { breakdown: null, pending, failed, priced: 0, completion: null };
  }

  const breakdown = priceQuote(inputs, CATALOG);
  const completion = estimateCompletionDate(breakdown.totals.printSeconds, CATALOG.leadTime);
  return { breakdown, pending, failed, priced: inputs.length, completion };
}
