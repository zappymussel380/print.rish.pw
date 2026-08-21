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
 *
 * The tile and the viewer request the *same* URL, so opening a photo is a
 * cache hit and the full-size image is already decoded — which is what makes
 * the open animation smooth rather than a flash of empty frame.
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
                className="aspect-[4/3] w-full bg-[color-mix(in_srgb,var(--surface)_70%,transparent)] object-cover transition-transform duration-300 ease-out hover:scale-[1.02]"
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

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
/** Where a double-tap lands. Enough to read a layer line, short of pixel soup. */
const TAP_ZOOM = 2.5;
/** Must match the duration in the transition classes below. */
const TRANSITION_MS = 240;

interface View {
  zoom: number;
  x: number;
  y: number;
}
const RESET: View = { zoom: 1, x: 0, y: 0 };

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Full-size viewer.
 *
 * Built on the native <dialog> element rather than a library: the platform
 * already provides the focus trap, Escape-to-close and an inert background,
 * which are the parts that are easy to get wrong.
 *
 * Two things the UA stylesheet does *not* survive here. Tailwind's preflight
 * resets `margin: 0` on every element, which kills the `margin: auto` a modal
 * dialog is centred by — so this one is explicitly laid out full-viewport and
 * centres its own content. And `::backdrop` is left transparent in favour of a
 * plain element we can fade, because an element is far easier to animate in
 * step with the photo than a pseudo-element is.
 */
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  // Live pointers on the stage: one is a pan, two are a pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchDistance = useRef(0);
  // Set once a gesture has moved far enough to be a drag, so the click that
  // ends a pan is not mistaken for a click on the ground.
  const dragged = useRef(false);

  const [shown, setShown] = useState(false);
  const [view, setView] = useState<View>(RESET);
  const [interacting, setInteracting] = useState(false);

  const open = openAt !== null;
  const print = open ? prints[openAt] : undefined;

  // Adjust state at the moment the prop changes rather than a frame later from
  // an effect (React's "adjusting state when a prop changes"): every photo
  // opens unzoomed, including after stepping to the next one, and closing has
  // to start the exit transition immediately or the dialog would sit at full
  // opacity until the effect ran.
  const [lastOpenAt, setLastOpenAt] = useState(openAt);
  if (openAt !== lastOpenAt) {
    setLastOpenAt(openAt);
    // Closing keeps whatever zoom was on screen so the photo fades out as the
    // reader left it; anything else snaps to 1x mid-fade.
    if (openAt === null) setShown(false);
    else setView(RESET);
  }

  // Drive the enter/exit transition around showModal()/close(). The dialog is
  // opened first and faded in on the next frame, and closed only after the exit
  // has played — closing immediately would snap it away mid-animation.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    if (!dialog.open) return;
    const timer = setTimeout(() => dialog.close(), TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // showModal() makes the rest of the page inert but does not stop it
  // scrolling behind the viewer.
  useEffect(() => {
    if (!open) return;
    const { style } = document.documentElement;
    const previous = { overflow: style.overflow, paddingRight: style.paddingRight };
    // Reserve the width the scrollbar occupied, or the page behind the dim
    // visibly jumps sideways as the viewer opens and closes.
    const gutter = window.innerWidth - document.documentElement.clientWidth;
    style.overflow = "hidden";
    if (gutter > 0) style.paddingRight = `${gutter}px`;
    return () => {
      style.overflow = previous.overflow;
      style.paddingRight = previous.paddingRight;
    };
  }, [open]);

  /** Scale by `factor` about a viewport point, keeping whatever is under that
   *  point pinned there — the behaviour every map and photo viewer has. */
  const zoomBy = useCallback((factor: number, clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const cx = clientX - rect.left - rect.width / 2;
    const cy = clientY - rect.top - rect.height / 2;
    setView((prev) => {
      const zoom = clamp(prev.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      if (zoom === prev.zoom) return prev;
      // Fully zoomed out is always centred; there is nowhere to pan to.
      if (zoom === MIN_ZOOM) return RESET;
      const ratio = zoom / prev.zoom;
      return { zoom, x: cx - (cx - prev.x) * ratio, y: cy - (cy - prev.y) * ratio };
    });
  }, []);

  // Wheel has to be a native non-passive listener: React registers wheel at the
  // root as passive, so preventDefault() from onWheel would be ignored and the
  // gesture would scroll the page instead of zooming.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !open) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // Exponential so each notch is the same proportional step in and out.
      zoomBy(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [open, zoomBy]);

  const step = useCallback(
    (delta: number) => {
      if (openAt === null || prints.length === 0) return;
      onMove((openAt + delta + prints.length) % prints.length);
    },
    [openAt, prints.length, onMove],
  );

  const zoomed = view.zoom > MIN_ZOOM + 0.001;

  /** Double-click and double-tap: in if we are out, all the way out if not. */
  const toggleZoom = (clientX: number, clientY: number) =>
    zoomBy(zoomed ? MIN_ZOOM / view.zoom : TAP_ZOOM, clientX, clientY);

  /** Is this viewport point over the photo?
   *
   *  The obvious `event.target === event.currentTarget` test does not work
   *  here: the stage takes pointer capture for panning, and capture retargets
   *  the compatibility `click`/`dblclick` to the capture element — so a click
   *  on the photo arrives reporting the stage as its target, and the viewer
   *  would close the moment you clicked the picture. Geometry is unambiguous. */
  const overImage = (clientX: number, clientY: number) => {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return (
      clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    );
  };

  const onPointerDown = (event: React.PointerEvent) => {
    dragged.current = false;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchDistance.current = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    }
    setInteracting(true);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinchDistance.current > 0 && distance > 0) {
        zoomBy(distance / pinchDistance.current, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
      }
      pinchDistance.current = distance;
      return;
    }
    // A single pointer only pans once there is something to pan; otherwise the
    // drag is left alone so a plain click still reads as a click.
    if (!zoomed) return;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragged.current = true;
    setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
  };

  const endPointer = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchDistance.current = 0;
    if (pointers.current.size === 0) setInteracting(false);
  };

  if (prints.length === 0) return null;

  return (
    <dialog
      ref={dialogRef}
      // Escape fires `cancel` then `close`; routing both back to state keeps
      // React the single source of truth for whether this is open.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          step(1);
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          step(-1);
        }
      }}
      aria-label={print ? `${print.caption}, full size` : "Photo"}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-hidden border-0 bg-transparent p-0 text-text backdrop:bg-transparent"
    >
      {/* The dark ground, as a real element so it can be faded in step with
          the photo rather than fighting ::backdrop. */}
      <div
        aria-hidden="true"
        className={`absolute inset-0 bg-[color-mix(in_srgb,black_88%,transparent)] transition-opacity duration-[240ms] ease-out ${
          shown ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* The stage fills the viewport, so a click anywhere that is not the
          photo itself lands here and closes. Scaling the stage on enter is
          what produces the zoom-in: the photo is centred in it, so it grows
          from the middle of the screen. */}
      <div
        ref={stageRef}
        onClick={(event) => {
          if (dragged.current || overImage(event.clientX, event.clientY)) return;
          onClose();
        }}
        onDoubleClick={(event) => {
          if (overImage(event.clientX, event.clientY)) toggleZoom(event.clientX, event.clientY);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        // Own every touch gesture: the browser's native pan and double-tap
        // zoom would otherwise pre-empt ours.
        style={{ touchAction: "none" }}
        // `scale` is transitioned by name, not through `transform`: Tailwind v4's
        // scale-* utilities set the independent `scale` property, so a
        // transition listing only `transform` fades the photo in at full size
        // with no zoom at all.
        className={`absolute inset-0 grid place-items-center overflow-hidden transition-[opacity,scale] duration-[240ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
          shown ? "scale-100 opacity-100" : "scale-[0.82] opacity-0"
        }`}
      >
        {print && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            key={print.id}
            src={`/api/showcase/${print.id}/photo`}
            alt={print.caption}
            ref={imageRef}
            draggable={false}
            style={{
              transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.zoom})`,
              // Snap back smoothly on a double-tap or wheel step, but follow a
              // drag or pinch frame-for-frame.
              transition: interacting ? "none" : `transform ${TRANSITION_MS}ms cubic-bezier(0.16,1,0.3,1)`,
            }}
            className={`max-h-[86dvh] max-w-[94vw] select-none object-contain shadow-2xl ${
              zoomed ? (interacting ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"
            }`}
          />
        )}
      </div>

      {/* Chrome sits above the stage and after it in the DOM, so its own
          clicks never reach the close-on-click ground. */}
      <div
        className={`pointer-events-none absolute inset-0 transition-opacity duration-[240ms] ease-out ${
          shown ? "opacity-100" : "opacity-0"
        }`}
      >
        {print && (
          <div className="pointer-events-auto absolute inset-x-0 top-0 flex items-start justify-between gap-4 bg-gradient-to-b from-[color-mix(in_srgb,black_75%,transparent)] to-transparent p-4 sm:p-5">
            <div className="min-w-0 text-white">
              <p className="text-sm font-[650]">{print.caption}</p>
              <p className="mt-0.5 text-xs text-white/70">
                {print.material}
                {print.colour ? ` · ${print.colour}` : ""}
                {prints.length > 1 ? ` · ${(openAt ?? 0) + 1} of ${prints.length}` : ""}
                {zoomed ? ` · ${view.zoom.toFixed(1)}×` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-white/80 backdrop-blur-[8px] transition-colors hover:bg-white/20 hover:text-white"
            >
              <X strokeWidth={1.65} className="size-5" />
            </button>
          </div>
        )}

        {prints.length > 1 && (
          <>
            <ArrowButton side="left" onClick={() => step(-1)} />
            <ArrowButton side="right" onClick={() => step(1)} />
          </>
        )}
      </div>
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
      className={`pointer-events-auto absolute top-1/2 -translate-y-1/2 ${side === "left" ? "left-3" : "right-3"} grid size-11 place-items-center rounded-full bg-white/10 text-white/80 backdrop-blur-[8px] transition-colors hover:bg-white/20 hover:text-white`}
    >
      <Icon strokeWidth={1.65} className="size-5" />
    </button>
  );
}
