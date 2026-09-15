import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const SECRET = "test-secret-please-ignore-0123456789abcdef";
process.env.SESSION_SECRET = SECRET;

const db = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  upsert: vi.fn(),
  presets: [] as { slot: string | null; presetName: string; originalName: string; raw: unknown; status: string }[],
}));
const apiUtil = vi.hoisted(() => ({
  requireAdminApi: vi.fn(async (): Promise<Response | null> => null),
  jsonError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
  readJsonBody: vi.fn(),
}));
const profiles = vi.hoisted(() => ({ queueProfileUpload: vi.fn(), advanced: false }));

vi.mock("@print/db", () => ({
  prisma: {
    appSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (db.rows.has(where.key) ? { key: where.key, value: db.rows.get(where.key) } : null)),
      findMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) =>
        where.key.in.filter((k) => db.rows.has(k)).map((key) => ({ key, value: db.rows.get(key) })),
      ),
      upsert: db.upsert.mockImplementation(async ({ where, update }: { where: { key: string }; update: { value: unknown } }) => {
        db.rows.set(where.key, structuredClone(update.value));
        return {};
      }),
    },
    slicerProfileUpload: {
      findMany: vi.fn(async () => db.presets.filter((p) => p.status === "ACTIVE" && p.slot !== null)),
    },
  },
  Prisma: {},
}));
vi.mock("@/lib/api-util", () => apiUtil);
vi.mock("@/lib/security", () => ({ assertSameOrigin: () => true }));
vi.mock("@/lib/redis", () => ({ redis: { get: vi.fn(), set: vi.fn() } }));
vi.mock("@/lib/slicer-profiles", () => ({ queueProfileUpload: profiles.queueProfileUpload }));
vi.mock("@/lib/printer", () => ({ advancedProfilesEnabled: () => profiles.advanced }));

const route = await import("@/app/api/admin/backup/route");
const { sealSecret, openSecret } = await import("@/lib/secret-box");

const req = {} as NextRequest;
const body = (value: unknown) => apiUtil.readJsonBody.mockResolvedValueOnce({ ok: true, value });
const download = async () => {
  const res = await route.GET();
  expect(res.status).toBe(200);
  return (await res.json()) as { format: string; version: number; sections: Record<string, any>; presets: any[] };
};
const restore = async (value: unknown) => {
  body(value);
  const res = await route.PUT(req);
  return { status: res.status, json: (await res.json()) as any };
};

const PETG_PRESET = { type: "filament", name: "Shop PETG-HF", inherits: "Generic PETG @System", filament_density: ["1.27"] };

function seedShop() {
  db.rows.set("pricing", { setupFeePaise: 9900, materials: { PLA: { sellPerGramPaise: 180 } } });
  db.rows.set("catalogAvailability", {
    materials: { PLA: true, PETG: true, ABS: true, OTHER_1: true },
    colours: { PLA: ["pitch-black"] },
    customMaterials: { OTHER_1: { name: "PETG-HF" } },
  });
  db.rows.set("materialHelper", { enabled: true, own: { own1: { label: "Flexible", description: "", enabled: true } }, scores: { PETG: { own1: 2 } } });
  db.rows.set("faq", { custom: [{ id: "c1", q: "Do you ship?", a: "Yes, across India." }], hidden: [] });
  db.rows.set("shipping", { enabled: true, email: "api@shop.test", passwordSealed: sealSecret("s3cret", "shiprocket-password"), pickupPincode: "411001" });
  db.rows.set("mail", {
    enabled: true,
    provider: "resend",
    to: "owner@shop.test",
    from: "Shop <hello@shop.test>",
    resendKeySealed: sealSecret("re_key", "mail-resend-key"),
    smtp: { host: "", port: 587, secure: false, user: "", passSealed: "" },
  });
  db.presets = [
    { slot: "filament:OTHER_1", presetName: "Shop PETG-HF", originalName: "petg-hf.json", raw: PETG_PRESET, status: "ACTIVE" },
    { slot: "filament:OTHER_2", presetName: "Old", originalName: "old.json", raw: { type: "filament", name: "Old" }, status: "RETIRED" },
  ];
}

