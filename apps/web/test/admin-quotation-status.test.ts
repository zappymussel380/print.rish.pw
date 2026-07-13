import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
  transaction: vi.fn(),
  updateMany: vi.fn(),
  createHistory: vi.fn(),
}));

vi.mock("@print/db", () => ({
  prisma: {
    quotation: { findUnique: db.findUnique },
    $transaction: db.transaction,
  },
}));

vi.mock("@/lib/api-util", () => ({
  requireAdminApi: vi.fn(async () => null),
  readJsonBody: vi.fn(async (request: Request) => ({ ok: true, value: await request.json() })),
  jsonError: (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status }),
}));

vi.mock("@/lib/security", () => ({ assertSameOrigin: vi.fn(() => true) }));
vi.mock("@/lib/storage", () => ({
  modelPath: vi.fn(),
  pdfPath: vi.fn(),
  removeQuietly: vi.fn(),
  thumbPath: vi.fn(),
}));

const { PATCH } = await import("@/app/api/admin/quotations/[id]/route");

const tx = {
  quotation: { updateMany: db.updateMany },
  statusHistory: { create: db.createHistory },
};

function request(status: string, note = ""): NextRequest {
  return new Request("https://print.rish.pw/api/admin/quotations/quote-id", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, note }),
  }) as NextRequest;
}

describe("admin quotation status transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.findUnique.mockResolvedValue({ status: "PRINTING" });
    db.updateMany.mockResolvedValue({ count: 1 });
    db.createHistory.mockResolvedValue({ id: "history-id" });
    db.transaction.mockImplementation(async (action: (client: typeof tx) => Promise<unknown>) =>
      action(tx),
    );
  });

  it("claims the observed status and records history in one transaction", async () => {
    const response = await PATCH(request("COMPLETED", "Print finished"), {
      params: Promise.resolve({ id: "quote-id" }),
    });

    expect(response.status).toBe(200);
    expect(db.updateMany).toHaveBeenCalledWith({
      where: { id: "quote-id", status: "PRINTING" },
      data: { status: "COMPLETED" },
    });
    expect(db.createHistory).toHaveBeenCalledWith({
      data: {
        quotationId: "quote-id",
        fromStatus: "PRINTING",
        toStatus: "COMPLETED",
        note: "Print finished",
      },
    });
  });

  it("rejects a stale concurrent transition without writing history", async () => {
    db.updateMany.mockResolvedValue({ count: 0 });

    const response = await PATCH(request("APPROVED"), {
      params: Promise.resolve({ id: "quote-id" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "STATUS_CONFLICT",
        message: "Quotation status changed concurrently. Refresh and try again",
      },
    });
    expect(db.createHistory).not.toHaveBeenCalled();
  });
});
