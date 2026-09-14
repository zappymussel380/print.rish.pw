import { describe, expect, it } from "vitest";
import { MATERIAL_IDS } from "./quote-types";
import { MATERIAL_GUIDE, MATERIAL_GUIDE_ROWS } from "./material-guide";
import { DEFAULT_SITE_PROFILE, listJoin, splitBrand } from "./site-profile";
import { findSiteProfileIssues, normalizeSiteProfile } from "./site-profile-schema";

describe("normalizeSiteProfile", () => {
  it("reproduces print.rish.pw exactly when nothing is stored", () => {
    const p = normalizeSiteProfile(null);
    expect(p).toEqual({
      brandName: "print.rish.pw",
      tagline: "instant 3D printing quotes",
      city: "Guwahati",
      contact: { whatsappNumber: "", email: "", phone: "", address: "" },
      footerNote: "A rish.pw project",
      materialsPage: ["PLA", "PETG"],
      quotationPrefix: "RSP",
    });
    // A copy, not the shared default.
    p.materialsPage.push("ABS");
    expect(DEFAULT_SITE_PROFILE.materialsPage).toEqual(["PLA", "PETG"]);
  });

  it("keeps valid fields, normalises the WhatsApp number, dedupes materials", () => {
    const p = normalizeSiteProfile({
      brandName: "  Acme Prints ",
      city: "Pune",
      contact: { whatsappNumber: "+91 98765-43210", email: "hi@acme.in", phone: "+91 98765 43210" },
      materialsPage: ["ABS", "ASA", "ABS"],
    });
    expect(p.brandName).toBe("Acme Prints");
    expect(p.city).toBe("Pune");
    expect(p.contact).toEqual({
      whatsappNumber: "919876543210",
      email: "hi@acme.in",
      phone: "+91 98765 43210",
      address: "",
    });
    expect(p.materialsPage).toEqual(["ABS", "ASA"]);
    expect(p.footerNote).toBe(DEFAULT_SITE_PROFILE.footerNote);
  });

  it("replaces invalid fields with defaults rather than failing", () => {
    const p = normalizeSiteProfile({
      brandName: "",
      contact: { email: "not-an-email", whatsappNumber: "12" },
      materialsPage: [],
    });
    expect(p.brandName).toBe("print.rish.pw");
    expect(p.contact.email).toBe("");
    expect(p.contact.whatsappNumber).toBe("");
    expect(p.materialsPage).toEqual(["PLA", "PETG"]);
  });

  it("upper-cases quotation initials and rejects anything that isn't 2–5 letters", () => {
    expect(normalizeSiteProfile({ quotationPrefix: " ap " }).quotationPrefix).toBe("AP");
    for (const bad of ["A", "ABCDEF", "A1", "A-P", 42]) {
      expect(normalizeSiteProfile({ quotationPrefix: bad }).quotationPrefix).toBe("RSP");
    }
    expect(findSiteProfileIssues({ quotationPrefix: "A1" })).toEqual(["quotationPrefix"]);
  });

  it("lets a shop clear optional fields", () => {
    const p = normalizeSiteProfile({ tagline: "", city: "", footerNote: "" });
    expect([p.tagline, p.city, p.footerNote]).toEqual(["", "", ""]);
  });
});

describe("findSiteProfileIssues", () => {
  it("names every field a save would have to discard", () => {
    expect(findSiteProfileIssues({ brandName: "Acme" })).toEqual([]);
    expect(
      findSiteProfileIssues({
        brandName: "   ",
        contact: { email: "nope", phone: "call me" },
        materialsPage: ["PLA", "NYLON"],
        footerNote: "x".repeat(500),
      }),
    ).toEqual(["brandName", "contact.email", "contact.phone", "footerNote", "materialsPage"]);
  });
});

describe("helpers", () => {
  it("splits the brand for the wordmark", () => {
    expect(splitBrand("print.rish.pw")).toEqual({ accent: "print", rest: ".rish.pw" });
    expect(splitBrand("Acme Prints")).toEqual({ accent: "Acme", rest: " Prints" });
    expect(splitBrand("Printery")).toEqual({ accent: "Printery", rest: "" });
    expect(splitBrand(".hidden")).toEqual({ accent: ".hidden", rest: "" });
  });

  it("joins lists the way the copy reads", () => {
    expect(listJoin([])).toBe("");
    expect(listJoin(["PLA"])).toBe("PLA");
    expect(listJoin(["PLA", "PETG"])).toBe("PLA and PETG");
    expect(listJoin(["PLA", "PETG", "ABS"])).toBe("PLA, PETG and ABS");
  });

  it("has comparison copy for every material and every row", () => {
    for (const m of MATERIAL_IDS) {
      expect(MATERIAL_GUIDE[m].subtitle.length).toBeGreaterThan(0);
      for (const row of MATERIAL_GUIDE_ROWS) expect(MATERIAL_GUIDE[m][row.key].length).toBeGreaterThan(10);
    }
  });
});