beforeEach(() => {
  db.rows.clear();
  db.upsert.mockClear();
  db.presets = [];
  profiles.queueProfileUpload.mockReset().mockResolvedValue(undefined);
  profiles.advanced = false;
  apiUtil.requireAdminApi.mockResolvedValue(null);
  vi.stubEnv("SHIPROCKET_EMAIL", "");
  vi.stubEnv("SHIPROCKET_PASSWORD", "");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("MAIL_TO", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  process.env.SESSION_SECRET = SECRET;
});

describe("download", () => {
  it("has every saved setting and the live presets, never a password or key", async () => {
    seedShop();
    const res = await route.GET();
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="print-rish-pw-settings-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const backup = await res.json();
    expect(backup).toMatchObject({ format: "print-shop-settings", version: 1 });
    expect(Object.keys(backup.sections)).toEqual(["pricing", "catalogAvailability", "materialHelper", "faq", "shipping", "mail"]);
    expect(backup.sections.pricing.setupFeePaise).toBe(9900);
    expect(backup.sections.catalogAvailability.customMaterials).toEqual({ OTHER_1: { name: "PETG-HF" } });
    expect(backup.sections.shipping).toMatchObject({ email: "api@shop.test", passwordSealed: "" });
    expect(backup.sections.mail.resendKeySealed).toBe("");
    const text = JSON.stringify(backup);
    expect(text).not.toContain((db.rows.get("shipping") as { passwordSealed: string }).passwordSealed);
    expect(text).not.toContain((db.rows.get("mail") as { resendKeySealed: string }).resendKeySealed);
    expect(backup.presets).toEqual([{ slot: "filament:OTHER_1", presetName: "Shop PETG-HF", originalName: "petg-hf.json", raw: PETG_PRESET }]);
  });

  it("is for the admin only", async () => {
    apiUtil.requireAdminApi.mockResolvedValue(Response.json({}, { status: 401 }));
    expect((await route.GET()).status).toBe(401);
    expect((await route.PUT(req)).status).toBe(401);
  });
});

describe("restore", () => {
  it("puts a fresh install back as it was, and re-tests the presets", async () => {
    seedShop();
    const backup = await download();
    const before = new Map(db.rows);
    db.rows.clear();
    db.presets = [];

    const { status, json } = await restore(backup);
    expect(status).toBe(200);
    expect(json.restored).toEqual(["Rates", "Catalog, colours and your own materials", "Material helper", "FAQ", "Shipping", "Email"]);
    for (const key of ["catalogAvailability", "faq"]) expect(db.rows.get(key)).toEqual(backup.sections[key]);
    expect((db.rows.get("pricing") as { setupFeePaise: number }).setupFeePaise).toBe(9900);
    expect(db.rows.get("materialHelper")).toMatchObject({ own: { own1: { label: "Flexible" } }, scores: { PETG: { own1: 2 } } });
    // A fresh install has no password to keep: saved blank, and the owner told.
    expect(db.rows.get("shipping")).toMatchObject({ email: "api@shop.test", passwordSealed: "" });
    expect(json.secretsToReenter).toEqual(["Shiprocket password (Settings → Shipping)", "Resend API key (Settings → Email)"]);
    // The custom material's preset goes through the upload path's test slice.
    expect(profiles.queueProfileUpload).toHaveBeenCalledOnce();
    const [upload, name] = profiles.queueProfileUpload.mock.calls[0]!;
    expect(upload.presets).toEqual([{ slot: "filament:OTHER_1", name: "Shop PETG-HF", raw: PETG_PRESET }]);
    expect(name).toBe("petg-hf.json");
    expect(json.presetsQueued).toBe(1);
    expect(before.size).toBe(6);
  });

  it("keeps this install's password or key when it's for the same account", async () => {
    seedShop();
    const backup = await download();
    const sealed = (db.rows.get("shipping") as { passwordSealed: string }).passwordSealed;
    db.presets = [];

    const { json } = await restore(backup);
    expect((db.rows.get("shipping") as { passwordSealed: string }).passwordSealed).toBe(sealed);
    expect(openSecret((db.rows.get("mail") as { resendKeySealed: string }).resendKeySealed, "mail-resend-key")).toBe("re_key");
    expect(json.secretsToReenter).toEqual([]);

    // Another Shiprocket account: this install's password isn't for it, and
    // its own shipping works, so that is kept rather than switched off…
    const otherAccount = { ...backup, presets: [], sections: { shipping: { ...backup.sections.shipping, email: "other@shop.test" } } };
    const kept = (await restore(otherAccount)).json;
    expect(db.rows.get("shipping")).toMatchObject({ email: "api@shop.test", passwordSealed: sealed });
    expect(kept.skipped).toContainEqual({ what: "Shipping", why: expect.stringContaining("was kept") });

    // …but where it isn't working anyway, it's restored and the owner told.
    db.rows.set("shipping", { ...(db.rows.get("shipping") as object), enabled: false });
    const other = (await restore(otherAccount)).json;
    expect(db.rows.get("shipping")).toMatchObject({ email: "other@shop.test", passwordSealed: "" });
    expect(other.secretsToReenter).toEqual(["Shiprocket password (Settings → Shipping)"]);
  });

  it("never switches off shipping that works from the environment", async () => {
    seedShop();
    const backup = await download();
    db.rows.clear();
    vi.stubEnv("SHIPROCKET_EMAIL", "env@shop.test");
    vi.stubEnv("SHIPROCKET_PASSWORD", "env-pw");

    const { json } = await restore({ ...backup, presets: [] });
    expect(db.rows.has("shipping")).toBe(false);
    expect(json.skipped).toContainEqual({ what: "Shipping", why: expect.stringContaining("was kept") });
    expect(json.restored).not.toContain("Shipping");
  });

  it("refuses anything that isn't a whole, valid backup, and writes nothing", async () => {
    seedShop();
    const backup = await download();
    db.upsert.mockClear();

    expect((await restore({ hello: "world" })).status).toBe(422);
    expect((await restore({ ...backup, format: "something-else" })).status).toBe(422);
    const newer = await restore({ ...backup, version: 2 });
    expect(newer.status).toBe(422);
    expect(newer.json.error.message).toMatch(/newer version/);
    const broken = await restore({ ...backup, sections: { ...backup.sections, faq: { custom: "not a list" } } });
    expect(broken.status).toBe(422);
    expect(broken.json.error.message).toBe("Nothing was restored: FAQ in that file isn't valid.");
    expect(db.upsert).not.toHaveBeenCalled();
    expect(profiles.queueProfileUpload).not.toHaveBeenCalled();
  });

  it("skips presets this install can't use or already has live", async () => {
    seedShop();
    const backup = await download();
    const processPreset = { slot: "process:200", presetName: "Fast 0.2", originalName: "fast.json", raw: { type: "process", name: "Fast 0.2" } };
    const { json } = await restore({ ...backup, sections: {}, presets: [...backup.presets, processPreset] });
    expect(json.skipped).toEqual([
      { what: 'Preset "Shop PETG-HF"', why: "already live here" },
      { what: 'Preset "Fast 0.2"', why: expect.stringContaining("advanced mode is off") },
    ]);
    expect(profiles.queueProfileUpload).not.toHaveBeenCalled();

    // In advanced mode the process preset is restored too.
    profiles.advanced = true;
    const advanced = await restore({ ...backup, sections: {}, presets: [processPreset] });
    expect(advanced.json.presetsQueued).toBe(1);
  });
});
