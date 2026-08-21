import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const recent = vi.hoisted(() => ({ getRecentPrints: vi.fn() }));
const storage = vi.hoisted(() => ({
  openPrivateFile: vi.fn(),
  showcasePath: vi.fn((id: string, ext: string) => `/data/uploads/showcase/${id}.${ext}`),
}));

vi.mock("@/lib/recent-prints", () => recent);
vi.mock("@/lib/storage", () => storage);

const { GET } = await import("@/app/api/showcase/[id]/photo/route");

const uuid = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => ({}) as unknown as NextRequest;

const published = [{ id: uuid, caption: "Clip", material: "PLA", photoExt: "jpg", createdAt: "" }];

beforeEach(() => {
  vi.clearAllMocks();
  recent.getRecentPrints.mockResolvedValue(published);
  storage.showcasePath.mockImplementation((id: string, ext: string) => `/data/uploads/showcase/${id}.${ext}`);
  storage.openPrivateFile.mockResolvedValue({
    size: 3,
    handle: { createReadStream: () => Readable.from([Buffer.from("abc")]) },
  });
});

describe("GET /api/showcase/[id]/photo", () => {
  it("serves a published photo as a cacheable image", async () => {
    const res = await GET(req(), ctx(uuid));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toContain("public");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("404s an id that is not in the published showcase", async () => {
    // Otherwise an arbitrary UUID could be used to probe what exists on disk.
    const res = await GET(req(), ctx(other));

    expect(res.status).toBe(404);
    expect(storage.openPrivateFile).not.toHaveBeenCalled();
  });

  it("404s a non-UUID id without touching storage", async () => {
    const res = await GET(req(), ctx("../../etc/passwd"));

    expect(res.status).toBe(404);
    expect(storage.showcasePath).not.toHaveBeenCalled();
    expect(storage.openPrivateFile).not.toHaveBeenCalled();
  });

  it("404s when the row exists but the file has gone", async () => {
    storage.openPrivateFile.mockRejectedValue(new Error("ENOENT"));

    const res = await GET(req(), ctx(uuid));

    expect(res.status).toBe(404);
  });
});
