import { describe, expect, it } from "vitest";
import { parseOrcaProgressLine } from "./orca";

describe("parseOrcaProgressLine", () => {
  it("reads Orca's total percentage and operation message", () => {
    expect(
      parseOrcaProgressLine(
        JSON.stringify({ total_percent: 47, plate_percent: 49, message: "Generating infill" }),
      ),
    ).toEqual({ percent: 47, message: "Generating infill" });
  });

  it("caps slicer progress until application finalization is complete", () => {
    expect(parseOrcaProgressLine('{"total_percent":100,"message":"Finished"}')).toEqual({
      percent: 95,
      message: "Finished",
    });
  });

  it("rejects malformed and non-numeric progress records", () => {
    expect(parseOrcaProgressLine("not-json")).toBeNull();
    expect(parseOrcaProgressLine('{"total_percent":"50"}')).toBeNull();
  });
});
