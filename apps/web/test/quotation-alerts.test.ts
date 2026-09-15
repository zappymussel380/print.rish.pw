import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guardMutation: vi.fn(),
  readJsonBody: vi.fn(),
  findModel: vi.fn(),
  findSlice: vi.fn(),
  transaction: vi.fn(),
  updateQuotation: vi.fn(),
  reserveRateLimit: vi.fn(),
  releaseRateLimitReservation: vi.fn(),
  withRedisLock: vi.fn(),
  renderQuotationPdf: vi.fn(),
  notifyNewQuotation: vi.fn(),
  sendOperatorAlert: vi.fn(),
  createQuotation: vi.fn(),
  tax: { enabled: false, rateBp: 1800, hsn: "", gstin: "" },
}));

vi.mock("@print/db", () => ({
  Prisma: {},
  prisma: {
    uploadedModel: { findFirst: mocks.findModel, findMany: vi.fn(async () => []) },
    sliceResult: { findUnique: mocks.findSlice, findMany: vi.fn(async () => []) },
    quotation: { update: mocks.updateQuotation },
    // No live presets for the shop's own materials: the printer as installed.
    slicerProfileUpload: { findMany: vi.fn(async () => []) },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/api-util", () => ({
  guardMutation: mocks.guardMutation,
  jsonError: (status: number, code: string, message: string, extra?: object) =>
    Response.json({ error: { code, message, ...extra } }, { status }),
  readJsonBody: mocks.readJsonBody,
}));

vi.mock("@/lib/env", () => ({
  env: {
    maxModelsPerSession: 20,
    storageReserveBytes: 2 * 1024 * 1024 * 1024,
  },
}));

vi.mock("@/lib/security", () => ({
  RATE_LIMITS: {
    checkout: { max: 5, windowSeconds: 600 },
    checkoutGlobal: { max: 200, windowSeconds: 86_400 },
  },
  releaseRateLimitReservation: mocks.releaseRateLimitReservation,
  reserveRateLimit: mocks.reserveRateLimit,
  withRedisLock: mocks.withRedisLock,
}));

vi.mock("@/lib/shipping", () => ({
  verifyEstimateToken: vi.fn(),
}));

vi.mock("@/lib/pdf/quotation-pdf", () => ({
  renderQuotationPdf: mocks.renderQuotationPdf,
}));

vi.mock("@/lib/telegram", () => ({
  notifyNewQuotation: mocks.notifyNewQuotation,
  sendOperatorAlert: mocks.sendOperatorAlert,
}));

vi.mock("@/lib/session", () => ({
  getQuoteSessionId: vi.fn(async () => "session-1"),
}));

vi.mock("@/lib/quotation-number", () => ({
  nextQuotationNumber: vi.fn(async () => "RSP-2026-0001"),
}));

vi.mock("@/lib/quotation-access", () => ({
  issueQuotationAccess: vi.fn(() => ({
    token: "a".repeat(64),
    verifier: `sha256:${"b".repeat(64)}`,
    expiresAt: new Date("2026-08-01T00:00:00.000Z"),
  })),
  setQuotationAccessCookie: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  ensureStorageDirs: vi.fn(async () => {}),
  hasPdfStorageHeadroom: vi.fn(async () => true),
  pdfPath: vi.fn(() => "/tmp/RSP-2026-0001.pdf"),
  removeQuietly: vi.fn(async () => {}),
}));

vi.mock("@/lib/tax-settings", () => ({ getTax: vi.fn(async () => mocks.tax) }));

vi.mock("@/lib/site-config", () => ({
  siteConfig: { whatsappNumber: "" },
  whatsappChatUrl: vi.fn(() => null),
}));

const { POST } = await import("@/app/api/quotations/route");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guardMutation.mockResolvedValue(null);
  mocks.readJsonBody.mockResolvedValue({
    ok: true,
    value: {
      customer: {
        name: "Alert Test",
        email: "customer@example.com",
        phone: "+919876543210",
        city: "Guwahati",
        notes: "",
      },
      items: [
        {
          modelId: "11111111-1111-4111-8111-111111111111",
          config: {
            material: "PLA",
            colour: "black",
            layerHeightUm: 200,
            infillPct: 15,
            supports: "auto",
            quantity: 1,
          },
        },
      ],
    },
  });
  mocks.findModel.mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    sessionId: "session-1",
    originalName: "alert-test.stl",
    fileHash: "a".repeat(64),
    format: "stl",
    submittedAt: null,
    defaultConfig: null,
    lockedConfig: null,
  });
  mocks.findSlice.mockResolvedValue({
    id: "22222222-2222-4222-8222-222222222222",
    status: "DONE",
    filamentGrams: 12.5,
    filamentMm: 4200,
    printSeconds: 3600,
    supportGrams: 0,
  });
  mocks.transaction.mockImplementation(
    async (action: (tx: unknown) => Promise<unknown>) =>
      action({
        uploadedModel: { updateMany: vi.fn(async () => ({ count: 1 })) },
        quotation: { create: mocks.createQuotation },
      }),
  );
  mocks.createQuotation.mockResolvedValue({
    id: "33333333-3333-4333-8333-333333333333",
    number: "RSP-2026-0001",
    createdAt: new Date("2026-07-13T00:00:00.000Z"),
  });
  Object.assign(mocks.tax, { enabled: false, rateBp: 1800, hsn: "", gstin: "" });
  mocks.reserveRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.releaseRateLimitReservation.mockResolvedValue(undefined);
  mocks.withRedisLock.mockImplementation(
    async (_name: string, action: () => Promise<unknown>) => action(),
  );
  mocks.renderQuotationPdf.mockResolvedValue(Buffer.from("%PDF-1.4\n%%EOF\n"));
  mocks.updateQuotation.mockResolvedValue(undefined);
  mocks.notifyNewQuotation.mockResolvedValue(undefined);
  mocks.sendOperatorAlert.mockResolvedValue(undefined);
});

