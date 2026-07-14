import { describe, expect, expectTypeOf, it } from "vitest";
import { CATALOG } from "./catalog";
import { estimateCompletionDate } from "./completion-date";
import { formatFromFilename, sanitizeOriginalName } from "./filename";
import { formatDuration, formatGrams, formatPaise } from "./money";
import { settingsKey, sliceArtifactKey } from "./settings-key";
import { sliceJobId } from "./slice-job";
import { summariseItems } from "./order-summary";
import {
  customerSchema,
  sliceSettingsSchema,
  type Customer,
  type LayerHeightUm,
  type SliceSettings,
} from "./quote-types";
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
    expect(sliceArtifactKey("stl", settings)).toBe("orca-2.4.1-a1-v1:stl:PLA:160:25:auto");
    expect(sliceArtifactKey("obj", settings)).not.toBe(sliceArtifactKey("stl", settings));
  });
});

describe("buildWhatsAppUrl", () => {
  const input = {
    number: "+91 98765-43210",
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
    ).toBe("2× PLA (black), 3× PETG (white)");
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
