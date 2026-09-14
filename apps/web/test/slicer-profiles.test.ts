import { beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { NextRequest } from "next/server";
import { ProfileUploadRejected, parseProfileUpload } from "@/lib/slicer-profile-upload";

const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  createMany: vi.fn(),
  updateMany: vi.fn(),
}));
const queue = vi.hoisted(() => ({ add: vi.fn() }));
const apiUtil = vi.hoisted(() => ({
  requireAdminApi: vi.fn(async (): Promise<Response | null> => null),
  jsonError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
  readBinaryBody: vi.fn(),
}));
const security = vi.hoisted(() => ({ assertSameOrigin: vi.fn(() => true) }));

vi.mock("@print/db", () => ({
  prisma: { slicerProfileUpload: { findMany: db.findMany, createMany: db.createMany, updateMany: db.updateMany } },
  Prisma: {},
}));
vi.mock("@/lib/queue", () => ({ getSlicerProfileQueue: () => queue }));
vi.mock("@/lib/api-util", () => apiUtil);
vi.mock("@/lib/security", () => security);

const { GET, POST, DELETE } = await import("@/app/api/admin/slicer-profiles/route");
const { getPrinterProfile, getPrinterSpec } = await import("@/lib/printer");

const json = (value: object) => strToU8(JSON.stringify(value));
const myPla = { name: "My PLA", inherits: "Generic PLA @System", filament_settings_id: ["My PLA"] };
const req = (query: string) =>
  ({ nextUrl: new URL(`https://shop.test/api/admin/slicer-profiles${query}`) }) as unknown as NextRequest;

describe("parseProfileUpload", () => {
  it("takes a single preset for the row it was uploaded on", () => {
    expect(parseProfileUpload(json(myPla), "my-pla.json", "filament:PLA")).toEqual({
      presets: [{ slot: "filament:PLA", name: "My PLA", raw: myPla }],
      ignored: [],
    });
  });

  it("refuses a single preset of the wrong kind, or without a row", () => {
    expect(() => parseProfileUpload(json(myPla), "my-pla.json", "machine")).toThrow(/filament preset; this row needs a printer/);
    expect(() => parseProfileUpload(json(myPla), "my-pla.json", null)).toThrow(ProfileUploadRejected);
    expect(() => parseProfileUpload(strToU8("{nope"), "x.json", "machine")).toThrow(/isn't valid JSON/);
    expect(() => parseProfileUpload(strToU8("[1,2]"), "x.json", "machine")).toThrow(/isn't an OrcaSlicer preset/);
  });

  it("unpacks a printer bundle: the printer, its processes, not its filaments", () => {
    const bundle = zipSync({
      "bundle_structure.json": json({ bundle_type: "printer config bundle" }),
      "printer/My Voron.json": json({ name: "My Voron", printer_settings_id: "My Voron", inherits: "Voron 2.4 300 0.4 nozzle" }),
      "process/Fast.json": json({ name: "Fast", print_settings_id: "Fast" }),
      "process/Fine.json": json({ name: "Fine", layer_height: "0.12" }),
      "filament/My ABS.json": json({ name: "My ABS", filament_settings_id: ["My ABS"] }),
    });
    const parsed = parseProfileUpload(bundle, "voron.orca_printer", null);
    expect(parsed.presets.map((p) => [p.name, p.slot])).toEqual([
      ["My Voron", "machine"],
      ["Fast", null],
      ["Fine", null],
    ]);
    expect(parsed.ignored).toEqual(["My ABS"]);
    expect(() => parseProfileUpload(bundle, "voron.orca_printer", "filament:ABS")).toThrow(/Printer row/);
  });

  it("takes a filament bundle's one preset for the material row", () => {
    const one = zipSync({ "filament/My PLA.json": json(myPla) });
    expect(parseProfileUpload(one, "pla.orca_filament", "filament:PLA").presets).toEqual([
      { slot: "filament:PLA", name: "My PLA", raw: myPla },
    ]);
    expect(() => parseProfileUpload(one, "pla.orca_filament", "machine")).toThrow(/material it's for/);
    const two = zipSync({ "a.json": json(myPla), "b.json": json({ ...myPla, name: "My PLA 2" }) });
    expect(() => parseProfileUpload(two, "pla.orca_filament", "filament:PLA")).toThrow(/2 filament presets \(My PLA, My PLA 2\)/);
  });

  it("bounds what a bundle may unpack to", () => {
    const many = zipSync(Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`p${i}.json`, json({ name: `p${i}` })])));
    expect(() => parseProfileUpload(many, "big.orca_printer", null)).toThrow(/too many files/);
    const huge = zipSync({ "printer/big.json": json({ name: "big", printer_settings_id: "big", pad: "x".repeat(1_100_000) }) });
    expect(() => parseProfileUpload(huge, "big.orca_printer", null)).toThrow(/too large once unpacked/);
    expect(() => parseProfileUpload(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "bad.orca_printer", null)).toThrow(/readable OrcaSlicer bundle/);
  });
});