describe("checkout validation contract", () => {
  it("keeps field errors under error.issues", async () => {
    mocks.readJsonBody.mockResolvedValue({
      ok: true,
      value: {
        customer: { name: "", email: "bad", phone: "x", city: "", notes: "" },
      },
    });

    const response = await POST(
      new Request("http://localhost/api/quotations", { method: "POST" }) as never,
    );

    expect(response.status).toBe(422);
    const payload = await response.json();
    expect(payload).toEqual({
      error: {
        code: "INVALID_CUSTOMER",
        message: "Please check your contact details",
        issues: {
          name: [expect.any(String)],
          email: [expect.any(String)],
          phone: ["Enter a valid phone number"],
          city: [expect.any(String)],
        },
      },
    });
  });
});

describe("checkout operational alerts", () => {
  it("alerts once without waiting or changing an unexpected failure", async () => {
    const failure = new Error("forced checkout failure");
    mocks.guardMutation.mockRejectedValue(failure);
    let finishAlert: (() => void) | undefined;
    mocks.sendOperatorAlert.mockReturnValue(
      new Promise<void>((resolve) => {
        finishAlert = resolve;
      }),
    );

    const request = new Request("http://localhost/api/quotations", {
      method: "POST",
      body: JSON.stringify({ customer: { email: "customer@example.com" } }),
    });

    await expect(POST(request as never)).rejects.toBe(failure);
    expect(mocks.sendOperatorAlert).toHaveBeenCalledOnce();
    expect(mocks.sendOperatorAlert).toHaveBeenCalledWith(
      "checkout_5xx",
      "Checkout failed before a response could be completed.",
    );
    finishAlert?.();
  });

  it("alerts when the checkout capacity circuit breaker returns 503", async () => {
    mocks.reserveRateLimit.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 300,
    });
    let finishAlert: (() => void) | undefined;
    mocks.sendOperatorAlert.mockReturnValue(
      new Promise<void>((resolve) => {
        finishAlert = resolve;
      }),
    );

    const response = await POST(
      new Request("http://localhost/api/quotations", { method: "POST" }) as never,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("300");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CHECKOUT_CAPACITY_REACHED" },
    });
    expect(mocks.sendOperatorAlert).toHaveBeenCalledOnce();
    expect(mocks.sendOperatorAlert).toHaveBeenCalledWith(
      "checkout_5xx",
      "Checkout daily capacity reached; new quotation requests are returning 503.",
    );
    finishAlert?.();
  });

  it("keeps checkout successful and sends a static alert when PDF rendering fails", async () => {
    mocks.renderQuotationPdf.mockRejectedValue(new Error("forced PDF failure"));
    let finishAlert: (() => void) | undefined;
    mocks.sendOperatorAlert.mockReturnValue(
      new Promise<void>((resolve) => {
        finishAlert = resolve;
      }),
    );

    const response = await POST(
      new Request("http://localhost/api/quotations", { method: "POST" }) as never,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ number: "RSP-2026-0001" });
    expect(mocks.sendOperatorAlert).toHaveBeenCalledOnce();
    expect(mocks.sendOperatorAlert).toHaveBeenCalledWith(
      "quotation_pdf_failure",
      "Quotation PDF generation failed; regeneration may be required.",
    );
    expect(mocks.notifyNewQuotation).toHaveBeenCalledOnce();
    finishAlert?.();
  });
});

