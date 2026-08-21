import type { RecentPrint } from "@print/shared";

/** The showcase photos, as a responsive grid.
 *
 * Plain <img> rather than next/image: this codebase does not use next/image
 * anywhere, the photos are served from our own route handler, and introducing
 * an image optimiser for a handful of gallery shots would be a new pattern for
 * no gain. Dimensions and aspect-ratio are fixed so the grid does not reflow
 * as photos load.
 */
export function RecentPrintsGrid({ prints }: { prints: readonly RecentPrint[] }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {prints.map((print) => (
        <li key={print.id} className="tile overflow-hidden p-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/showcase/${print.id}/photo`}
            // The caption is the alt text: a gallery of decorative images with
            // empty alts would fail the WCAG 2.2 AA target we hold the rest of
            // the site to.
            alt={print.caption}
            width={800}
            height={600}
            loading="lazy"
            decoding="async"
            className="aspect-[4/3] w-full bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] object-cover"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 p-4">
            <p className="text-sm font-[650]">{print.caption}</p>
            <span className="chip">
              {print.material}
              {print.colour ? ` · ${print.colour}` : ""}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
