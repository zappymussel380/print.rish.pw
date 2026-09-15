import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { defaultAvailability, defaultMaterialHelper } from "@print/shared";

const db = vi.hoisted(() => ({ rows: new Map<string, unknown>(), upsert: vi.fn() }));
const apiUtil = vi.hoisted(() => ({
  requireAdminApi: vi.fn(async (): Promise<Response | null> => null),
  jsonError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
  readJsonBody: vi.fn(),
}));
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
  },
  Prisma: {},
}));
vi.mock("@/lib/api-util", () => apiUtil);
vi.mock("@/lib/security", () => ({ assertSameOrigin: () => origin.ok }));
// react's cache() memoises per request on the server; in a test it would pin
// the first read, so pass the function straight through.
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), cache: <T,>(fn: T) => fn }));

const route = await import("@/app/api/admin/material-helper/route");
const { toPublicHelper } = await import("@/lib/material-helper");

const req = {} as NextRequest;
const body = (value: unknown) => apiUtil.readJsonBody.mockResolvedValueOnce({ ok: true, value });

beforeEach(() => {
  db.rows.clear();
  db.upsert.mockClear();
  apiUtil.requireAdminApi.mockResolvedValue(null);
  origin.ok = true;
});

describe("/api/admin/material-helper", () => {
  it("serves the defaults until saved, then what was saved", async () => {
    expect(await (await route.GET()).json()).toEqual(defaultMaterialHelper());

    const next = {
      ...defaultMaterialHelper(),
      builtIn: { looks: true, strength: true, heat: false, outdoor: true },
      own: { own1: { label: "  Flexible ", description: "Bends without snapping", enabled: true } },
      scores: { PETG: { own1: 3 } },
    };
    body(next);
    const res = await route.PUT(req);
    expect(res.status).toBe(200);
    const saved = await res.json();
    // Normalized: trimmed, and a stock tier keeps the ratings it wasn't sent.
    expect(saved.own.own1.label).toBe("Flexible");
    expect(saved.scores.PETG).toMatchObject({ looks: 2, own1: 3 });
    expect(saved.builtIn.heat).toBe(false);
    expect(await (await route.GET()).json()).toEqual(saved);
  });

  it("refuses bad input, other origins and anyone but the admin", async () => {
    body({ ...defaultMaterialHelper(), scores: { PLA: { looks: 9 } } });
    expect((await route.PUT(req)).status).toBe(422);
    body({ ...defaultMaterialHelper(), own: { own1: { label: "", description: "", enabled: true } } });
    expect((await route.PUT(req)).status).toBe(422);
    origin.ok = false;
    expect((await route.PUT(req)).status).toBe(403);
    apiUtil.requireAdminApi.mockResolvedValue(Response.json({}, { status: 401 }));
    expect((await route.GET()).status).toBe(401);
    expect(db.upsert).not.toHaveBeenCalled();
  });
});

describe("the public catalog's helper", () => {
  it("rates only the materials customers can pick now", () => {
    const availability = defaultAvailability();
    const offered = Object.entries(availability.materials).filter(([, on]) => on).map(([id]) => id);
    const helper = toPublicHelper(defaultMaterialHelper(), availability)!;
    expect(Object.keys(helper.scores).sort()).toEqual(offered.sort());
    expect(helper.needs.map((n) => n.id)).toEqual(["looks", "strength", "heat", "outdoor"]);
    expect(toPublicHelper({ ...defaultMaterialHelper(), enabled: false }, availability)).toBeNull();
  });
});
