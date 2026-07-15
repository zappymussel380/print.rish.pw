import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}));

const fs = vi.hoisted(() => ({ writeFile: vi.fn() }));

const storage = vi.hoisted(() => ({
  ensureStorageDirs: vi.fn(async () => {}),
  hasPdfStorageHeadroom: vi.fn(async () => true),
  pdfPath: vi.fn((number: string) => `/data/pdfs/${number}.pdf`),
  removeQuietly: vi.fn(async () => {}),
}));

const security = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(() => true),
  withRedisLock: vi.fn(
    async (_name: string, action: () => Promise<unknown>): Promise<unknown> => {
      await action();
      return true;
    },
  ),
}));

const requireAdminApi = vi.hoisted(() => vi.fn(async (): Promise<Response | null> => null));

const renderQuotationPdf = vi.hoisted(() =>
  vi.fn(async (_data: unknown) => Buffer.from("%PDF-regenerated")),
);
const readThumbPng = vi.hoisted(() => vi.fn(async () => null));

vi.mock("@print/db", () => ({
  prisma: { quotation: { findUnique: db.findUnique, update: db.update } },
}));
vi.mock("node:fs/promises", () => ({ writeFile: fs.writeFile }));
vi.mock("@/lib/storage", () => storage);
vi.mock("@/lib/security", () => security);
vi.mock("@/lib/api-util", () => ({
  requireAdminApi,
  jsonError: (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status }),
}));
vi.mock("@/lib/env", () => ({ env: { storageReserveBytes: 1024 } }));
vi.mock("@/lib/pdf/quotation-pdf", () => ({ renderQuotationPdf }));
vi.mock("@/lib/thumbs", () => ({ readThumbPng }));

const { POST } = await import("@/app/api/admin/quotations/[id]/regenerate-pdf/route");

class FakeDecimal {
  constructor(private readonly value: string) {}
  toString() {
    return this.value;
  }
}

const quotation = {
  id: "quote-id",
  number: "RSP-2026-0002",
  createdAt: new Date("2026-07-15T10:00:00Z"),
  customerName: "Madhusudhan V",
  customerEmail: "madhu@example.com",
  customerPhone: "9894526672",
  customerCity: "Chennai",
  notes: "Handle with care",
  setupFeePaise: 5000,
  shippingPaise: 0,
  totalPaise: 86229,
  estimatedCompletion: new Date("2026-07-20T10:00:00Z"),
  pdfPath: "/data/pdfs/RSP-2026-0002.pdf",
  items: [
    {
      material: "PETG",
      colour: "black",
      layerHeightUm: 200,
      infillPct: 15,
      supports: "AUTO",
      quantity: 2,
      unitGrams: new FakeDecimal("19.3"),
      unitPrintSeconds: 3060,
      materialPaise: 5790,
      electricityPaise: 1836,
      maintenancePaise: 2027,
      subtotalPaise: 9653,
      model: {
        id: "model-1",
        originalName: "Spacer_Plate.STL",
        format: "stl",
        sizeBytes: 2_482_684,
        fileHash: "hash-1",
        thumbPath: "/data/uploads/thumbs/model-1.png",
        bboxXMm: new FakeDecimal("62.4"),
        bboxYMm: new FakeDecimal("40"),
        bboxZMm: new FakeDecimal("18.2"),
        volumeCm3: new FakeDecimal("31.7"),
      },
      sliceResult: {
        filamentGrams: new FakeDecimal("19.3"),
        filamentMm: new FakeDecimal("6470"),
        printSeconds: 3060,
        slicerVersion: "OrcaSlicer 2.3.0",
      },
    },
  ],
};

function request(): NextRequest {
  return new Request("https://print.rish.pw/api/admin/quotations/quote-id/regenerate-pdf", {
    method: "POST",
  }) as NextRequest;
}

const ctx = { params: Promise.resolve({ id: "quote-id" }) };

