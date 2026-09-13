import { describe, expect, it } from "vitest";
import { QUOTATION_NUMBER_RE, formatQuotationNumber, initialsFor } from "./quotation-number";

describe("quotation numbers", () => {
  it("formats under the shop's initials, padding the sequence", () => {
    expect(formatQuotationNumber("AP", 2026, 7)).toBe("AP-2026-0007");
    expect(formatQuotationNumber("RSP", 2026, 12345)).toBe("RSP-2026-12345");
    expect(formatQuotationNumber("bad!", 2026, 1)).toBe("RSP-2026-0001");
  });

  it("accepts numbers under any valid initials, so old numbers survive a change", () => {
    for (const ok of ["RSP-2026-0001", "AP-2027-0420", "BRMSC-2026-12345"]) {
      expect(QUOTATION_NUMBER_RE.test(ok), ok).toBe(true);
    }
    for (const bad of ["R-2026-0001", "rsp-2026-0001", "RSP-26-0001", "RSP-2026-001", "../RSP-2026-0001", "RSPXYZ-2026-0001"]) {
      expect(QUOTATION_NUMBER_RE.test(bad), bad).toBe(false);
    }
  });

  it("suggests initials from the shop name", () => {
    expect(initialsFor("Acme Prints")).toBe("AP");
    expect(initialsFor("print.rish.pw")).toBe("PRP");
    expect(initialsFor("Printery")).toBe("PRI");
    expect(initialsFor("3D Hub")).toBe("DH");
    expect(initialsFor("Big Red Maker Space Co Ltd")).toBe("BRMSC");
    expect(initialsFor("a")).toBe("RSP");
  });
});
