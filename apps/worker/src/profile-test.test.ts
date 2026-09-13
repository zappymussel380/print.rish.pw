import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@print/db", () => ({
  Prisma: {},
  prisma: {
    slicerProfileUpload: { findMany: mocks.findMany, updateMany: mocks.updateMany, update: mocks.update },
    $transaction: mocks.transaction,
  },
}));

// config.ts reads its environment on import: slice into a scratch work root,
// from the committed A1 set.
const work = mkdtempSync(join(tmpdir(), "profile-test-work-"));
vi.stubEnv("SLICE_WORK_DIR", work);
vi.stubEnv("PROFILES_DIR", "");
const { ProfileIndex } = await import("./profile-gen.js");
const { cubeStl, planBatch, processProfileBatch, testSlicesFor } = await import("./profile-test.js");

// A miniature OrcaSlicer presets tree to resolve uploads against.
const root = mkdtempSync(join(tmpdir(), "orca-presets-"));
const put = (path: string, data: object) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify(data));
};
put("OrcaFilamentLibrary/filament/generic-pla.json", {
  name: "Generic PLA @System",
  filament_type: ["PLA"],
  filament_density: ["1.24"],
  filament_flow_ratio: ["0.98"],
  textured_plate_temp: ["65"],
});
put("Custom/process/020.json", { name: "0.20mm Standard @Generic", layer_height: "0.2", wall_loops: "2" });
put("Custom/machine/klipper.json", {
  name: "Generic Klipper Printer 0.4 nozzle",
  nozzle_diameter: ["0.4"],
  printable_area: ["0x0", "220x0", "220x220", "0x220"],
  printable_height: "250",
});
const index = new ProfileIndex(root);

const BATCH = "33333333-3333-4333-8333-333333333333";
const row = (id: string, slot: string | null, raw: object) => ({ id, slot, presetName: String((raw as { name?: string }).name), raw });
const myPla = { name: "My PLA", inherits: "Generic PLA @System", filament_settings_id: ["My PLA"], filament_flow_ratio: ["0.95"], post_process: ["rm -rf /"] };

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockResolvedValue([]);
  mocks.updateMany.mockReturnValue({ op: "updateMany" });
  mocks.update.mockImplementation((args: unknown) => ({ op: "update", args }));
});

describe("planBatch", () => {
  it("resolves a user preset through the system preset it's based on", () => {
    const [plan] = planBatch([row("a", "filament:PLA", myPla)], index);
    expect(plan!.slot).toBe("filament:PLA");
    expect(plan!.flattened).toMatchObject({ filament_type: ["PLA"], filament_density: ["1.24"], filament_flow_ratio: ["0.95"] });
    expect(plan!.meta).toEqual({ presetName: "My PLA", plate: "Textured PEI Plate" });
  });

  it("places a bundle's process presets by layer height and skips the rest", () => {
    const plans = planBatch(
      [
        row("m", "machine", { name: "My Klipper", inherits: "Generic Klipper Printer 0.4 nozzle", printer_settings_id: "My Klipper", printable_area: ["0x0", "300x0", "300x300", "0x300"] }),
        row("p1", null, { name: "Fast 0.20", inherits: "0.20mm Standard @Generic", print_settings_id: "Fast 0.20" }),
        row("p2", null, { name: "Draft 0.28", print_settings_id: "Draft 0.28", layer_height: "0.28" }),
        row("p3", null, { name: "Other 0.20", print_settings_id: "Other 0.20", layer_height: "0.2" }),
      ],
      index,
    );
    const by = Object.fromEntries(plans.map((p) => [p.id, p]));
    expect(by.m!.meta).toEqual({ presetName: "My Klipper", bedMm: [300, 300, 250], nozzleMm: 0.4 });
    expect(by.p1!.slot).toBe("process:200");
    expect(by.p2).toMatchObject({ slot: null, skipReason: expect.stringMatching(/0.28 mm layers/) });
    expect(by.p3).toMatchObject({ slot: null, skipReason: expect.stringMatching(/already covers 0.20 mm/) });
  });

  it("refuses a preset whose parent this OrcaSlicer doesn't ship", () => {
    expect(() => planBatch([row("a", "filament:PLA", { ...myPla, inherits: "Someone's PLA" })], index)).toThrow(
      /My PLA: .*based on "Someone's PLA".*bundle/,
    );
  });

  it("refuses a preset in the wrong slot", () => {
    expect(() => planBatch([row("a", "filament:ABS", myPla)], index)).toThrow(/PLA; this slot needs a ABS/);
  });
});

