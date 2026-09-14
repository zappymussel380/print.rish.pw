import { describe, expect, it } from "vitest";
import { STOCK_MATERIAL_IDS } from "./quote-types";
import {
  GUIDE_BLANK_ROW,
  MATERIAL_GUIDE,
  MATERIAL_GUIDE_KEYS,
  MATERIAL_GUIDE_ROWS,
  cleanCustomGuide,
  materialsPageEntries,
} from "./material-guide";
import { normalizeAvailability } from "./catalog-availability-schema";
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
      accent: "red",
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

describe("accent", () => {
  it("keeps a preset, and an unknown one falls back to red but is reported on save", () => {
    expect(normalizeSiteProfile({ accent: "teal" }).accent).toBe("teal");
    expect(normalizeSiteProfile({ accent: "#ff00ff" }).accent).toBe("red");
    expect(findSiteProfileIssues({ accent: "#ff00ff" })).toEqual(["accent"]);
    expect(findSiteProfileIssues({ accent: "blue" })).toEqual([]);
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

  it("has comparison copy for every stock material and every row", () => {
    for (const m of STOCK_MATERIAL_IDS) {
      expect(MATERIAL_GUIDE[m].subtitle.length).toBeGreaterThan(0);
      for (const row of MATERIAL_GUIDE_ROWS) expect(MATERIAL_GUIDE[m][row.key].length).toBeGreaterThan(10);
    }
  });
});

describe("the shop's own materials on /materials", () => {
  const names = normalizeAvailability({
    customMaterials: {
      OTHER_1: { name: "PA-CF", guide: { subtitle: "Carbon-fibre nylon", strength: " Very   stiff. ", junk: "x" } },
      OTHER_2: { name: "PC" },
      OTHER_3: { guide: { strength: "orphaned" } },
    },
  }).customMaterials;

  it("keeps the owner's copy tidied, only with a name", () => {
    expect(names).toEqual({
      OTHER_1: { name: "PA-CF", guide: { subtitle: "Carbon-fibre nylon", strength: "Very stiff." } },
      OTHER_2: { name: "PC" },
    });
    expect(cleanCustomGuide({ strength: "   " })).toBeNull();
    expect(cleanCustomGuide({ subtitle: "x".repeat(81) })).toBeNull();
    expect(cleanCustomGuide("nope")).toBeNull();
  });

  it("can be picked for the page, and a Site save keeps them", () => {
    expect(normalizeSiteProfile({ materialsPage: ["PLA", "OTHER_1"] }).materialsPage).toEqual(["PLA", "OTHER_1"]);
    expect(findSiteProfileIssues({ materialsPage: ["OTHER_9"] })).toEqual(["materialsPage"]);
  });

  it("show with their copy, blanks asking; without copy or a name they drop out", () => {
    const shown = materialsPageEntries(["PLA", "OTHER_1", "OTHER_2", "OTHER_4"], names);
    expect(shown.map((m) => [m.id, m.name])).toEqual([
      ["PLA", "PLA"],
      ["OTHER_1", "PA-CF"],
    ]);
    const own = shown[1]!.guide;
    expect(own.subtitle).toBe("Carbon-fibre nylon");
    expect(own.strength).toBe("Very stiff.");
    expect(own.uv).toBe(GUIDE_BLANK_ROW);
    for (const key of MATERIAL_GUIDE_KEYS) expect(typeof own[key]).toBe("string");
    // Nothing left to show: the default pair.
    expect(materialsPageEntries(["OTHER_2"], names).map((m) => m.id)).toEqual(["PLA", "PETG"]);
  });
});
