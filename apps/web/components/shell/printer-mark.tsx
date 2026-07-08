/**
 * Minimal line-art mark of an open-frame bed-slinger 3D printer (à la the Bambu
 * Lab A1): a gantry beam on two posts, a centred toolhead extruding onto the
 * heatbed with a part mid-print. Drawn with `currentColor` and the same stroke
 * weight as the lucide icons used elsewhere, so it inherits the accent colour.
 */
export function PrinterMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* gantry beam + frame posts */}
      <path d="M4 5h16" />
      <path d="M5.5 5v13" />
      <path d="M18.5 5v13" />
      {/* toolhead carriage + nozzle */}
      <path d="M12 5v2.5" />
      <path d="M10.8 7.5h2.4L12 9.6z" />
      {/* heatbed */}
      <path d="M3.5 18h17" />
      {/* part mid-print, with a layer line */}
      <path d="M9.8 18v-3h4.4v3" />
      <path d="M9.8 16.5h4.4" />
    </svg>
  );
}
