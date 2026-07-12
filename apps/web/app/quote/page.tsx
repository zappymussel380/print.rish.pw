import type { Metadata } from "next";
import { PageIntro } from "@/components/shell/page-intro";
import { QuoteBuilder } from "@/components/quote/quote-builder";
import { env } from "@/lib/env";

export const metadata: Metadata = {
  title: "Get a quote",
  description:
    "Upload your STL, 3MF, OBJ or AMF models and get an instant quote built from real OrcaSlicer slicing — no guesswork.",
};

export default function QuotePage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
      <PageIntro
        eyebrow="Instant quote"
        title="Upload. Slice. Price."
        lede="Drop in your models and we'll slice every one with a real Bambu Lab A1 profile. You'll see exact filament, print time and price — then tweak settings and watch the quote update."
      />
      <QuoteBuilder maxModels={env.maxModelsPerSession} maxUploadMb={env.maxUploadMb} />
    </div>
  );
}