describe("test slices", () => {
  it("slices each touched height and material once", () => {
    const tests = testSlicesFor([
      { id: "m", slot: "machine", flattened: {}, meta: { presetName: "m" } },
      { id: "p", slot: "process:200", flattened: {}, meta: { presetName: "p" } },
      { id: "f", slot: "filament:PETG", flattened: {}, meta: { presetName: "f" } },
    ]);
    expect(tests.map((t) => [t.label, t.ids])).toEqual([
      ["PLA at 0.20 mm", ["m", "p"]],
      ["PETG at 0.20 mm", ["f"]],
    ]);
  });

  it("slices a closed 20 mm cube", () => {
    const stl = cubeStl();
    expect(stl.length).toBe(84 + 12 * 50);
    expect(stl.readUInt32LE(80)).toBe(12);
    // Signed volume from the triangles: positive only if every face points out.
    let volume = 0;
    for (let i = 0; i < 12; i++) {
      const at = 84 + i * 50 + 12;
      const p = [0, 1, 2].map((k) => [0, 1, 2].map((j) => stl.readFloatLE(at + k * 12 + j * 4)));
      const [a, b, c] = p as [number[], number[], number[]];
      volume += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
    }
    expect(volume).toBeCloseTo(8000, 3);
  });
});

describe("processProfileBatch", () => {
  const pending = [{ id: "a", slot: "filament:PLA", presetName: "My PLA", raw: myPla }];

  it("tests the candidate set and makes the batch live", async () => {
    mocks.findMany.mockResolvedValueOnce(pending).mockResolvedValueOnce([]);
    let seen: { dir: string; files: string[]; filament: Record<string, unknown> } | null = null;
    const slice = vi.fn(async (_input, settings, _workDir, _identity, _progress, set) => {
      const files = readdirSync(set.dir);
      seen = { dir: set.dir, files, filament: JSON.parse(readFileSync(join(set.dir, "filament.pla.json"), "utf8")) };
      expect(settings).toEqual({ material: "PLA", layerHeightUm: 200, infillPct: 15, supports: "off" });
      return { ok: true, filamentGrams: 3.1, slicerVersion: "2.4.1", rawMeta: {} };
    });

    await processProfileBatch(BATCH, { index: () => index, slice });

    expect(slice).toHaveBeenCalledTimes(1);
    expect(seen!.files).toEqual(expect.arrayContaining(["machine.bbl-a1-04.json", "process.0.20.json", "printer.json"]));
    expect(seen!.filament).toMatchObject({ name: "My PLA", filament_flow_ratio: ["0.95"], compatible_printers: ["Bambu Lab A1 0.4 nozzle"] });
    expect(seen!.filament).not.toHaveProperty("post_process");
    // The test set is gone, and the batch replaced what was live in one go.
    expect(readdirSync(join(work, "profile-sets"))).toEqual([]);
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { status: "ACTIVE", slot: { in: ["filament:PLA"] } }, data: { status: "RETIRED" } });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "a" },
      data: expect.objectContaining({ status: "ACTIVE", slot: "filament:PLA", testGrams: 3.1, meta: { presetName: "My PLA", plate: "Textured PEI Plate" } }),
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("records Orca's error and leaves the live set alone when the test slice fails", async () => {
    mocks.findMany.mockResolvedValueOnce(pending).mockResolvedValueOnce([]);
    const slice = vi.fn(async () => ({ ok: false, errorCode: "SLICER_REJECTED_MODEL", errorMessage: "Nozzle temperature too low.", slicerVersion: "2.4.1", rawMeta: {} }));

    await processProfileBatch(BATCH, { index: () => index, slice });

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenLastCalledWith({
      where: { batchId: BATCH, status: { in: ["PENDING", "TESTING"] } },
      data: expect.objectContaining({ status: "FAILED", error: expect.stringMatching(/PLA at 0.20 mm.*Nozzle temperature too low/) }),
    });
  });

  it("fails an unusable upload before slicing anything", async () => {
    mocks.findMany.mockResolvedValueOnce([{ ...pending[0], slot: "machine" }]);
    const slice = vi.fn();
    await processProfileBatch(BATCH, { index: () => index, slice });
    expect(slice).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", error: expect.stringMatching(/filament preset; this slot needs a printer/) }) }),
    );
  });
});
