import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro } from "@/components/shell/page-intro";
import { RecentPrintsGrid } from "@/components/showcase/recent-prints-grid";
import { getRecentPrints } from "@/lib/recent-prints";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Recent prints",
  description:
    "Photos of real parts printed on our Bambu Lab A1 in PLA and PETG — what the machine actually produces, not renders.",
};

export default async function RecentPrintsPage() {
  const prints = await getRecentPrints();

  return (
    <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
      <PageIntro
        eyebrow="Recent prints"
        title="Things we've printed"
        lede="Real parts off the Bambu Lab A1, photographed as they came off the plate. No renders — if it's here, it printed."
      />

      <div className="mt-10">
        {prints.length > 0 ? (
          <RecentPrintsGrid prints={prints} />
        ) : (
          <p className="text-sm text-muted">
            Nothing here yet — photos of recent jobs go up as they come off the printer.
          </p>
        )}
      </div>

      <div className="mt-12 flex flex-wrap gap-3">
        <Link href="/quote" className="btn-pill">
          Print something like this
        </Link>
        <Link href="/find-models" className="btn-ghost">
          Find a model to print
        </Link>
      </div>
    </div>
  );
}
