import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
const apiUtil = vi.hoisted(() => ({
  requireAdminApi: vi.fn(async (): Promise<Response | null> => null),
  jsonError: (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status }),
  readJsonBody: vi.fn(),
}));

vi.mock("@print/db", () => ({
  prisma: { appSetting: { findUnique: db.findUnique, upsert: db.upsert } },
  Prisma: {},
}));
vi.mock("@/lib/api-util", () => apiUtil);
vi.mock("@/lib/security", () => ({ assertSameOrigin: () => true }));

const { PUT } = await import("@/app/api/admin/catalog/route");

const fakeReq = () => ({}) as unknown as NextRequest;

beforeEach(() => {
  db.upsert.mockReset().mockResolvedValue({});
  apiUtil.requireAdminApi.mockReset().mockResolvedValue(null);
  apiUtil.readJsonBody.mockReset();
});

describe("PUT /api/admin/catalog", () => {
  it("rejects an unauthenticated caller", async () => {
    apiUtil.requireAdminApi.mockResolvedValueOnce(
      Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }),
    );
    const res = await PUT(fakeReq());
    expect(res.status).toBe(401);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("normalizes on save: disables a material, drops stray colours, persists", async () => {
    apiUtil.readJsonBody.mockResolvedValue({
      ok: true,
      value: {
        materials: { PLA: true, PETG: false },
        colours: { PLA: ["royal-blue", "not-a-real-colour"] },
      },
    });

    const res = await PUT(fakeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      materials: { id: string; enabled: boolean; colours: { id: string; enabled: boolean }[] }[];
    };

    const petg = body.materials.find((m) => m.id === "PETG")!;
    expect(petg.enabled).toBe(false);
    const pla = body.materials.find((m) => m.id === "PLA")!;
    expect(pla.colours.find((c) => c.id === "royal-blue")!.enabled).toBe(true);
    expect(pla.colours.some((c) => c.id === "not-a-real-colour")).toBe(false);

    // The stored blob is the cleaned availability (stray colour removed).
    expect(db.upsert).toHaveBeenCalledTimes(1);
    const arg = db.upsert.mock.calls[0]![0] as {
      create: { value: { colours: Record<string, string[]> } };
    };
    expect(arg.create.value.colours.PLA).toEqual(["royal-blue"]);
  });

  it("round-trips a premium tier the operator switches on", async () => {
    apiUtil.readJsonBody.mockResolvedValue({
      ok: true,
      value: {
        materials: { PLA: true, PLA_AESTHETIC: true, PLA_CF: false, PETG: true, PETG_PREMIUM: false },
        colours: { PLA_AESTHETIC: ["silk-copper", "dual-red-gold"] },
      },
    });

    const res = await PUT(fakeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      materials: { id: string; name: string; enabled: boolean; colours: { id: string; enabled: boolean }[] }[];
    };
    const aesthetic = body.materials.find((m) => m.id === "PLA_AESTHETIC")!;
    expect(aesthetic).toMatchObject({ name: "Aesthetic PLA", enabled: true });
    expect(aesthetic.colours.filter((c) => c.enabled).map((c) => c.id)).toEqual([
      "silk-copper",
      "dual-red-gold",
    ]);

    const arg = db.upsert.mock.calls[0]![0] as {
      create: { value: { materials: Record<string, boolean>; colours: Record<string, string[]> } };
    };
    expect(arg.create.value.materials.PLA_AESTHETIC).toBe(true);
    expect(arg.create.value.colours.PLA_AESTHETIC).toEqual(["silk-copper", "dual-red-gold"]);
  });

  it("keeps an everything-enabled save far below the 64 KiB body cap", async () => {
    const { MATERIAL_COLOURS, MATERIAL_IDS } = await import("@print/shared");
    const all = {
      materials: Object.fromEntries(MATERIAL_IDS.map((m) => [m, true])),
      colours: Object.fromEntries(MATERIAL_IDS.map((m) => [m, [...MATERIAL_COLOURS[m]]])),
    };
    expect(JSON.stringify(all).length).toBeLessThan(16 * 1024);
  });
});
