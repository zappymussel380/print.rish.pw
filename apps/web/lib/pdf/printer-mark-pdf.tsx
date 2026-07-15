import * as React from "react";
import { Path, Svg } from "@react-pdf/renderer";

/** react-pdf port of components/shell/printer-mark.tsx — the same line-art
 *  bed-slinger mark, with `currentColor` replaced by an explicit color prop. */
const PATHS = [
  // gantry beam + frame posts
  "M4 5h16",
  "M5.5 5v13",
  "M18.5 5v13",
  // toolhead carriage + nozzle
  "M12 5v2.5",
  "M10.8 7.5h2.4L12 9.6z",
  // heatbed
  "M3.5 18h17",
  // part mid-print, with a layer line
  "M9.8 18v-3h4.4v3",
  "M9.8 16.5h4.4",
];

export function PrinterMarkPdf({ size = 22, color = "#ff5555" }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {PATHS.map((d) => (
        <Path
          key={d}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}
