import { inflateSync } from "node:zlib";
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
    slicer: { filamentGrams: 12.5, filamentMm: 4183, printSeconds: 3600, slicerVersion: "OrcaSlicer 2.4.1", supportGrams: 1.4 },
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

/** The text drawn on the pages: every FlateDecoded content stream inflated,
 *  and each text-showing operator's strings (react-pdf writes the standard
 *  fonts' text as hex strings inside TJ arrays) decoded and joined, one line
 *  per operator. */
function pdfText(pdf: Buffer): string {
  const lines: string[] = [];
  for (const match of pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body: string;
    try {
      body = inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const op of body.matchAll(/\[([^\]]*)\]\s*TJ|(<[0-9a-fA-F]*>)\s*Tj/g)) {
      const operand = op[1] ?? op[2]!;
      lines.push([...operand.matchAll(/<([0-9a-fA-F]*)>/g)].map((m) => Buffer.from(m[1]!, "hex").toString("latin1")).join(""));
    }
  }
  return lines.join("\n");
}

function fixture(overrides: Partial<QuotationPdfData> = {}): QuotationPdfData {
  return {
    brandName: "print.rish.pw",
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

describe("round off", () => {
  it("shows the round-off line and a whole-rupee total, with the materials summed from the lines", async () => {
    // 99 + 50 setup = 149.00 exactly → no line; 98.75 + 50 = 148.75 → +0.25, Rs 149.
    const plain = pdfText(await renderQuotationPdf(fixture()));
    expect(plain).not.toContain("Round off");
    expect(plain.replace(/\n/g, "")).toContain("TotalRs 149");

    const rounded = pdfText(
      await renderQuotationPdf(
        fixture({
          lines: [{ ...fixture().lines[0]!, subtotalPaise: 9875 }],
          roundOffPaise: 25,
          totalPaise: 14_900,
        }),
      ),
    );
    // Operators split where the font kerns, so read the totals block run together.
    const flat = rounded.replace(/\n/g, "");
    expect(flat).toContain("Materials subtotalRs 98.75"); // summed from the lines
    expect(flat).toContain("Round off+Rs 0.25TotalRs 149");
    expect(flat).not.toContain("Rs 149.00");
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
