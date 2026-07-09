import { describe, expect, it } from "vitest";
import { buildNewQuotationTelegramMessage } from "@/lib/telegram";

describe("Telegram order notification", () => {
  it("includes order summary and protected model download links", () => {
    const message = buildNewQuotationTelegramMessage({
      number: "Q-2026-0001",
      appOrigin: "https://print.rish.pw",
      customer: {
        name: "Test Customer",
        email: "test@example.com",
        phone: "+919999999999",
        city: "Guwahati",
        notes: "Please print cleanly.",
      },
      shippingPaise: 12000,
      shippingPincode: "781001",
      totalPaise: 45000,
      lines: [
        {
          modelId: "model_1",
          fileName: "bracket.stl",
          material: "PETG",
          colour: "Black",
          layerHeightUm: 200,
          infillPct: 15,
          supports: "off",
          quantity: 2,
          totalGrams: 123.4,
          totalPrintSeconds: 7200,
          subtotalPaise: 33000,
        },
      ],
    });

    expect(message).toContain("New print order");
    expect(message).toContain("Quotation: Q-2026-0001");
    expect(message).toContain("https://print.rish.pw/admin");
    expect(message).toContain("https://print.rish.pw/api/models/model_1/file");
    expect(message).toContain("PETG Black, 0.20mm, 15% infill, supports off");
  });

  it("keeps long messages within Telegram's payload budget", () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({
      modelId: `model_${i}`,
      fileName: `very-long-uploaded-file-name-${i}-with-more-detail-than-needed.stl`,
      material: "PLA",
      colour: "White",
      layerHeightUm: 160,
      infillPct: 20,
      supports: "auto",
      quantity: 1,
      totalGrams: 20,
      totalPrintSeconds: 1800,
      subtotalPaise: 10000,
    }));

    const message = buildNewQuotationTelegramMessage({
      number: "Q-2026-0002",
      appOrigin: "https://print.rish.pw",
      customer: {
        name: "Test Customer",
        email: "test@example.com",
        phone: "+919999999999",
        city: "Guwahati",
        notes: "x".repeat(1000),
      },
      shippingPaise: 0,
      shippingPincode: null,
      totalPaise: 300000,
      lines,
    });

    expect(message.length).toBeLessThanOrEqual(3900);
    expect(message).toContain("...truncated. Open admin for the full order");
  });
});
