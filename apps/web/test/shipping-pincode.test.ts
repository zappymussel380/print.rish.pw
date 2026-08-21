import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getQuoteSessionId: vi.fn(),
  rateLimit: vi.fn(),
  readJsonBody: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@print/db", () => ({
  prisma: { uploadedModel: { findMany: mocks.findMany } },
}));
vi.mock("@/lib/api-util", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-util")>("@/lib/api-util");
  return { ...actual, readJsonBody: mocks.readJsonBody };
});
vi.mock("@/lib/security", async () => {
  const actual = await vi.importActual<typeof import("@/lib/security")>("@/lib/security");
  return { ...actual, assertSameOrigin: () => true, clientIp: () => "127.0.0.1", rateLimit: mocks.rateLimit };
});
vi.mock("@/lib/session", () => ({ getQuoteSessionId: mocks.getQuoteSessionId }));

const { POST } = await import("@/app/api/shipping/route");

const fakeReq = () => ({ headers: new Headers() }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getQuoteSessionId.mockResolvedValue("11111111-1111-4111-8111-111111111111");
  mocks.rateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.findMany.mockResolvedValue([]);
});

describe("POST /api/shipping pincode validation", () => {
  it("rejects a malformed pincode before touching the database", async () => {
    mocks.readJsonBody.mockResolvedValue({ ok: true, value: { deliveryPincode: "78100", items: [] } });

    const res = await POST(fakeReq());

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "BAD_PINCODE" } });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("rejects a missing pincode the same way", async () => {
    mocks.readJsonBody.mockResolvedValue({ ok: true, value: { items: [] } });

    const res = await POST(fakeReq());

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "BAD_PINCODE" } });
  });

  it("rejects non-digits rather than passing them upstream", async () => {
    mocks.readJsonBody.mockResolvedValue({ ok: true, value: { deliveryPincode: "78a001", items: [] } });

    const res = await POST(fakeReq());

    expect(res.status).toBe(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("gets past the pincode gate on a well-formed one", async () => {
    mocks.readJsonBody.mockResolvedValue({ ok: true, value: { deliveryPincode: "781001", items: [] } });

    const res = await POST(fakeReq());

    // No priced models in this session, so the next gate answers — which is
    // exactly what proves the pincode itself was accepted.
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "NO_SLICE" } });
  });
});