describe("/api/admin/slicer-profiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ADVANCED_PROFILES", "1");
    apiUtil.requireAdminApi.mockResolvedValue(null);
    security.assertSameOrigin.mockReturnValue(true);
    db.findMany.mockResolvedValue([]);
    db.createMany.mockResolvedValue({ count: 1 });
    db.updateMany.mockResolvedValue({ count: 1 });
    queue.add.mockResolvedValue({});
    apiUtil.readBinaryBody.mockResolvedValue({ ok: true, value: Buffer.from(json(myPla)) });
  });

  it("refuses anyone but the admin, and a cross-origin write", async () => {
    apiUtil.requireAdminApi.mockResolvedValue(Response.json({}, { status: 401 }));
    expect((await GET()).status).toBe(401);
    expect((await POST(req("?slot=filament:PLA"))).status).toBe(401);
    apiUtil.requireAdminApi.mockResolvedValue(null);
    security.assertSameOrigin.mockReturnValue(false);
    expect((await POST(req("?slot=filament:PLA"))).status).toBe(403);
    expect((await DELETE(req("?slot=filament:PLA"))).status).toBe(403);
    expect(db.createMany).not.toHaveBeenCalled();
  });

  it("outside advanced mode, takes presets only for the shop's own materials", async () => {
    vi.stubEnv("ADVANCED_PROFILES", "");
    const state = await (await GET()).json();
    expect(state.slots.map((s: { slot: string }) => s.slot)).toEqual(["filament:OTHER_1", "filament:OTHER_2", "filament:OTHER_3", "filament:OTHER_4"]);
    for (const slot of ["filament:PLA", "machine", "process:200"]) {
      expect((await POST(req(`?slot=${slot}`))).status, slot).toBe(403);
    }
    // A bundle (no slot) is a whole printer.
    expect((await POST(req(""))).status).toBe(403);
    expect((await DELETE(req("?slot=filament:PLA"))).status).toBe(403);
    expect(db.createMany).not.toHaveBeenCalled();

    const res = await POST(req("?slot=filament:OTHER_1&name=abs-cf.json"));
    expect(res.status).toBe(202);
    expect(db.createMany.mock.calls[0]![0].data).toEqual([expect.objectContaining({ slot: "filament:OTHER_1", status: "PENDING" })]);
  });

  it("stores an upload as one pending batch and queues its test slice", async () => {
    const res = await POST(req("?slot=filament:PLA&name=my-pla.json"));
    expect(res.status).toBe(202);
    const rows = db.createMany.mock.calls[0]![0].data;
    expect(rows).toEqual([
      expect.objectContaining({ slot: "filament:PLA", presetName: "My PLA", originalName: "my-pla.json", raw: myPla, status: "PENDING" }),
    ]);
    expect(queue.add).toHaveBeenCalledWith("test", { batchId: rows[0].batchId }, { jobId: `profile_${rows[0].batchId}` });
    const body = await res.json();
    expect(body.slots).toHaveLength(15);
  });

  it("explains a rejected file and stores nothing", async () => {
    const res = await POST(req("?slot=machine&name=my-pla.json"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/filament preset/);
    expect((await POST(req("?slot=filament:NYLON"))).status).toBe(422);
    expect(db.createMany).not.toHaveBeenCalled();
  });

  it("marks the batch failed when the test can't be queued", async () => {
    queue.add.mockRejectedValue(new Error("redis down"));
    expect((await POST(req("?slot=filament:PLA"))).status).toBe(503);
    expect(db.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
  });

  it("reports the density and generic a filament preset was made with, so a reload shows them", async () => {
    vi.stubEnv("ADVANCED_PROFILES", "");
    const at = (s: number) => new Date(Date.UTC(2026, 8, 14, 0, 0, s));
    const row = (id: string, status: string, s: number) => ({
      id,
      batchId: `b-${id}`,
      slot: "filament:OTHER_1",
      originalName: "x.json",
      presetName: "PC (from Generic PC)",
      status,
      error: null,
      testGrams: status === "ACTIVE" ? 3.1 : null,
      createdAt: at(s),
      checkedAt: null,
    });
    const presets: Record<string, { raw: object; flattened: object | null }> = {
      live: { raw: { inherits: "Generic PC @System", filament_density: ["1.20"] }, flattened: { filament_density: ["1.20"] } },
      next: { raw: { inherits: "Generic PC @System", filament_density: ["1.40"] }, flattened: null },
    };
    const rows = [row("next", "PENDING", 2), row("live", "ACTIVE", 1)];
    db.findMany.mockImplementation(
      async ({ select, where }: { select: Record<string, boolean>; where: { id?: { in: string[] }; batchId?: { in: string[] } } }) => {
        if (select.raw) return where.id!.in.map((id) => ({ id, ...presets[id] }));
        if (where.batchId) return rows.filter((r) => where.batchId!.in.includes(r.batchId));
        return rows;
      },
    );
    const state = await (await GET()).json();
    const slot = state.slots.find((s: { slot: string }) => s.slot === "filament:OTHER_1");
    expect(slot.live).toMatchObject({ densityGcm3: 1.2, startedFrom: "Generic PC @System", testGrams: 3.1 });
    expect(slot.testing).toBe(true);
    expect(slot.pending).toEqual({ densityGcm3: 1.4, startedFrom: "Generic PC @System" });
    // Never the presets themselves.
    expect(JSON.stringify(state)).not.toContain("filament_density");
  });

  it("puts a slot back on the installed preset", async () => {
    expect((await DELETE(req("?slot=process:160"))).status).toBe(200);
    expect(db.updateMany).toHaveBeenCalledWith({
      where: { slot: "process:160", status: "ACTIVE" },
      data: { status: "RETIRED", checkedAt: expect.any(Date) },
    });
    expect((await DELETE(req("?slot=nope"))).status).toBe(422);
  });
});

