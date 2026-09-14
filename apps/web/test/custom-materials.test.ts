import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// One stored availability blob and the live-profile rows, as the database has them.
const db = vi.hoisted(() => ({
  stored: null as unknown,
  live: [] as { slot: string }[],
  upsert: vi.fn(),
}));
const apiUtil = vi.hoisted(() => ({
  requireAdminApi: vi.fn(async (): Promise<Response | null> => null),
  jsonError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
  readJsonBody: vi.fn(),
}));

vi.mock("@print/db", () => ({
  prisma: {
    appSetting: {
      findUnique: vi.fn(async () => (db.stored ? { value: db.stored } : null)),
      upsert: db.upsert.mockImplementation(async ({ update }: { update: { value: unknown } }) => {
        db.stored = update.value;
        return {};
      }),
    },
    slicerProfileUpload: {
      findMany: vi.fn(async ({ where }: { where: { slot: { in: string[] } } }) => db.live.filter((r) => where.slot.in.includes(r.slot))),
    },
  },
  Prisma: {},
}));
vi.mock("@/lib/api-util", () => apiUtil);
vi.mock("@/lib/security", () => ({ assertSameOrigin: () => true }));

const catalogRoute = await import("@/app/api/admin/catalog/route");
const namesRoute = await import("@/app/api/admin/custom-materials/route");
const siteRoute = await import("@/app/api/admin/site/route");
const { getCatalogAvailability } = await import("@/lib/catalog-availability");

const req = () => ({}) as unknown as NextRequest;
const body = (value: unknown) => apiUtil.readJsonBody.mockResolvedValueOnce({ ok: true, value });
const error = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

beforeEach(() => {
  db.stored = { materials: { PLA: true, PETG: true } };
  db.live = [];
  db.upsert.mockClear();
});

