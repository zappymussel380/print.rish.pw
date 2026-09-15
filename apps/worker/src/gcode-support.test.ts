import { describe, expect, it } from "vitest";
import { supportGramsOf, supportShare } from "./gcode-support";

const orca = (lines: string[]) => lines.join("\n");

describe("supportShare", () => {
  it("counts extrusion under Orca's support features, relative E", () => {
    const g = orca([
      "M83",
      "; FEATURE: Outer wall",
      "G1 X10 Y0 E1.5",
      "G1 E-0.8 ; retract",
      "G1 X20 Y5 F12000 ; travel",
      "G1 E0.8 ; unretract, not extrusion",
      "; FEATURE: Support",
      "G1 X21 Y5 E0.5",
      "G2 X22 Y6 I1 J0 E0.25",
      "; FEATURE: Support interface",
      "G1 X23 Y6 E0.25",
      "; FEATURE: Sparse infill",
      "G1 X30 Y6 E1.5",
    ]);
    expect(supportShare(g)).toEqual({ supportMm: 1, totalMm: 4 });
    expect(supportGramsOf(g, 10)).toBe(2.5);
  });

  it("follows absolute E and G92 resets", () => {
    const g = orca(["M82", "G92 E0", "; FEATURE: Outer wall", "G1 X1 Y0 E2", "; FEATURE: Support", "G1 X2 Y0 E3", "G92 E0", "G1 X3 Y0 E1"]);
    expect(supportShare(g)).toEqual({ supportMm: 2, totalMm: 4 });
  });

  it("reports none for a part without supports, and nothing for no extrusion", () => {
    expect(supportGramsOf(orca(["M83", "; FEATURE: Outer wall", "G1 X1 Y1 E2"]), 3.78)).toBe(0);
    expect(supportShare(orca(["M83", "G1 X1 Y1"]))).toBeNull();
  });
});
