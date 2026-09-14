import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MATERIAL_IDS, ORCA_GENERIC_FILAMENTS } from "@print/shared";
import {
  ProfileIndex,
  bedOf,
  conditionMatches,
  generateProfiles,
  listPrinters,
  plateFor,
} from "./profile-gen";

// A miniature OrcaSlicer resources/profiles tree: one vendor with a printer, its
// processes and one filament of its own; the shared filament library for the rest.
let root: string;
const put = (path: string, data: object) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify(data));
};
const MACHINE = "Xyz One 0.4 nozzle";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orca-profiles-"));
  put("Xyz/machine/fdm_machine_common.json", { name: "fdm_machine_common", gcode_flavor: "marlin", printable_height: "150" });
  put("Xyz/machine/one.json", {
    name: MACHINE,
    inherits: "fdm_machine_common",
    instantiation: "true",
    printer_model: "Xyz One",
    printer_notes: "PRINTER_VENDOR_XYZ",
    nozzle_diameter: ["0.4"],
    printable_area: ["0x0", "200x0", "200x210", "0x210"],
    printable_height: "180",
  });
  put("Xyz/machine/dual.json", {
    name: "Xyz Dual 0.4 nozzle",
    instantiation: "true",
    nozzle_diameter: ["0.4", "0.4"],
    printable_area: ["0x0", "200x0", "200x200", "0x200"],
    printable_height: "200",
  });
  put("Xyz/machine/big-nozzle.json", {
    name: "Xyz One 0.6 nozzle",
    instantiation: "true",
    nozzle_diameter: ["0.6"],
    printable_area: ["0x0", "200x0", "200x200", "0x200"],
    printable_height: "200",
  });
  for (const [lh, label] of [["0.12", "Fine"], ["0.2", "Standard"], ["0.2", "Strength"]] as const) {
    put(`Xyz/process/${lh}-${label}.json`, {
      name: `${lh}mm ${label} @Xyz One`,
      instantiation: "true",
      layer_height: lh,
      compatible_printers: [MACHINE],
    });
  }
  // Vendor's own PLA, compatible by condition, exported with the crashing key.
  put("Xyz/filament/pla.json", {
    name: "Generic PLA @Xyz",
    instantiation: "true",
    filament_type: ["PLA"],
    filament_density: ["1.25"],
    filament_notes: "",
    textured_plate_temp: ["60"],
    compatible_printers_condition: "printer_notes=~/.*PRINTER_VENDOR_XYZ.*/ and nozzle_diameter[0]==0.4",
  });
  const lib = [
    ["Generic PLA @System", "PLA", 60, 60],
    ["Generic PLA Silk @System", "PLA", 60, 60],
    ["Generic PLA-CF @System", "PLA-CF", 60, 60],
    ["Generic PETG @System", "PET", 60, 80],
    ["Generic PETG-CF @System", "PET", 60, 80],
    ["Generic ABS @System", "ABS", 90, 90],
    ["Generic ASA @System", "ASA", 0, 100],
  ] as const;
  put("OrcaFilamentLibrary/filament/base.json", { name: "fdm_filament_common", filament_density: ["1.24"] });
  for (const [name, type, textured, hot] of lib) {
    put(`OrcaFilamentLibrary/filament/${name}.json`, {
      name,
      inherits: "fdm_filament_common",
      instantiation: "true",
      filament_type: [type],
      textured_plate_temp: [String(textured)],
      hot_plate_temp: [String(hot)],
    });
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("profile-gen", () => {
  it("lists only single-nozzle 0.4 mm printers, with their build volume", () => {
    const printers = listPrinters(new ProfileIndex(root));
    expect(printers).toEqual([{ vendor: "Xyz", machine: MACHINE, model: "Xyz One", bedMm: [200, 210, 180] }]);
  });

  it("generates a complete, flattened, CLI-safe set", () => {
    const { spec, files } = generateProfiles(new ProfileIndex(root), MACHINE, false);
    expect(Object.keys(files).sort()).toEqual(
      [
        "machine.json",
        "process.0.12.json",
        "process.0.16.json",
        "process.0.20.json",
        ...MATERIAL_IDS.map((m) => `filament.${m.toLowerCase().replace(/_/g, "-")}.json`),
      ].sort(),
    );
    for (const [name, profile] of Object.entries(files)) {
      expect(profile, name).not.toHaveProperty("inherits");
      expect(profile, name).not.toHaveProperty("filament_notes");
      expect(profile, name).not.toHaveProperty("__vendor");
      expect(profile.instantiation, name).toBe("true");
      if (name !== "machine.json") expect(profile.compatible_printers, name).toEqual([MACHINE]);
    }
    // Flattening merged the machine's parent.
    expect(files["machine.json"]!.gcode_flavor).toBe("marlin");
    // Preferred presets: "Standard" for 0.20; 0.16 derived from it.
    expect(files["process.0.20.json"]!.name).toContain("Standard");
    expect(files["process.0.16.json"]).toMatchObject({ layer_height: "0.16" });
    expect(String(files["process.0.16.json"]!.name)).toContain("derived");
    // The vendor's own PLA beats the library; the library covers the rest.
    expect(spec.filamentPresets?.PLA).toBe("Generic PLA @Xyz");
    expect(spec.filamentPresets?.PLA_AESTHETIC).toBe("Generic PLA Silk @System");
    expect(spec.filamentPresets?.PETG).toBe("Generic PETG @System");
    expect(spec.filamentPresets?.PETG_PREMIUM).toBe("Generic PETG-CF @System");
    expect(files["filament.petg.json"]!.filament_density).toEqual(["1.24"]);
    // ASA has no textured-plate temperature here, so it prints on the hot plate.
    expect(spec.plates.ASA).toBe("High Temp Plate");
    expect(spec.plates.PLA).toBe("Textured PEI Plate");
    expect(spec).toMatchObject({ id: "xyz-one-0-4-nozzle", name: "Xyz One", bedMm: [200, 210, 180], multiMaterial: false, generated: true });
  });

  it("refuses printers outside the quotable set", () => {
    expect(() => generateProfiles(new ProfileIndex(root), "Xyz Dual 0.4 nozzle", false)).toThrow(/single-extruder/);
  });

  it("evaluates the compatibility conditions Orca's presets use", () => {
    const m = { printer_notes: ["PRINTER_VENDOR_XYZ", "MODEL_ONE"], nozzle_diameter: ["0.4"], single_extruder_multi_material: "1" };
    expect(conditionMatches("", m)).toBe(true);
    expect(conditionMatches("printer_notes=~/.*PRINTER_VENDOR_XYZ.*/ and nozzle_diameter[0]==0.4", m)).toBe(true);
    expect(conditionMatches("printer_notes!~/.*MODEL_ONE.*/", m)).toBe(false);
    expect(conditionMatches("nozzle_diameter[0]==0.6", m)).toBe(false);
    expect(conditionMatches("single_extruder_multi_material", m)).toBe(true);
    expect(conditionMatches("printer_structure==\"corexy\"", m)).toBe(false);
  });

  it("reads a build volume and picks a plate the filament supports", () => {
    expect(bedOf({ printable_area: ["-5x-5", "245x-5", "245x215", "-5x215"], printable_height: "220" })).toEqual([250, 220, 220]);
    expect(plateFor({ textured_plate_temp: ["0"], hot_plate_temp: ["0"], cool_plate_temp: ["35"] })).toBe("Cool Plate");
  });

  it("builds the A1 set from the committed profiles, not the shop's PROFILES_DIR", async () => {
    // The installer runs `generate` in a worker container whose PROFILES_DIR is
    // the shop's (still empty) set; copying from there shipped no profiles.
    const empty = mkdtempSync(join(tmpdir(), "shop-profiles-"));
    const out = mkdtempSync(join(tmpdir(), "a1-out-"));
    vi.stubEnv("PROFILES_DIR", empty);
    vi.resetModules();
    const { main } = await import("./profile-gen");
    const { COMMITTED_PROFILES_DIR } = await import("./config");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await main(["generate", "Bambu Lab A1 0.4 nozzle", out]);
    } finally {
      stdout.mockRestore();
      vi.unstubAllEnvs();
    }
    const committed = readdirSync(COMMITTED_PROFILES_DIR).filter((f) => f.endsWith(".json") && f !== "printer.json");
    expect(committed).toContain("machine.bbl-a1-04.json");
    expect(readdirSync(out).sort()).toEqual([...committed, "printer.json"].sort());
    rmSync(empty, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
});

// Only where OrcaSlicer is installed (the worker image): the generics a shop's
// own material can start from must all exist in the OrcaSlicer we ship, and
// resolve to a filament with a density.
const ORCA_ROOT = "/opt/orca/resources/profiles";
describe.skipIf(!existsSync(join(ORCA_ROOT, "OrcaFilamentLibrary")))("the OrcaSlicer generics custom materials start from", () => {
  it("all ship with this OrcaSlicer and flatten to a usable filament", () => {
    const orca = new ProfileIndex(ORCA_ROOT);
    for (const name of ORCA_GENERIC_FILAMENTS) {
      const flat = orca.flattenPreset("filament", { name: "probe", inherits: name }, []);
      expect(Number((flat.filament_density as string[])[0]), name).toBeGreaterThan(0);
    }
  });
});