describe("checkout with GST", () => {
  const submit = () => POST(new Request("http://localhost/api/quotations", { method: "POST" }) as never);

  it("adds GST on top, and freezes rate, HSN and GSTIN with the quotation", async () => {
    Object.assign(mocks.tax, { enabled: true, rateBp: 1800, hsn: "9988", gstin: "18AABCU9603R1ZM" });
    const response = await submit();
    expect(response.status).toBe(201);
    // 12.5 g × ₹2/g + ₹150 setup = ₹175.00; 18% GST = ₹31.50; ₹206.50 rounds to ₹207.
    const data = mocks.createQuotation.mock.calls[0]![0].data;
    expect(data).toMatchObject({ taxPaise: 3150, roundOffPaise: 50, totalPaise: 20700, taxRateBp: 1800, taxHsn: "9988", taxGstin: "18AABCU9603R1ZM" });
    expect(data.pricingSnapshot.roundOffPaise).toBe(50);
    expect(data.pricingSnapshot.tax).toEqual({ rateBp: 1800, hsn: "9988", gstin: "18AABCU9603R1ZM", amountPaise: 3150 });
    // The PDF and the Telegram notice are made after the response.
    await vi.waitFor(() => expect(mocks.notifyNewQuotation).toHaveBeenCalled());
    expect(mocks.renderQuotationPdf.mock.calls[0]![0]).toMatchObject({
      totalPaise: 20700,
      roundOffPaise: 50,
      tax: { paise: 3150, rateBp: 1800, hsn: "9988", gstin: "18AABCU9603R1ZM" },
    });
    expect(mocks.notifyNewQuotation.mock.calls[0]![0]).toMatchObject({ totalPaise: 20700, taxPaise: 3150, roundOffPaise: 50 });
  });

  it("adds nothing when GST is off: totals exactly as before", async () => {
    await submit();
    const data = mocks.createQuotation.mock.calls[0]![0].data;
    // ₹175.00 is already a whole rupee: nothing to round.
    expect(data).toMatchObject({ taxPaise: 0, roundOffPaise: 0, totalPaise: 17500 });
    expect(data).not.toHaveProperty("taxRateBp");
    expect(data.pricingSnapshot.tax).toBeNull();
    await vi.waitFor(() => expect(mocks.renderQuotationPdf).toHaveBeenCalled());
    expect(mocks.renderQuotationPdf.mock.calls[0]![0].tax).toBeNull();
  });
});
