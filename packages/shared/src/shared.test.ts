import { describe, expect, expectTypeOf, it } from "vitest";
import { CATALOG } from "./catalog";
import { estimateCompletionDate } from "./completion-date";
import {
  formatFromFilename,
  sanitizeOriginalName,
  uploadFormatFromFilename,
} from "./filename";
import { formatDuration, formatGrams, formatPaise } from "./money";
import { SLICE_PIPELINE_VERSION, settingsKey, sliceArtifactKey } from "./settings-key";
import { sliceJobId } from "./slice-job";
import { summariseItems } from "./order-summary";
import { formatTaxRate, taxOn, withTax } from "./tax-settings";
import { shippingParcelKey } from "./shipping-binding";
import { normalizeTax } from "./tax-settings-schema";
import { estimateOrderProfitPaise } from "./costs";
import { supportsSummary } from "./supports";
import { customerSchema, sliceSettingsSchema, type Customer, type SliceSettings } from "./quote-schema";
import type { LayerHeightUm } from "./quote-types";
import { buildWhatsAppMessage, buildWhatsAppUrl } from "./whatsapp";

describe("quote schemas", () => {
  const customer = {
    name: " Asha Das ",
    email: " asha@example.com ",
    phone: " +91 98765 43210 ",
    city: " Guwahati ",
  };

  it("keeps customer normalization and the notes default", () => {
    expect(customerSchema.parse(customer)).toEqual({
      name: "Asha Das",
      email: "asha@example.com",
      phone: "+91 98765 43210",
      city: "Guwahati",
      notes: "",
    });
    expect(customerSchema.parse({ ...customer, notes: undefined }).notes).toBe("");
    expectTypeOf<Customer["notes"]>().toEqualTypeOf<string>();
    expect(customerSchema.safeParse({ ...customer, email: "not-an-email" }).success).toBe(false);
  });

  it("keeps layer heights restricted and narrowly inferred", () => {
    expect(
      sliceSettingsSchema.safeParse({
        material: "PLA",
        layerHeightUm: 180,
        infillPct: 15,
        supports: "auto",
      }).success,
    ).toBe(false);
    expectTypeOf<SliceSettings["layerHeightUm"]>().toEqualTypeOf<LayerHeightUm>();
  });
});

describe("settingsKey", () => {
  it("is stable and excludes colour/quantity by construction", () => {
    expect(
      settingsKey({ material: "PLA", layerHeightUm: 160, infillPct: 25, supports: "auto" }),
    ).toBe("PLA:160:25:auto");
  });

  it("scopes persistent cache entries to format and slicer/profile version", () => {
    const settings = { material: "PLA", layerHeightUm: 160, infillPct: 25, supports: "auto" } as const;
    // Pinned to the constant, not a literal: bumping the pipeline version is a
    // deliberate cache invalidation, not a test to update.
    expect(sliceArtifactKey("stl", settings)).toBe(
      `${SLICE_PIPELINE_VERSION}:stl:PLA:160:25:auto`,
    );
    expect(sliceArtifactKey("obj", settings)).not.toBe(sliceArtifactKey("stl", settings));
  });
});

describe("buildWhatsAppUrl", () => {
  const input = {
    number: "+91 98765-43210",
    brandName: "print.rish.pw",
    quotationNumber: "RSP-2026-0042",
    customerName: "Asha",
    materialsSummary: "2× PLA (black)",
    totalPaise: 45050,
    shippingPaise: 0,
    shippingPincode: null,
  };

  it("normalises the number and URL-encodes the message", () => {
    const url = buildWhatsAppUrl(input);
    expect(url.startsWith("https://wa.me/919876543210?text=")).toBe(true);
    expect(url).not.toContain(" ");
    const text = decodeURIComponent(url.split("?text=")[1]!);
    expect(text).toContain("RSP-2026-0042");
    expect(text).toContain("₹450.50");
  });

  it("names the shop the quotation was submitted on", () => {
    expect(buildWhatsAppMessage(input)).toContain("RSP-2026-0042* on print.rish.pw.");
    expect(buildWhatsAppMessage({ ...input, brandName: "Acme Prints" })).toContain(
      "on Acme Prints.",
    );
  });

  it("states that shipping is excluded when the quote has none", () => {
    // Payment is agreed in this chat, so a shipping-excluded total must never
    // read as the full amount owed.
    const msg = buildWhatsAppMessage(input);
    expect(msg).toContain("Shipping: not included — to be confirmed");
  });

  it("shows the prepaid shipping line when the quote includes it", () => {
    const msg = buildWhatsAppMessage({
      ...input,
      totalPaise: 53050,
      shippingPaise: 8000,
      shippingPincode: "781001",
    });
    expect(msg).toContain("Shipping: ₹80.00 to 781001 (included in total)");
    expect(msg).not.toContain("not included");
  });

  it("clips very long notes", () => {
    const msg = buildWhatsAppMessage({ ...input, notes: "x".repeat(2000) });
    expect(msg.length).toBeLessThan(1200);
    expect(msg).toContain("…");
  });

  it("throws when the number is unconfigured", () => {
    expect(() => buildWhatsAppUrl({ ...input, number: "" })).toThrow();
  });
});

