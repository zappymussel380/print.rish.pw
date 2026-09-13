import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
const apiUtil = vi.hoisted(() => ({
  requireAdminApi: vi.fn(async (): Promise<Response | null> => null),
  jsonError: (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status }),
  readJsonBody: vi.fn(),
}));
const sameOrigin = vi.hoisted(() => ({ ok: true }));

vi.mock("@print/db", () => ({
  prisma: { appSetting: { findUnique: db.findUnique, upsert: db.upsert } },
  Prisma: {},
}));
vi.mock("@/lib/api-util", () => apiUtil);
vi.mock("@/lib/security", () => ({ assertSameOrigin: () => sameOrigin.ok }));

const pricingRoute = await import("@/app/api/admin/pricing/route");
const siteRoute = await import("@/app/api/admin/site/route");
const faqRoute = await import("@/app/api/admin/faq/route");

const fakeReq = () => ({}) as unknown as NextRequest;
const body = (value: unknown) => apiUtil.readJsonBody.mockResolvedValue({ ok: true, value });
const stored = () => (db.upsert.mock.calls[0]![0] as { create: { key: string; value: Record<string, unknown> } }).create;

beforeEach(() => {
  db.upsert.mockReset().mockResolvedValue({});
  db.findUnique.mockReset().mockResolvedValue(null);
  apiUtil.requireAdminApi.mockReset().mockResolvedValue(null);
  apiUtil.readJsonBody.mockReset();
  sameOrigin.ok = true;
});

describe("PUT /api/admin/pricing", () => {
  it("rejects unauthenticated and cross-origin callers", async () => {
    apiUtil.requireAdminApi.mockResolvedValueOnce(Response.json({}, { status: 401 }));
    expect((await pricingRoute.PUT(fakeReq())).status).toBe(401);
    sameOrigin.ok = false;
    expect((await pricingRoute.PUT(fakeReq())).status).toBe(403);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("stores the complete rate set, with the edit applied", async () => {
    body({ setupFeePaise: 120_00, materials: { ABS: { sellPerGramPaise: 280 } } });
    const res = await pricingRoute.PUT(fakeReq());
    expect(res.status).toBe(200);
    const saved = stored();
    expect(saved.key).toBe("pricing");
    expect(saved.value.setupFeePaise).toBe(120_00);
    const materials = saved.value.materials as Record<string, { sellPerGramPaise: number }>;
    expect(materials.ABS!.sellPerGramPaise).toBe(280);
    expect(materials.PLA!.sellPerGramPaise).toBe(200);
  });

  it("refuses the whole save when any value is out of range, naming it", async () => {
    body({ setupFeePaise: 120_00, materials: { PLA: { sellPerGramPaise: 0 } } });
    const res = await pricingRoute.PUT(fakeReq());
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("materials.PLA.sellPerGramPaise");
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("GET falls back to the code rates when nothing is stored", async () => {
    const res = await pricingRoute.GET();
    const json = (await res.json()) as { setupFeePaise: number };
    expect(json.setupFeePaise).toBe(150_00);
  });
});

describe("PUT /api/admin/site", () => {
  it("stores a normalised profile", async () => {
    body({
      brandName: "Acme Prints",
      city: "Pune",
      contact: { whatsappNumber: "+91 98765 43210", email: "hi@acme.in" },
      materialsPage: ["PLA", "ABS"],
    });
    const res = await siteRoute.PUT(fakeReq());
    expect(res.status).toBe(200);
    const saved = stored();
    expect(saved.key).toBe("siteProfile");
    expect(saved.value).toMatchObject({
      brandName: "Acme Prints",
      city: "Pune",
      contact: { whatsappNumber: "919876543210", email: "hi@acme.in", phone: "", address: "" },
      materialsPage: ["PLA", "ABS"],
    });
  });

  it("refuses invalid fields instead of silently replacing them", async () => {
    body({ brandName: "", contact: { email: "nope" } });
    const res = await siteRoute.PUT(fakeReq());
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "brandName, contact.email",
    );
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("GET returns the stored profile without env fallbacks", async () => {
    vi.stubEnv("WHATSAPP_NUMBER", "911111111111");
    db.findUnique.mockResolvedValue({ value: { brandName: "Acme Prints" } });
    const json = (await (await siteRoute.GET()).json()) as { brandName: string; contact: { whatsappNumber: string } };
    expect(json.brandName).toBe("Acme Prints");
    expect(json.contact.whatsappNumber).toBe("");
    vi.unstubAllEnvs();
  });
});

describe("PUT /api/admin/faq", () => {
  it("stores the shop's own entries and hidden generated ones", async () => {
    body({ custom: [{ id: "custom-colours", q: "Custom colours?", a: "Ask for 800 g+ jobs." }], hidden: ["payment"] });
    const res = await faqRoute.PUT(fakeReq());
    expect(res.status).toBe(200);
    const saved = stored();
    expect(saved.key).toBe("faq");
    expect(saved.value).toEqual({
      custom: [{ id: "custom-colours", q: "Custom colours?", a: "Ask for 800 g+ jobs." }],
      hidden: ["payment"],
    });
  });

  it("refuses an entry with no answer", async () => {
    body({ custom: [{ id: "custom-x", q: "Question?", a: "  " }], hidden: [] });
    expect((await faqRoute.PUT(fakeReq())).status).toBe(422);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("rejects cross-origin saves", async () => {
    sameOrigin.ok = false;
    body({ custom: [], hidden: [] });
    expect((await faqRoute.PUT(fakeReq())).status).toBe(403);
  });
});
