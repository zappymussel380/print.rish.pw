import { describe, expect, it } from "vitest";
import { csvCell } from "@/lib/csv";

/**
 * The admin CSV export contains customer-controlled strings (name, city,
 * notes…). Excel/Sheets execute cells whose first non-whitespace character is
 * = + - @ as formulas, so csvCell must force those to text with a leading
 * single quote — while leaving ordinary values and numeric cells untouched and
 * keeping standard CSV quote-escaping intact.
 */
describe("csvCell", () => {
  it.each([
    ["=1+1", "'=1+1"],
    ["+cmd|' /C calc'!A0", "'+cmd|' /C calc'!A0"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1:A9)", "'@SUM(A1:A9)"],
  ])("neutralises a formula trigger: %s", (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it("neutralises triggers hidden behind leading whitespace", () => {
    expect(csvCell("  =HYPERLINK(...)")).toBe("'  =HYPERLINK(...)");
    expect(csvCell("\t=1+1")).toBe("'\t=1+1"); // tab needs no CSV quoting
  });

  it("neutralises cells starting with tab / CR / LF", () => {
    expect(csvCell("\tdata")).toBe("'\tdata");
    expect(csvCell("\rdata")).toBe(`"'\rdata"`); // CR/LF also trigger quoting
    expect(csvCell("\ndata")).toBe(`"'\ndata"`);
  });

  it("leaves ordinary strings untouched", () => {
    expect(csvCell("Rishabh")).toBe("Rishabh");
    expect(csvCell("Guwahati 781001")).toBe("Guwahati 781001");
    expect(csvCell("a - b")).toBe("a - b"); // dash not in first position
  });

  it("leaves numeric cells untouched (negative totals stay numbers)", () => {
    expect(csvCell(-12.5)).toBe("-12.5");
    expect(csvCell(42)).toBe("42");
  });

  it("keeps normal CSV quoting and doubles embedded quotes", () => {
    expect(csvCell('say "hi", ok')).toBe(`"say ""hi"", ok"`);
    expect(csvCell("multi\nline")).toBe(`"multi\nline"`);
  });

  it("quotes a defused cell that also contains separators", () => {
    expect(csvCell('=1+1,"x"')).toBe(`"'=1+1,""x"""`);
  });
});