describe("sanitizeOriginalName", () => {
  it("strips directory components", () => {
    expect(sanitizeOriginalName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeOriginalName("C:\\Users\\x\\benchy.stl")).toBe("benchy.stl");
  });

  it("removes control and bidi characters", () => {
    expect(sanitizeOriginalName("mod\u0001el\u202e.stl")).toBe("model.stl");
  });

  it("falls back for empty results", () => {
    expect(sanitizeOriginalName("///")).toBe("model");
  });

  it("caps length but keeps the extension", () => {
    const out = sanitizeOriginalName(`${"a".repeat(500)}.stl`);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith(".stl")).toBe(true);
  });
});

describe("formatFromFilename", () => {
  it("maps known extensions case-insensitively", () => {
    expect(formatFromFilename("part.STL")).toBe("stl");
    expect(formatFromFilename("part.3mf")).toBe("3mf");
    expect(formatFromFilename("part.gcode")).toBeNull();
    expect(formatFromFilename("no-extension")).toBeNull();
  });

  it("does not treat STEP as a mesh format", () => {
    expect(formatFromFilename("part.step")).toBeNull();
    expect(formatFromFilename("part.stp")).toBeNull();
  });
});

describe("uploadFormatFromFilename", () => {
  it("accepts every mesh format plus STEP aliases", () => {
    expect(uploadFormatFromFilename("part.STL")).toBe("stl");
    expect(uploadFormatFromFilename("part.3mf")).toBe("3mf");
    expect(uploadFormatFromFilename("bracket.step")).toBe("step");
    expect(uploadFormatFromFilename("bracket.STP")).toBe("step");
    expect(uploadFormatFromFilename("bracket.StEp")).toBe("step");
  });

  it("still rejects unknown extensions", () => {
    expect(uploadFormatFromFilename("part.gcode")).toBeNull();
    expect(uploadFormatFromFilename("no-extension")).toBeNull();
    expect(uploadFormatFromFilename("archive.steps")).toBeNull();
  });
});

describe("estimateCompletionDate", () => {
  it("spreads print hours over days and adds the buffer", () => {
    const from = new Date("2026-07-05T10:00:00Z");
    // 20h of printing at 8h/day = 3 days + 2 buffer = 5 days
    const eta = estimateCompletionDate(20 * 3600, CATALOG.leadTime, from);
    expect(eta.toISOString().slice(0, 10)).toBe("2026-07-10");
  });

  it("has a floor of one print day", () => {
    const from = new Date("2026-07-05T10:00:00Z");
    const eta = estimateCompletionDate(60, CATALOG.leadTime, from);
    expect(eta.toISOString().slice(0, 10)).toBe("2026-07-08");
  });
});

describe("sliceJobId", () => {
  it("is colon-free so BullMQ never splits it into Redis key segments", () => {
    const attemptId = "11111111-1111-4111-8111-111111111111";
    const id = sliceJobId("a".repeat(64), "PLA:200:15:auto", attemptId);
    expect(id).not.toContain(":");
    expect(id).toBe(`slice_${"a".repeat(64)}_PLA-200-15-auto_${attemptId}`);
  });
  it("deduplicates one attempt but separates retry generations", () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    expect(sliceJobId("abc", "PLA:200:15:auto", first)).toBe(
      sliceJobId("abc", "PLA:200:15:auto", first),
    );
    expect(sliceJobId("abc", "PLA:200:15:auto", first)).not.toBe(
      sliceJobId("abc", "PLA:200:15:auto", second),
    );
  });
});

