import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ rows: new Map<string, unknown>(), upsert: vi.fn() }));
const apiUtil = vi.hoisted(() => ({
  requireAdminApi: vi.fn(async (): Promise<Response | null> => null),
  jsonError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
  readJsonBody: vi.fn(),
}));

vi.mock("@print/db", () => ({
  prisma: {
    appSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (db.rows.has(where.key) ? { value: db.rows.get(where.key) } : null)),
      upsert: db.upsert.mockImplementation(async ({ where, update }: { where: { key: string }; update: { value: unknown } }) => {
        db.rows.set(where.key, update.value);
        return {};
      }),
    },
  },
  Prisma: {},
}));
vi.mock("@/lib/api-util", () => apiUtil);
vi.mock("@/lib/security", () => ({ assertSameOrigin: () => true }));

const route = await import("@/app/api/admin/tax/route");
const req = () => ({}) as unknown as NextRequest;
const body = (value: unknown) => apiUtil.readJsonBody.mockResolvedValueOnce({ ok: true, value });

beforeEach(() => {
  db.rows.clear();
  db.upsert.mockClear();
});

describe("/api/admin/tax", () => {
  it("is off until the shop switches it on", async () => {
    expect(await (await route.GET()).json()).toEqual({ enabled: false, rateBp: 1800, hsn: "", gstin: "" });
  });

  it("saves GST with a rate, HSN and GSTIN (upper-cased)", async () => {
    body({ enabled: true, ratePct: 18, hsn: "9988", gstin: "18aabcu9603r1zm" });
    const res = await route.PUT(req());
    expect(res.status).toBe(200);
    expect(db.rows.get("tax")).toEqual({ enabled: true, rateBp: 1800, hsn: "9988", gstin: "18AABCU9603R1ZM" });
    expect(await (await route.GET()).json()).toMatchObject({ enabled: true, rateBp: 1800 });
  });

  it("refuses to switch on without everything a quotation must show", async () => {
    body({ enabled: true, ratePct: 18, hsn: "", gstin: "" });
    let res = await route.PUT(req());
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe("To add GST, check an HSN/SAC code, your GSTIN.");
    body({ enabled: true, ratePct: 18, hsn: "9988", gstin: "NOTAGSTIN" });
    res = await route.PUT(req());
    expect((await res.json()).error.message).toMatch(/GSTIN \(15 characters/);
    body({ enabled: true, ratePct: 40, hsn: "9988", gstin: "18AABCU9603R1ZM" });
    expect((await route.PUT(req())).status).toBe(422);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("can be switched off, keeping the details for later", async () => {
    body({ enabled: false, ratePct: 12.5, hsn: "3926", gstin: "18AABCU9603R1ZM" });
    expect((await route.PUT(req())).status).toBe(200);
    expect(db.rows.get("tax")).toEqual({ enabled: false, rateBp: 1250, hsn: "3926", gstin: "18AABCU9603R1ZM" });
  });
});
