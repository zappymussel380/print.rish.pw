import { ArrowRight, FileUp, IndianRupee, ScanEye, Send } from "lucide-react";
import Link from "next/link";
import { CATALOG, formatPaise } from "@print/shared";

const steps = [
  {
    icon: FileUp,
    title: "Upload your models",
    body: "Drag in STL, 3MF, OBJ or AMF files — as many as you like. Each model gets its own settings.",
  },
  {
    icon: ScanEye,
    title: "We actually slice them",
    body: "No guesswork: every file is sliced by OrcaSlicer with a real Bambu Lab A1 profile, so weight and time come from the printer's own toolpath.",
  },
  {
    icon: IndianRupee,
    title: "Transparent quote, instantly",
    body: "Material, electricity and maintenance broken down per model. Change infill or material and watch the price update.",
  },
  {
    icon: Send,
    title: "Confirm on WhatsApp",
    body: "Happy with the number? Submit your details and continue the conversation on WhatsApp with your quotation PDF ready.",
  },
];

export default function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-5">
      {/* Hero */}
      <section className="py-20 sm:py-28">
        <p className="eyebrow">3D printing · Guwahati</p>
        <h1 className="mt-4 max-w-3xl text-[clamp(2.6rem,6.5vw,5.5rem)] font-[600] leading-[0.95] tracking-[-0.05em]">
          Upload a model.
          <br />
          <span className="text-accent">Know the price.</span>
        </h1>
        <p className="mt-6 max-w-xl text-[0.95rem] leading-7 text-muted">
          Instant quotations for FDM 3D printing in PLA and PETG — priced from real slicing data,
          not rough estimates. Setup fee {formatPaise(CATALOG.setupFeePaise)}, PLA from{" "}
          {formatPaise(CATALOG.materials.PLA.sellPerGramPaise)}/g.
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-4">
          <Link href="/quote" className="btn-pill">
            Get an instant quote
            <ArrowRight strokeWidth={1.65} className="size-4" />
          </Link>
          <Link href="/pricing" className="btn-ghost">
            How pricing works
          </Link>
        </div>
      </section>

      <div className="accent-divider" aria-hidden="true" />

      {/* How it works */}
      <section className="py-16 sm:py-20" aria-labelledby="how-title">
        <p className="eyebrow">How it works</p>
        <h2 id="how-title" className="section-title mt-3">
          From file to quote in under a minute
        </h2>
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((step, i) => (
            <li key={step.title} className="tile tile-hover p-5">
              <div className="flex items-center justify-between">
                <step.icon strokeWidth={1.65} className="size-5 text-accent" aria-hidden="true" />
                <span className="font-mono text-xs text-faint">0{i + 1}</span>
              </div>
              <h3 className="mt-4 text-[0.95rem] font-[650]">{step.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Printer + materials strip */}
      <section className="pb-20" aria-labelledby="kit-title">
        <div className="tile p-6 sm:p-8">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="eyebrow">The kit</p>
              <h2 id="kit-title" className="mt-2 text-xl font-[650] tracking-tight">
                Bambu Lab A1 · 0.4 mm nozzle
              </h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted">
                Up to 256 × 256 × 256 mm builds. Layer heights of 0.12, 0.16 and 0.20 mm; infill
                from 10 to 60%; automatic supports when your part needs them.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="chip chip-accent">PLA {formatPaise(CATALOG.materials.PLA.sellPerGramPaise)}/g</span>
              <span className="chip chip-accent">PETG {formatPaise(CATALOG.materials.PETG.sellPerGramPaise)}/g</span>
              <span className="chip">Black</span>
              <span className="chip">White</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
