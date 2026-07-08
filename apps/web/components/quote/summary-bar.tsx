"use client";

import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { CATALOG, formatDuration, formatGrams, formatPaise } from "@print/shared";
import { computePricing } from "@/lib/pricing-client";
import { useQuoteStore } from "@/lib/quote-store";
import { RollingValue } from "./rolling-value";

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

export function SummaryBar() {
  const models = useQuoteStore((s) => s.models);
  const slices = useQuoteStore((s) => s.slices);

  const readyModels = models.filter((m) => m.status === "ready");
  if (readyModels.length === 0) return null;

  const { breakdown, pending, failed, priced, completion } = computePricing(models, slices);
  const canContinue = !!breakdown && pending === 0;

  return (
    <div className="sticky bottom-0 z-30 mt-8 border-t border-line bg-[color-mix(in_srgb,var(--bg)_86%,transparent)] backdrop-blur-[18px]">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-8 gap-y-3 px-1 py-4">
        <div className="flex flex-1 flex-wrap gap-x-6 gap-y-2">
          <Metric label="Models">{priced || readyModels.length}</Metric>
          <Metric label="Filament">
            {breakdown ? formatGrams(breakdown.totals.grams) : "—"}
          </Metric>
          <Metric label="Print time">
            {breakdown ? formatDuration(breakdown.totals.printSeconds) : "—"}
          </Metric>
          <Metric label="Ready by">
            {completion ? dateFmt.format(completion) : "—"}
          </Metric>
          <Metric label="Total" accent>
            {breakdown ? formatPaise(breakdown.totalPaise) : "—"}
          </Metric>
        </div>

        <div className="flex items-center gap-3">
          {pending > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Loader2 strokeWidth={1.65} className="h-3.5 w-3.5 animate-spin" />
              {pending} slicing…
            </span>
          )}
          {failed > 0 && pending === 0 && (
            <span className="text-xs text-accent">{failed} failed</span>
          )}
          {canContinue ? (
            <Link href="/quote/details" className="btn-pill text-sm">
              Continue <ArrowRight strokeWidth={2} className="h-4 w-4" />
            </Link>
          ) : (
            <button type="button" disabled className="btn-pill text-sm" aria-disabled>
              Continue <ArrowRight strokeWidth={2} className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <p className="mx-auto max-w-3xl px-1 pb-3 text-[0.7rem] text-faint">
        Includes a {formatPaise(CATALOG.setupFeePaise)} one-time setup fee. Prices come from real
        slicing; final confirmation happens over WhatsApp.
      </p>
    </div>
  );
}

function Metric({
  label,
  children,
  accent,
}: {
  label: string;
  children: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div>
      <span className="block text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
        {label}
      </span>
      <span className={`mt-0.5 block font-[700] ${accent ? "text-accent" : "text-text"}`}>
        <RollingValue>{children}</RollingValue>
      </span>
    </div>
  );
}
