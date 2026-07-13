import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Vitest preserves the app's JSX while Next injects this runtime during builds.
vi.stubGlobal("React", React);

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getQuotationAccessCookie: vi.fn(),
  isAdmin: vi.fn(),
  openPrivateFile: vi.fn(),
  rateLimit: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@print/db", () => ({
  prisma: {
    quotation: {
      findUnique: mocks.findUnique,
      findUniqueOrThrow: vi.fn(),
    },
  },
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  useRouter: vi.fn(),
}));

vi.mock("@/lib/api-util", () => ({
  jsonError: (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status }),
}));

vi.mock("@/lib/quotation-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/quotation-access")>()),
  getQuotationAccessCookie: mocks.getQuotationAccessCookie,
}));

vi.mock("@/lib/security", () => ({
  RATE_LIMITS: { pdf: { max: 30, windowSeconds: 600 } },
  clientIp: vi.fn(() => "127.0.0.1"),
  rateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/session", () => ({ isAdmin: mocks.isAdmin }));

vi.mock("@/lib/storage", () => ({
  openPrivateFile: mocks.openPrivateFile,
  pdfPath: vi.fn((number: string) => `/private/${number}.pdf`),
}));

const { GET } = await import("@/app/api/quotations/[number]/pdf/route");
const { default: ConfirmationPage } = await import("@/app/quotation/[number]/page");

const number = "RSP-2026-0001";
const token = "a".repeat(64);
const quotation = {
  number,
  accessToken: `sha256:${createHash("sha256").update(token).digest("hex")}`,
  accessTokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
  pdfPath: `/private/${number}.pdf`,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(quotation);
  mocks.getQuotationAccessCookie.mockResolvedValue("");
  mocks.isAdmin.mockResolvedValue(false);
  mocks.rateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.openPrivateFile.mockResolvedValue({
    handle: { createReadStream: () => Readable.from([Buffer.from("%PDF")]) },
    size: 4,
  });
});

describe("quotation query-token removal", () => {
  it("does not authorize the PDF endpoint with a query token", async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/quotations/${number}/pdf?token=${token}`),
      { params: Promise.resolve({ number }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.openPrivateFile).not.toHaveBeenCalled();
  });

  it("continues to authorize the PDF endpoint with the access cookie", async () => {
    mocks.getQuotationAccessCookie.mockResolvedValue(token);

    const response = await GET(
      new NextRequest(`http://localhost/api/quotations/${number}/pdf`),
      { params: Promise.resolve({ number }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(await response.text()).toBe("%PDF");
    expect(mocks.openPrivateFile).toHaveBeenCalledWith(`/private/${number}.pdf`, 20 * 1024 * 1024);
  });

  it("ignores a query token on the confirmation page", async () => {
    const result = await ConfirmationPage({
      params: Promise.resolve({ number }),
      searchParams: Promise.resolve({ token }),
    } as never);

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(result.props.number).toBe(number);
  });
});