describe("summariseItems", () => {
  it("groups by material + colour and sums quantity", () => {
    expect(
      summariseItems([
        { material: "PLA", colour: "black", quantity: 1 },
        { material: "PLA", colour: "black", quantity: 1 },
        { material: "PETG", colour: "white", quantity: 3 },
      ]),
    ).toBe("2× PLA (Black), 3× PETG (White)");
  });

  it("names premium tiers and their colours for humans", () => {
    expect(
      summariseItems([
        { material: "PLA_AESTHETIC", colour: "silk-copper", quantity: 2 },
        { material: "PETG_PREMIUM", colour: "translucent-ice-blue-glitter", quantity: 1 },
      ]),
    ).toBe("2× Aesthetic PLA (Silk Copper), 1× PETG Premium (Translucent Ice Blue Glitter)");
  });
});

describe("money formatting", () => {
  it("formats paise as INR", () => {
    expect(formatPaise(15000)).toContain("150");
    expect(formatPaise(45050)).toContain("450.50");
  });
  it("formats durations and weights", () => {
    expect(formatDuration(2439)).toBe("41m");
    expect(formatDuration(7500)).toBe("2h 5m");
    expect(formatGrams(5.11)).toBe("5.1 g");
    expect(formatGrams(1234)).toBe("1.23 kg");
  });
});

describe("sales GST", () => {
  it("adds GST on printing + setup + shipping, rounded to the paisa", () => {
    expect(taxOn(10_000, 1800)).toBe(1800);
    expect(taxOn(333, 1800)).toBe(60); // 59.94
    expect(withTax(15_756, 9_000, { enabled: true, rateBp: 1800 })).toEqual({ taxPaise: 4456, grandTotalPaise: 29_212 });
    expect(withTax(15_756, 0, { enabled: false, rateBp: 1800 })).toEqual({ taxPaise: 0, grandTotalPaise: 15_756 });
    expect(formatTaxRate(1800)).toBe("18%");
    expect(formatTaxRate(1250)).toBe("12.5%");
  });

  it("is only ever on with a rate, HSN and a valid GSTIN", () => {
    const ok = { enabled: true, rateBp: 1800, hsn: "9988", gstin: "18AABCU9603R1ZM" };
    expect(normalizeTax(ok)).toEqual(ok);
    expect(normalizeTax({ ...ok, gstin: "18AABCU9603R1Z" }).enabled).toBe(false);
    expect(normalizeTax({ ...ok, hsn: "99" }).enabled).toBe(false);
    expect(normalizeTax({ ...ok, rateBp: 5000 })).toMatchObject({ rateBp: 1800 });
    expect(normalizeTax(null)).toEqual({ enabled: false, rateBp: 1800, hsn: "", gstin: "" });
  });

  it("keeps GST out of profit, and says it in the WhatsApp message", () => {
    const order = { totalPaise: 29_212, shippingPaise: 9_000, taxPaise: 4_456 };
    expect(estimateOrderProfitPaise(order, [])).toBe(15_756);
    const msg = buildWhatsAppMessage({
      brandName: "Shop", quotationNumber: "RSP-2026-0001", customerName: "A", materialsSummary: "1× PLA",
      totalPaise: 29_212, shippingPaise: 9_000, shippingPincode: "411001", taxPaise: 4_456, taxRate: "18%",
    });
    expect(msg).toContain("GST (18%): ₹44.56 (included in total)");
  });
});

describe("supportsSummary", () => {
  it("says what the slicer did, not just the setting", () => {
    expect(supportsSummary("off", 0)).toEqual({ label: "Off", detail: "Off — printed without supports" });
    expect(supportsSummary("auto", 2.55)).toEqual({ label: "Auto, added (2.6 g)", detail: "Auto — added by the slicer (2.6 g of supports)" });
    expect(supportsSummary("auto", 0).label).toBe("Auto, none needed");
    // Slices from before supports were measured.
    expect(supportsSummary("auto", null).label).toBe("Auto");
    expect(supportsSummary("always", 4).detail).toBe("On everywhere — 4 g of supports");
    expect(supportsSummary("always", null).label).toBe("On");
  });
});

describe("shippingParcelKey", () => {
  it("keeps an estimate across edits that ship as the same parcel", () => {
    // 100 g + packaging is the 0.5 kg slab; ₹862.29 declares as ₹862.
    const key = shippingParcelKey(100, 86229);
    expect(key).toBe("0.5:862");
    expect(shippingParcelKey(100.1, 86240)).toBe(key);
  });

  it("changes when the courier would price it differently", () => {
    const key = shippingParcelKey(100, 86229);
    expect(shippingParcelKey(301, 86229)).not.toBe(key); // next 0.5 kg slab
    expect(shippingParcelKey(100, 86260)).not.toBe(key); // declared value rounds to ₹863
  });
});
