import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ rows: new Map<string, unknown>(), upsert: vi.fn(), count: vi.fn() }));
const apiUtil = vi.hoisted(() => ({
  requireAdminApi: vi.fn(async (): Promise<Response | null> => null),
  jsonError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
  readJsonBody: vi.fn(),
}));
const queue = vi.hoisted(() => ({ add: vi.fn(), getJob: vi.fn() }));
const origin = vi.hoisted(() => ({ ok: true }));

vi.mock("@print/db", () => ({
  prisma: {
    appSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (db.rows.has(where.key) ? { value: db.rows.get(where.key) } : null)),
      upsert: db.upsert.mockImplementation(async ({ where, update }: { where: { key: string }; update: { value: unknown } }) => {
        db.rows.set(where.key, update.value);
        return {};
      }),
    },
    uploadedModel: { count: db.count },
  },
  Prisma: {},
}));
vi.mock("@/lib/api-util", () => apiUtil);
vi.mock("@/lib/security", () => ({ assertSameOrigin: () => origin.ok }));
vi.mock("@/lib/queue", () => ({ getMaintenanceQueue: () => queue }));

const route = await import("@/app/api/admin/retention/route");
const purge = await import("@/app/api/admin/retention/purge/route");

const req = (query = "") => ({ nextUrl: new URL(`https://shop.test/api/admin/retention/purge${query}`) }) as unknown as NextRequest;
const body = (value: unknown) => apiUtil.readJsonBody.mockResolvedValueOnce({ ok: true, value });

beforeEach(() => {
  db.rows.clear();
  db.upsert.mockClear();
  db.count.mockReset();
  queue.add.mockReset().mockResolvedValue({});
  queue.getJob.mockReset().mockResolvedValue(undefined);
  apiUtil.requireAdminApi.mockResolvedValue(null);
  origin.ok = true;
  vi.stubEnv("UPLOAD_RETENTION_HOURS", "48");
  vi.stubEnv("FILE_RETENTION_DAYS", "30");
  vi.stubEnv("QUOTATION_RETENTION_DAYS", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/admin/retention", () => {
  it("shows the server's defaults until saved", async () => {
    expect(await (await route.GET()).json()).toMatchObject({
      saved: false,
      settings: { uploadRetentionDays: 2, fileRetentionDays: 30, quotationRetentionDays: 90 },
      policy: { uploadRetentionHours: 48 },
    });
  });

  it("saves the owner's policy, keeping finished quotations for good if asked", async () => {
    body({ uploadRetentionDays: 3, fileRetentionDays: 60, quotationRetentionDays: null });
    const res = await route.PUT(req());
    expect(res.status).toBe(200);
    expect(db.rows.get("retention")).toEqual({ uploadRetentionDays: 3, fileRetentionDays: 60, quotationRetentionDays: null });
    expect(await (await route.GET()).json()).toMatchObject({ saved: true, policy: { uploadRetentionHours: 72, quotationRetentionDays: null } });
  });

  it("refuses days out of range, and anyone but the admin", async () => {
    body({ uploadRetentionDays: 0, fileRetentionDays: 30, quotationRetentionDays: 90 });
    expect((await route.PUT(req())).status).toBe(422);
    body({ uploadRetentionDays: 2, fileRetentionDays: 30, quotationRetentionDays: 3 });
    expect((await route.PUT(req())).status).toBe(422);
    origin.ok = false;
    expect((await route.PUT(req())).status).toBe(403);
    apiUtil.requireAdminApi.mockResolvedValue(Response.json({}, { status: 401 }));
    expect((await route.GET()).status).toBe(401);
    expect(db.upsert).not.toHaveBeenCalled();
  });
});

describe("/api/admin/retention/purge", () => {
  it("previews what a purge would delete: uploads never quoted, finished quotations' files", async () => {
    db.count.mockResolvedValueOnce(41).mockResolvedValueOnce(12);
    const res = await purge.GET(req("?olderThanDays=30"));
    expect(await res.json()).toEqual({ uploads: 41, finishedFiles: 12 });
    const [uploads, finished] = db.count.mock.calls.map((c) => c[0].where);
    expect(uploads).toMatchObject({ items: { none: {} } });
    // Only models whose every quotation finished before the cutoff.
    expect(finished.items.every.quotation.status.in).toEqual(["COMPLETED", "DELIVERED", "CANCELLED"]);
    expect((await purge.GET(req("?olderThanDays=0"))).status).toBe(422);
  });

  it("queues one purge job that never deletes quotations", async () => {
    body({ olderThanDays: 30 });
    const res = await purge.POST(req());
    expect(res.status).toBe(202);
    expect(queue.add).toHaveBeenCalledWith("purge", { kind: "purge", olderThanDays: 30 }, { jobId: "purge" });
    queue.add.mockRejectedValueOnce(new Error("redis down"));
    body({ olderThanDays: 30 });
    expect((await purge.POST(req())).status).toBe(503);
  });

  it("clears a failed purge first, since BullMQ ignores an add whose job id still exists", async () => {
    const failed = { getState: vi.fn(async () => "failed"), remove: vi.fn(async () => {}) };
    queue.getJob.mockResolvedValue(failed);
    body({ olderThanDays: 7 });
    expect((await purge.POST(req())).status).toBe(202);
    expect(queue.getJob).toHaveBeenCalledWith("purge");
    expect(failed.remove).toHaveBeenCalled();
    expect(failed.remove.mock.invocationCallOrder[0]!).toBeLessThan(queue.add.mock.invocationCallOrder[0]!);
    expect(queue.add).toHaveBeenCalledWith("purge", { kind: "purge", olderThanDays: 7 }, { jobId: "purge" });
  });

  it("says so, rather than claiming to queue, while a purge is still running", async () => {
    const running = { getState: vi.fn(async () => "active"), remove: vi.fn() };
    queue.getJob.mockResolvedValue(running);
    body({ olderThanDays: 7 });
    const res = await purge.POST(req());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "PURGE_RUNNING" } });
    expect(running.remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
