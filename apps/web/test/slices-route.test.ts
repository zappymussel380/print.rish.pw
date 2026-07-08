import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock("@print/db", () => ({
  prisma: {
    sliceResult: {
      findUnique: mocks.findUnique,
    },
  },
}));

const { GET } = await import("@/app/api/slices/[id]/route");

describe("GET /api/slices/:id", () => {
  it("rejects malformed ids before Prisma sees them", async () => {
    const res = await GET({} as never, { params: Promise.resolve({ id: "not-a-uuid" }) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Unknown slice" },
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns a clean 404 for unknown UUIDs", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);

    const res = await GET({} as never, {
      params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Unknown slice" },
    });
  });
});
