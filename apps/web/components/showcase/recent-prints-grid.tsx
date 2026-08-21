"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { RecentPrint } from "@print/shared";

/** The showcase photos, as a responsive grid, each opening full size in place.
 *
 * Plain <img> rather than next/image: this codebase does not use next/image
 * anywhere, the photos are served from our own route handler, and introducing
 * an image optimiser for a handful of gallery shots would be a new pattern for
 * no gain. Dimensions and aspect-ratio are fixed so the grid does not reflow
 * as photos load.
 */
export function RecentPrintsGrid({ prints }: { prints: readonly RecentPrint[] }) {
  const [openAt, setOpenAt] = useState<number | null>(null);

  return (
    <>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {prints.map((print, index) => (
          <li key={print.id} className="tile overflow-hidden p-0">
            <button
              type="button"
              onClick={() => setOpenAt(index)}
              aria-label={`View ${print.caption} full size`}
              className="block w-full cursor-zoom-in"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/showcase/${print.id}/photo`}
                // The caption is the alt text: a gallery of decorative images
                // with empty alts would fail the WCAG 2.2 AA target we hold the
                // rest of the site to.
                alt={print.caption}
                width={800}
                height={600}
                loading="lazy"
                decoding="async"
                className="aspect-[4/3] w-full bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] object-cover"
              />
            </button>
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

      <Lightbox prints={prints} openAt={openAt} onClose={() => setOpenAt(null)} onMove={setOpenAt} />
    </>
  );
}

/** Full-size viewer.
 *
 * Built on the native <dialog> element rather than a library: the platform
 * already provides the focus trap, Escape-to-close and an inert background,
 * which are the parts that are easy to get wrong and the reason a hand-rolled
 * overlay would not meet the accessibility bar the rest of the site holds. */
function Lightbox({
  prints,
  openAt,
  onClose,
  onMove,
}: {
  prints: readonly RecentPrint[];
  openAt: number | null;
  onClose: () => void;
  onMove: (index: number) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = openAt !== null;
  const print = open ? prints[openAt] : undefined;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // showModal() is what grants the focus trap and inert background; the open
    // attribute alone does not.
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const step = useCallback(
    (delta: number) => {
      if (openAt === null || prints.length === 0) return;
      onMove((openAt + delta + prints.length) % prints.length);
    },
    [openAt, prints.length, onMove],
  );

  if (prints.length === 0) return null;

  return (
    <dialog
      ref={ref}
      // Escape fires `cancel` then `close`; routing both back to state keeps
      // React the single source of truth for whether this is open.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={onClose}
      // A click that lands on the dialog element itself is a backdrop click —
      // anything inside the panel stops at the panel.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          step(1);
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          step(-1);
        }
      }}
      aria-label={print ? `${print.caption}, full size` : "Photo"}
      className="max-h-[92vh] max-w-[min(96vw,72rem)] rounded-xl border border-line bg-bg p-0 text-text backdrop:bg-[color-mix(in_srgb,black_72%,transparent)]"
    >
      {print && (
        <div className="flex max-h-[92vh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line p-4">
            <div className="min-w-0">
              <p className="text-sm font-[650]">{print.caption}</p>
              <p className="mt-0.5 text-xs text-muted">
                {print.material}
                {print.colour ? ` · ${print.colour}` : ""}
                {prints.length > 1 ? ` · ${(openAt ?? 0) + 1} of ${prints.length}` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-8 shrink-0 place-items-center rounded-full text-faint transition-colors hover:text-accent"
            >
              <X strokeWidth={1.65} className="size-5" />
            </button>
          </div>

          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-[color-mix(in_srgb,var(--surface)_60%,transparent)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/showcase/${print.id}/photo`}
              alt={print.caption}
              className="max-h-[74vh] w-auto max-w-full object-contain"
            />
            {prints.length > 1 && (
              <>
                <ArrowButton side="left" onClick={() => step(-1)} />
                <ArrowButton side="right" onClick={() => step(1)} />
              </>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}

function ArrowButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous photo" : "Next photo"}
      className={`absolute top-1/2 -translate-y-1/2 ${side === "left" ? "left-2" : "right-2"} grid size-10 place-items-center rounded-full border border-line bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] text-muted backdrop-blur-[8px] transition-colors hover:text-accent`}
    >
      <Icon strokeWidth={1.65} className="size-5" />
    </button>
  );
}