describe("admin PDF regeneration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.findUnique.mockResolvedValue(quotation);
    db.update.mockResolvedValue({ id: "quote-id" });
    requireAdminApi.mockResolvedValue(null);
    security.assertSameOrigin.mockReturnValue(true);
    storage.hasPdfStorageHeadroom.mockResolvedValue(true);
    renderQuotationPdf.mockResolvedValue(Buffer.from("%PDF-regenerated"));
  });

  it("rebuilds the PDF from frozen items and persists it under the write lock", async () => {
    const response = await POST(request(), ctx);

    expect(response.status).toBe(200);
    expect(renderQuotationPdf).toHaveBeenCalledTimes(1);
    const data = renderQuotationPdf.mock.calls[0]![0] as Record<string, unknown>;
    expect(data).toMatchObject({
      number: "RSP-2026-0002",
      setupFeePaise: 5000,
      shippingPaise: 0,
      totalPaise: 86229,
      customer: {
        name: "Madhusudhan V",
        email: "madhu@example.com",
        phone: "9894526672",
        city: "Chennai",
        notes: "Handle with care",
      },
    });
    expect(data.lines).toEqual([
      {
        fileName: "Spacer_Plate.STL",
        material: "PETG",
        colour: "black",
        layerHeightUm: 200,
        infillPct: 15,
        supports: "auto",
        quantity: 2,
        totalGrams: 38.6,
        totalPrintSeconds: 6120,
        subtotalPaise: 9653,
      },
    ]);
    expect(data.totalGrams).toBeCloseTo(38.6);
    expect(data.totalPrintSeconds).toBe(6120);
    const annexures = data.annexures as Array<Record<string, unknown>>;
    expect(annexures).toHaveLength(1);
    expect(annexures[0]).toMatchObject({
      fileName: "Spacer_Plate.STL",
      geometry: { bboxXMm: 62.4, volumeCm3: 31.7, format: "stl", sizeBytes: 2_482_684 },
      slicer: { filamentGrams: 19.3, printSeconds: 3060, slicerVersion: "OrcaSlicer 2.3.0" },
      settings: { supports: "auto", quantity: 2 },
    });
    expect(readThumbPng).toHaveBeenCalledWith(
      "model-1",
      "hash-1",
      "/data/uploads/thumbs/model-1.png",
    );

    expect(security.withRedisLock).toHaveBeenCalledWith(
      "pdf-write",
      expect.any(Function),
      expect.anything(),
    );
    expect(storage.removeQuietly).toHaveBeenCalledWith("/data/pdfs/RSP-2026-0002.pdf");
    expect(fs.writeFile).toHaveBeenCalledWith(
      "/data/pdfs/RSP-2026-0002.pdf",
      expect.any(Buffer),
      { flag: "wx", mode: 0o600 },
    );
    expect(db.update).toHaveBeenCalledWith({
      where: { id: "quote-id" },
      data: { pdfPath: "/data/pdfs/RSP-2026-0002.pdf" },
    });
  });

  it("rolls the file back when the pdfPath update fails", async () => {
    db.update.mockRejectedValue(new Error("db down"));

    const response = await POST(request(), ctx);

    expect(response.status).toBe(500);
    const writeOrder = fs.writeFile.mock.invocationCallOrder[0]!;
    const rollbackCall = storage.removeQuietly.mock.invocationCallOrder.at(-1)!;
    expect(rollbackCall).toBeGreaterThan(writeOrder);
    expect(storage.removeQuietly).toHaveBeenLastCalledWith("/data/pdfs/RSP-2026-0002.pdf");
  });

  it("returns 404 for an unknown quotation", async () => {
    db.findUnique.mockResolvedValue(null);

    const response = await POST(request(), ctx);

    expect(response.status).toBe(404);
    expect(renderQuotationPdf).not.toHaveBeenCalled();
  });

  it("short-circuits when the admin gate rejects", async () => {
    requireAdminApi.mockResolvedValue(
      Response.json({ error: { code: "UNAUTHORISED" } }, { status: 401 }),
    );

    const response = await POST(request(), ctx);

    expect(response.status).toBe(401);
    expect(db.findUnique).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests", async () => {
    security.assertSameOrigin.mockReturnValue(false);

    const response = await POST(request(), ctx);

    expect(response.status).toBe(403);
    expect(db.findUnique).not.toHaveBeenCalled();
  });

  it("returns 503 when the pdf write lock is busy", async () => {
    security.withRedisLock.mockResolvedValue(null);

    const response = await POST(request(), ctx);

    expect(response.status).toBe(503);
    expect(db.update).not.toHaveBeenCalled();
  });
});
