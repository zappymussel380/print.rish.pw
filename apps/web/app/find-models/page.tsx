import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { PageIntro } from "@/components/shell/page-intro";
import { MODEL_SOURCES } from "@/lib/model-sources";

export const metadata: Metadata = {
  title: "Where to find 3D models",
  description:
    "Free libraries of ready-to-print 3D models — MakerWorld, Printables, Thingiverse, Yeggi, Thangs and Cults3D — plus which file formats we accept and what to check before ordering a print.",
};

const checks: { title: string; body: string }[] = [
  {
    title: "Which file do I download?",
    body: "STL, 3MF, OBJ and AMF all upload directly, and so do STEP/STP files, which we convert for you. If a model offers 3MF, take it — it carries units and orientation reliably, and if the file holds several parts we arrange and price all of them.",
  },
  {
    title: "Check the licence first",
    body: "Most models are free to print for yourself. Some are non-commercial, and some ask that you don't sell prints of them. The licence is on the model's page — worth ten seconds before you order.",
  },
  {
    title: "Check the size",
    body: "Our Bambu Lab A1 prints up to 256 × 256 × 256 mm. Anything larger has to be split into parts. Upload it anyway — the quote page measures your file and tells you if it won't fit.",
  },
];

export default function FindModelsPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
      <PageIntro
        eyebrow="Find models"
        title="Where to get files to print"
        lede="You don't have to design anything to get something printed. These libraries hold millions of free, ready-to-print models — grab a file, upload it, and you'll have an exact price in under a minute."
      />

      <ul className="mx-auto mt-10 grid max-w-4xl gap-4 sm:grid-cols-2">
        {MODEL_SOURCES.map((source) => (
          <li key={source.name}>
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="tile tile-hover flex h-full flex-col p-6"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-[650]">{source.name}</h2>
                <ExternalLink
                  strokeWidth={1.65}
                  className="size-4 shrink-0 text-faint"
                  aria-hidden="true"
                />
              </div>
              <p className="mt-3 flex-1 text-sm leading-6 text-muted">{source.long}</p>
              <div className="mt-4 flex items-center gap-2">
                <span className="chip">{source.cost}</span>
                <span className="text-xs text-faint">
                  {source.url.replace(/^https:\/\//, "")}
                </span>
              </div>
            </a>
          </li>
        ))}
      </ul>

      <section className="mx-auto mt-16 max-w-4xl" aria-labelledby="checks-title">
        <h2 id="checks-title" className="section-title">
          Before you order a print
        </h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {checks.map((check) => (
            <article key={check.title} className="tile p-5">
              <h3 className="text-[0.95rem] font-[650]">{check.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{check.body}</p>
            </article>
          ))}
        </div>
      </section>

      <div className="mx-auto mt-12 max-w-4xl">
        <Link href="/quote" className="btn-pill">
          Got a file? Get a quote
        </Link>
      </div>
    </div>
  );
}
