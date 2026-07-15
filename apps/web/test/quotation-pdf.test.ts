import { describe, expect, it } from "vitest";
import * as React from "react";
import { Document, Page, renderToBuffer } from "@react-pdf/renderer";
import { PrinterMarkPdf } from "@/lib/pdf/printer-mark-pdf";
import {
  renderQuotationPdf,
  type PdfAnnexure,
  type QuotationPdfData,
} from "@/lib/pdf/quotation-pdf";

/** 1x1 red pixel. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function annexure(overrides: Partial<PdfAnnexure> = {}): PdfAnnexure {
  return {
    fileName: "bracket.stl",
    thumbnailPng: null,
    geometry: { bboxXMm: 20, bboxYMm: 30.5, bboxZMm: 10, volumeCm3: 8.2, format: "stl", sizeBytes: 2663084 },
    settings: { material: "PLA", colour: "black", layerHeightUm: 200, infillPct: 15, supports: "auto", quantity: 1 },
    slicer: { filamentGrams: 12.5, filamentMm: 4183, printSeconds: 3600, slicerVersion: "OrcaSlicer 2.4.1" },
    pricing: { materialPaise: 5000, electricityPaise: 2000, maintenancePaise: 900, subtotalPaise: 9900 },
    ...overrides,
  };
}

/** Content streams in react-pdf output are FlateDecoded, so text cannot be
 *  asserted directly. The page-tree object is uncompressed, which makes the
 *  page count a reliable structural assertion. */
function pageCount(pdf: Buffer): number {
  const match = /\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/.exec(pdf.toString("latin1"));
  if (!match) throw new Error("no /Pages object found");
  return Number(match[1]);
}

function fixture(overrides: Partial<QuotationPdfData> = {}): QuotationPdfData {
  return {
    number: "RSP-2026-0042",
    createdAt: new Date("2026-07-15T10:00:00Z"),
    customer: {
      name: "Test Customer",
      email: "test@example.com",
      phone: "9999999999",
      city: "Chennai",
      notes: "",
    },
    lines: [
      {
        fileName: "bracket.stl",
        material: "PLA",
        colour: "black",
        layerHeightUm: 200,
        infillPct: 15,
        supports: "auto",
        quantity: 1,
        totalGrams: 12.5,
        totalPrintSeconds: 3600,
        subtotalPaise: 9900,
      },
    ],
    setupFeePaise: 5000,
    totalPaise: 14900,
    totalGrams: 12.5,
    totalPrintSeconds: 3600,
    completion: null,
    annexures: [],
    ...overrides,
  };
}

describe("renderQuotationPdf", () => {
  it("renders a single-page PDF for a quotation without annexures", async () => {
    const pdf = await renderQuotationPdf(fixture());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(1);
  });

  it("adds one annexure page per model, with and without a thumbnail", async () => {
    const base = await renderQuotationPdf(fixture());
    const pdf = await renderQuotationPdf(
      fixture({
        annexures: [
          annexure({ thumbnailPng: TINY_PNG }),
          annexure({ fileName: "case.3mf", thumbnailPng: null }),
        ],
      }),
    );
    expect(pageCount(pdf)).toBe(3);
    expect(pdf.length).toBeGreaterThan(base.length);
  });
});

describe("PrinterMarkPdf", () => {
  it("renders inside a react-pdf document", async () => {
    const pdf = await renderToBuffer(
      React.createElement(
        Document,
        null,
        React.createElement(Page, { size: "A4" }, React.createElement(PrinterMarkPdf, null)),
      ),
    );
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