describe("naming the shop's own materials", () => {
  it("saves a tidied name without touching availability or colours", async () => {
    body({ names: { OTHER_1: "  ABS   CF " } });
    const res = await namesRoute.PUT(req());
    expect(res.status).toBe(200);
    expect(db.stored).toMatchObject({ customMaterials: { OTHER_1: { name: "ABS CF" } }, materials: { PLA: true, PETG: true } });
    const pub = (await res.json()) as { materials: { id: string; name: string; setup?: object }[] };
    expect(pub.materials.find((m) => m.id === "OTHER_1")).toMatchObject({ name: "ABS CF", setup: { named: true, ready: false } });
  });

  it("refuses a name it can't use, and saves nothing", async () => {
    body({ names: { OTHER_1: "ABS-CF", OTHER_2: "<script>" } });
    const res = await namesRoute.PUT(req());
    expect(res.status).toBe(422);
    expect((await error(res)).message).toMatch(/^Other material 2: use 1–40 letters/);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("clearing a name takes the material off sale", async () => {
    db.stored = { materials: { PLA: true, OTHER_1: true }, customMaterials: { OTHER_1: { name: "PC" } } };
    body({ names: { OTHER_1: "" } });
    expect((await namesRoute.PUT(req())).status).toBe(200);
    expect(db.stored).toMatchObject({ customMaterials: {}, materials: { OTHER_1: false } });
  });
});

describe("switching one of them on (Catalog)", () => {
  it("needs a name first", async () => {
    body({ materials: { PLA: true, OTHER_1: true } });
    const res = await catalogRoute.PUT(req());
    expect(res.status).toBe(422);
    expect(await error(res)).toEqual({ code: "MATERIAL_NOT_READY", message: "Other material 1 needs a name first." });
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("then a live OrcaSlicer profile", async () => {
    db.stored = { materials: { PLA: true }, customMaterials: { OTHER_1: { name: "PC" } } };
    body({ materials: { PLA: true, OTHER_1: true } });
    const res = await catalogRoute.PUT(req());
    expect(res.status).toBe(422);
    expect((await error(res)).message).toMatch(/^PC needs an OrcaSlicer profile first/);
  });

  it("goes on sale once both are there, and a Catalog save never undoes a rename", async () => {
    db.stored = { materials: { PLA: true }, customMaterials: { OTHER_1: { name: "PC" } } };
    db.live = [{ slot: "filament:OTHER_1" }];
    // The Catalog editor's copy of the names may be stale; they're not its to set.
    body({ materials: { PLA: true, OTHER_1: true }, customMaterials: { OTHER_1: { name: "Stale" } } });
    const res = await catalogRoute.PUT(req());
    expect(res.status).toBe(200);
    expect(db.stored).toMatchObject({ materials: { OTHER_1: true }, customMaterials: { OTHER_1: { name: "PC" } } });

    const offered = await getCatalogAvailability();
    expect(offered.materials.OTHER_1).toBe(true);
  });
});

describe("what customers get", () => {
  it("never offers one of the shop's own materials without a live profile, whatever is stored", async () => {
    db.stored = { materials: { PLA: true, OTHER_1: true, OTHER_2: true }, customMaterials: { OTHER_1: { name: "PC" }, OTHER_2: { name: "PA-CF" } } };
    db.live = [{ slot: "filament:OTHER_2" }];
    const offered = await getCatalogAvailability();
    expect(offered.materials).toMatchObject({ PLA: true, OTHER_1: false, OTHER_2: true });
  });
});

describe("their copy for /materials", () => {
  const named = () => ({ materials: { PLA: true }, customMaterials: { OTHER_1: { name: "PA-CF" } } });
  const stored = () => (db.stored as { customMaterials: Record<string, { name: string; guide?: object }> }).customMaterials;

  it("saves tidied copy for a named material, and a rename keeps it", async () => {
    db.stored = named();
    body({ guides: { OTHER_1: { subtitle: "  Carbon-fibre   nylon ", strength: "Very stiff.", uv: "   " } } });
    expect((await namesRoute.PUT(req())).status).toBe(200);
    expect(stored().OTHER_1).toEqual({ name: "PA-CF", guide: { subtitle: "Carbon-fibre nylon", strength: "Very stiff." } });

    body({ names: { OTHER_1: "PA12-CF" } });
    expect((await namesRoute.PUT(req())).status).toBe(200);
    expect(stored().OTHER_1).toEqual({ name: "PA12-CF", guide: { subtitle: "Carbon-fibre nylon", strength: "Very stiff." } });
  });

  it("blank copy clears it; clearing the name drops it too", async () => {
    db.stored = { ...named(), customMaterials: { OTHER_1: { name: "PA-CF", guide: { strength: "Stiff." } } } };
    body({ guides: { OTHER_1: { strength: " " } } });
    expect((await namesRoute.PUT(req())).status).toBe(200);
    expect(stored().OTHER_1).toEqual({ name: "PA-CF" });

    db.stored = { ...named(), customMaterials: { OTHER_1: { name: "PA-CF", guide: { strength: "Stiff." } } } };
    body({ names: { OTHER_1: "" } });
    expect((await namesRoute.PUT(req())).status).toBe(200);
    expect(stored()).toEqual({});
  });

  it("needs the material named first, and bounded rows", async () => {
    db.stored = named();
    body({ guides: { OTHER_2: { strength: "Stiff." } } });
    let res = await namesRoute.PUT(req());
    expect(res.status).toBe(422);
    expect((await error(res)).message).toMatch(/^Other material 2: name it first/);

    body({ guides: { OTHER_1: { strength: "x".repeat(301) } } });
    res = await namesRoute.PUT(req());
    expect(res.status).toBe(422);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("Site can put one on /materials only once it has copy", async () => {
    const profile = { brandName: "Acme", materialsPage: ["PLA", "OTHER_1"] };
    db.stored = named();
    body(profile);
    let res = await siteRoute.PUT(req());
    expect(res.status).toBe(422);
    expect(await error(res)).toMatchObject({ code: "NO_MATERIAL_COPY", message: expect.stringMatching(/^PA-CF: write its materials page text/) });
    expect(db.upsert).not.toHaveBeenCalled();

    db.stored = { ...named(), customMaterials: { OTHER_1: { name: "PA-CF", guide: { strength: "Stiff." } } } };
    body(profile);
    res = await siteRoute.PUT(req());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { materialsPage: string[] }).materialsPage).toEqual(["PLA", "OTHER_1"]);
  });
});
