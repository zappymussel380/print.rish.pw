import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
const apiUtil = vi.hoisted(() => ({
  requireAdminApi: vi.fn(async (): Promise<Response | null> => null),
  jsonError: (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status }),
  readJsonBody: vi.fn(),
  readBinaryBody: vi.fn(),
}));
const fsMock = vi.hoisted(() => ({ writeFile: vi.fn() }));
const storage = vi.hoisted(() => ({
  ensureStorageDirs: vi.fn(async () => {}),
  showcasePath: vi.fn((id: string, ext: string) => `/data/uploads/showcase/${id}.${ext}`),
}));
const photos = vi.hoisted(() => ({ pruneUnreferencedShowcasePhotos: vi.fn(async () => 0) }));

vi.mock("@print/db", () => ({
  prisma: { appSetting: { findUnique: db.findUnique, upsert: db.upsert } },
  Prisma: {},
}));
vi.mock("node:fs/promises", () => ({ writeFile: fsMock.writeFile }));
vi.mock("@/lib/api-util", () => apiUtil);
vi.mock("@/lib/security", () => ({ assertSameOrigin: () => true }));
vi.mock("@/lib/storage", () => storage);
vi.mock("@/lib/showcase-photos", () => photos);

const { GET, POST, PUT } = await import("@/app/api/admin/showcase/route");

const fakeReq = () => ({}) as unknown as NextRequest;
const uuid = "11111111-1111-4111-8111-111111111111";

/** A 1x1 PNG — enough to be structurally real for the sanitiser. */
const realPng = () =>
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );

beforeEach(() => {
  vi.clearAllMocks();
  apiUtil.requireAdminApi.mockResolvedValue(null);
  db.findUnique.mockResolvedValue(null);
  db.upsert.mockResolvedValue({});
  storage.showcasePath.mockImplementation((id: string, ext: string) => `/data/uploads/showcase/${id}.${ext}`);
});

describe("/api/admin/showcase", () => {
  it("refuses an unauthenticated caller on every verb", async () => {
    apiUtil.requireAdminApi.mockResolvedValue(
      Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }),
    );

    expect((await GET()).status).toBe(401);
    expect((await POST(fakeReq())).status).toBe(401);
    expect((await PUT(fakeReq())).status).toBe(401);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("stores an uploaded photo under a server-chosen id", async () => {
    apiUtil.readBinaryBody.mockResolvedValue({ ok: true, value: realPng() });

    const res = await POST(fakeReq());
    const body = (await res.json()) as { id: string; photoExt: string };

    expect(res.status).toBe(201);
    expect(body.photoExt).toBe("png");
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    // Written exclusively (wx) so an id collision fails loudly rather than
    // overwriting an existing photo, and private on disk.
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      `/data/uploads/showcase/${body.id}.png`,
      expect.any(Buffer),
      { flag: "wx", mode: 0o600 },
    );
  });

  it("refuses a file that is not really an image", async () => {
    apiUtil.readBinaryBody.mockResolvedValue({
      ok: true,
      value: Buffer.from("<svg onload=alert(1)></svg>"),
    });

    const res = await POST(fakeReq());

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "BAD_IMAGE" } });
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("persists a normalized showcase and prunes photos it no longer references", async () => {
    apiUtil.readJsonBody.mockResolvedValue({
      ok: true,
      value: {
        prints: [
          { id: uuid, caption: "  Cable   clip ", material: "PLA", photoExt: "png" },
          { id: "not-a-uuid", caption: "Bogus", material: "PLA", photoExt: "png" },
        ],
      },
    });

    const res = await PUT(fakeReq());
    const body = (await res.json()) as { prints: { id: string; caption: string }[] };

    expect(res.status).toBe(200);
    expect(body.prints).toHaveLength(1);
    expect(body.prints[0]).toMatchObject({ id: uuid, caption: "Cable clip" });
    expect(db.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "recentPrints" } }),
    );
    expect(photos.pruneUnreferencedShowcasePhotos).toHaveBeenCalledOnce();
  });

  it("rejects a payload that is not a showcase at all", async () => {
    apiUtil.readJsonBody.mockResolvedValue({ ok: true, value: { prints: "nope" } });

    const res = await PUT(fakeReq());

    expect(res.status).toBe(422);
    expect(db.upsert).not.toHaveBeenCalled();
  });
});
