import { ArrowRight, ExternalLink, FileUp, IndianRupee, ScanEye, Send } from "lucide-react";
import Link from "next/link";
import {
  formatPaise,
  layerHeightLabel,
  listJoin,
  materialFamily,
  materialName,
  MATERIAL_IDS,
  isCustomMaterial,
  type MaterialId,
} from "@print/shared";
import { RecentPrintsGrid } from "@/components/showcase/recent-prints-grid";
import { getCatalogAvailability } from "@/lib/catalog-availability";
import { getPricing } from "@/lib/pricing-settings";
import { getSiteProfile } from "@/lib/site-profile";
import { HOMEPAGE_MODEL_SOURCES } from "@/lib/model-sources";
import { getRecentPrints } from "@/lib/recent-prints";

const steps = (printerName: string) => [
  {
    icon: FileUp,
    title: "Upload your models",
    body: "Drag in STL, 3MF, OBJ or AMF files — as many as you like. Each model gets its own settings.",
  },
  {
    icon: ScanEye,
    title: "We actually slice them",
    body: `No guesswork: every file is sliced by OrcaSlicer with a real ${printerName} profile, so weight and time come from the printer's own toolpath.`,
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

/** The showcase reads the database, so the page cannot be static. */
export const dynamic = "force-dynamic";

/** Enough to fill the grid without turning the homepage into the gallery. */
const HOMEPAGE_PRINT_COUNT = 6;

export default async function HomePage() {
  const [allPrints, profile, availability, { catalog }] = await Promise.all([
    getRecentPrints(),
    getSiteProfile(),
    getCatalogAvailability(),
    getPricing(),
  ]);
  const recentPrints = allPrints.slice(0, HOMEPAGE_PRINT_COUNT);
  const offered = MATERIAL_IDS.filter((m) => availability.materials[m]);
  const nameOf = (m: MaterialId) => materialName(m, availability.customMaterials);
  // Stock tiers by family ("PLA", "PETG"); the shop's own materials by name.
  const families = [...new Set(offered.map((m) => (isCustomMaterial(m) ? nameOf(m) : materialFamily(m))))];
  // The headline rate is the cheapest material actually on sale.
  const cheapest = [...offered].sort(
    (a, b) => catalog.materials[a].sellPerGramPaise - catalog.materials[b].sellPerGramPaise,
  )[0];
  const colourCount = new Set(offered.flatMap((m) => availability.colours[m])).size;
  const printer = catalog.printers[catalog.defaultPrinterId]!;

  return (
    <div className="mx-auto max-w-6xl px-5">
      {/* Hero */}
      <section className="py-20 sm:py-28">
        <p className="eyebrow">{profile.city ? `3D printing · ${profile.city}` : "3D printing"}</p>
        <h1 className="mt-4 max-w-3xl text-[clamp(2.6rem,6.5vw,5.5rem)] font-[600] leading-[0.95] tracking-[-0.05em]">
          Upload a model.
          <br />
          <span className="text-accent">Know the price.</span>
        </h1>
        <p className="mt-6 max-w-xl text-[0.95rem] leading-7 text-muted">
          Instant quotations for FDM 3D printing{families.length > 0 ? ` in ${listJoin(families)}` : ""} —
          priced from real slicing data, not rough estimates. Setup fee{" "}
          {formatPaise(catalog.setupFeePaise)}
          {cheapest ? (
            <>
              , {nameOf(cheapest)} from {formatPaise(catalog.materials[cheapest].sellPerGramPaise)}/g
            </>
          ) : null}
          .
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
          {steps(printer.name).map((step, i) => (
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

      {/* What the machine actually makes. Placed before the "where to get a
          model" section so the order reads: how it works, what comes out, and
          then where to get a file — which is the order a newcomer thinks in.
          Omitted entirely when nothing is published, rather than shipping an
          empty strip. */}
      {recentPrints.length > 0 && (
        <section className="pb-16 sm:pb-20" aria-labelledby="prints-title">
          <p className="eyebrow">Recent prints</p>
          <h2 id="prints-title" className="section-title mt-3">
            What comes off the plate
          </h2>
          <p className="mt-4 max-w-xl text-[0.95rem] leading-7 text-muted">
            Real parts, photographed as they finished. Not renders.
          </p>
          <div className="mt-10">
            <RecentPrintsGrid prints={recentPrints} materialNames={availability.customMaterials} />
          </div>
          <div className="mt-8">
            <Link href="/recent-prints" className="btn-ghost">
              See more recent prints
            </Link>
          </div>
        </section>
      )}

      {/* Where to get a model. Deliberately above the fold-ish and naming the
          sites outright: the most common reason a first-time visitor bounces is
          that they have nothing to upload and do not know these libraries
          exist. A link to a page they cannot imagine would not fix that. */}
      <section className="pb-16 sm:pb-20" aria-labelledby="sources-title">
        <p className="eyebrow">No model yet?</p>
        <h2 id="sources-title" className="section-title mt-3">
          Thousands of free, ready-to-print models
        </h2>
        <p className="mt-4 max-w-xl text-[0.95rem] leading-7 text-muted">
          You don&rsquo;t need to design anything. Download a file from any of these libraries,
          upload it here, and you&rsquo;ll have a price in under a minute.
        </p>
        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {HOMEPAGE_MODEL_SOURCES.map((source) => (
            <li key={source.name}>
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="tile tile-hover flex h-full flex-col p-5"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[0.95rem] font-[650]">{source.name}</h3>
                  <ExternalLink
                    strokeWidth={1.65}
                    className="size-4 shrink-0 text-faint"
                    aria-hidden="true"
                  />
                </div>
                <p className="mt-2 flex-1 text-sm leading-6 text-muted">{source.short}</p>
                <span className="chip mt-4 w-fit">{source.cost}</span>
              </a>
            </li>
          ))}
        </ul>
        <div className="mt-8">
          <Link href="/find-models" className="btn-ghost">
            More places to look, and what to check before you print
          </Link>
        </div>
      </section>

      {/* Printer + materials strip */}
      <section className="pb-20" aria-labelledby="kit-title">
        <div className="tile p-6 sm:p-8">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="eyebrow">The kit</p>
              <h2 id="kit-title" className="mt-2 text-xl font-[650] tracking-tight">
                {printer.name} · {printer.nozzleMm} mm nozzle
              </h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted">
                Up to {printer.bedMm.join(" × ")} mm builds.{" "}
                {availability.layerHeights.length === 1
                  ? `Every part at ${layerHeightLabel(availability.layerHeights[0]!)} layers`
                  : `Layer heights of ${listJoin(availability.layerHeights.map((um) => (um / 1000).toFixed(2)))} mm`}
                ; infill from 10 to 60%; automatic supports when your part needs them.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {offered.map((m) => (
                <span key={m} className="chip chip-accent">
                  {nameOf(m)} {formatPaise(catalog.materials[m].sellPerGramPaise)}/g
                </span>
              ))}
              {colourCount > 0 ? (
                <span className="chip">
                  {colourCount} colour{colourCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