describe("getPrinterProfile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is the installed printer, untouched, until one of the shop's own materials has a profile (print.rish.pw)", async () => {
    vi.stubEnv("ADVANCED_PROFILES", "");
    db.findMany.mockResolvedValueOnce([]);
    expect(await getPrinterProfile()).toEqual(getPrinterSpec());
    // Only the shop's own materials' slots are even asked for.
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "ACTIVE", slot: { in: ["filament:OTHER_1", "filament:OTHER_2", "filament:OTHER_3", "filament:OTHER_4"] } } }),
    );
  });

  it("outside advanced mode, applies the shop's own materials' profiles and ignores the rest", async () => {
    vi.stubEnv("ADVANCED_PROFILES", "");
    db.findMany.mockResolvedValueOnce([
      { id: "c1", slot: "filament:OTHER_1", meta: { presetName: "PC (from Generic PC)", plate: "Textured PEI Plate" } },
      { id: "x", slot: "machine", meta: { presetName: "Leftover", bedMm: [100, 100, 100] } },
    ]);
    const spec = await getPrinterProfile();
    expect(spec.id).toMatch(/^bbl-a1-r[0-9a-z]{11}$/);
    expect(spec.filamentPresets?.OTHER_1).toBe("PC (from Generic PC)");
    expect(spec.bedMm).toEqual(getPrinterSpec().bedMm);
  });

  it("carries the live uploads' revision in advanced mode", async () => {
    vi.stubEnv("ADVANCED_PROFILES", "1");
    db.findMany.mockResolvedValue([{ id: "u1", slot: "filament:PLA", meta: { presetName: "My PLA", plate: "Cool Plate" } }]);
    const spec = await getPrinterProfile();
    expect(spec.id).toMatch(/^bbl-a1-r[0-9a-z]{11}$/);
    expect(spec.plates.PLA).toBe("Cool Plate");
  });
});
