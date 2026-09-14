import { describe, expect, it } from "vitest";
import {
  CUSTOM_MATERIAL_NAME_MAX,
  ORCA_GENERIC_FILAMENTS,
  cleanCustomMaterialName,
  filamentPresetFacts,
  slotInScope,
  startingPreset,
} from "./custom-materials";
import { customMaterialProblem, defaultAvailability, effectiveAvailability, toPublicCatalog } from "./catalog-availability";
import { normalizeAvailability } from "./catalog-availability-schema";
import { materialName } from "./catalog";
import { filamentLine } from "./costs";
import { slotMismatch } from "./orca-profile";
import { CUSTOM_MATERIAL_IDS, STOCK_MATERIAL_IDS, isCustomMaterial, type CustomMaterialId } from "./quote-types";

const none = new Set<CustomMaterialId>();

describe("the shop's own materials", () => {
  it("are four slots, apart from the stock materials", () => {
    expect(CUSTOM_MATERIAL_IDS).toEqual(["OTHER_1", "OTHER_2", "OTHER_3", "OTHER_4"]);
    expect(STOCK_MATERIAL_IDS).not.toContain("OTHER_1");
    expect(isCustomMaterial("OTHER_2")).toBe(true);
    expect(isCustomMaterial("ABS")).toBe(false);
  });

  it("ship switched off, unnamed, costed on their own spool lines", () => {
    const avail = defaultAvailability();
    for (const id of CUSTOM_MATERIAL_IDS) expect(avail.materials[id]).toBe(false);
    expect(avail.customMaterials).toEqual({});
    expect(materialName("OTHER_3")).toBe("Other material 3");
    expect(filamentLine("OTHER_1", "custom-other-1-black")).toBe("other1");
  });

  it("take names like the ones shops actually use, and refuse the rest", () => {
    for (const ok of ["ABS-CF", "PC-PBT-GF", "PA12 (CF 15%)", "Nylon/PA6", "PETG & glass"]) {
      expect(cleanCustomMaterialName(ok), ok).toBe(ok);
    }
    expect(cleanCustomMaterialName("  ABS   GF ")).toBe("ABS GF");
    for (const bad of ["", "   ", "-ABS", "<b>ABS</b>", 'AB"S', "A\\B", "x".repeat(CUSTOM_MATERIAL_NAME_MAX + 1), 42, null]) {
      expect(cleanCustomMaterialName(bad), String(bad)).toBeNull();
    }
  });

  it("keeps stored names that are usable, for real slots only", () => {
    const norm = normalizeAvailability({
      customMaterials: { OTHER_1: { name: " ABS-CF " }, OTHER_2: { name: "<bad>" }, OTHER_9: { name: "PC" }, PLA: { name: "x" } },
    });
    expect(norm.customMaterials).toEqual({ OTHER_1: { name: "ABS-CF" } });
    expect(materialName("OTHER_1", norm.customMaterials)).toBe("ABS-CF");
    expect(materialName("PLA", norm.customMaterials)).toBe("PLA");
  });
});

describe("offering one of the shop's own materials", () => {
  const stored = normalizeAvailability({
    materials: { PLA: true, OTHER_1: true, OTHER_2: true, OTHER_3: true },
    customMaterials: { OTHER_1: { name: "ABS-CF" }, OTHER_3: { name: "PC" } },
  });

  it("needs a name and a live OrcaSlicer profile", () => {
    const ready = new Set<CustomMaterialId>(["OTHER_1", "OTHER_2"]);
    const live = effectiveAvailability(stored, ready);
    expect(live.materials.OTHER_1).toBe(true); // named + ready
    expect(live.materials.OTHER_2).toBe(false); // ready, no name
    expect(live.materials.OTHER_3).toBe(false); // named, no profile
    expect(live.materials.OTHER_4).toBe(false); // never switched on
    expect(live.materials.PLA).toBe(true); // stock materials untouched
    expect(stored.materials.OTHER_3).toBe(true); // the stored choice is kept for when it's ready
  });

  it("says what is missing", () => {
    expect(customMaterialProblem(stored, "OTHER_2", none)).toBe("Other material 2 needs a name first.");
    expect(customMaterialProblem(stored, "OTHER_3", none)).toMatch(/^PC needs an OrcaSlicer profile first/);
    expect(customMaterialProblem(stored, "OTHER_1", new Set(["OTHER_1"]))).toBeNull();
  });

  it("shows the owner each slot's setup, and customers only names", () => {
    const admin = toPublicCatalog(stored, new Set(["OTHER_1"]));
    const one = admin.materials.find((m) => m.id === "OTHER_1")!;
    expect(one).toMatchObject({ name: "ABS-CF", setup: { named: true, ready: true, problem: null } });
    expect(admin.materials.find((m) => m.id === "PLA")).not.toHaveProperty("setup");
    const pub = toPublicCatalog(effectiveAvailability(stored, new Set(["OTHER_1"])));
    expect(pub.materials.find((m) => m.id === "OTHER_1")).toMatchObject({ name: "ABS-CF", enabled: true });
    expect(pub.materials.find((m) => m.id === "OTHER_3")).toMatchObject({ name: "PC", enabled: false });
    expect(pub.materials.every((m) => !("setup" in m))).toBe(true);
  });
});

describe("OrcaSlicer profiles for the shop's own materials", () => {
  it("open only their filament slots unless the install is in advanced mode", () => {
    expect(slotInScope("filament:OTHER_1", false)).toBe(true);
    for (const slot of ["filament:PLA", "machine", "process:200"]) expect(slotInScope(slot, false), slot).toBe(false);
    for (const slot of ["filament:PLA", "machine", "process:200", "filament:OTHER_4"]) expect(slotInScope(slot, true), slot).toBe(true);
    expect(slotInScope("filament:NYLON", true)).toBe(false);
    expect(slotInScope("anything", true)).toBe(false);
  });

  it("accept any filament type, as long as grams can be worked out", () => {
    expect(slotMismatch({ type: "filament", filament_type: ["PC"], filament_density: ["1.2"] }, "filament:OTHER_1")).toBeNull();
    expect(slotMismatch({ type: "filament", filament_type: ["PC"], filament_density: ["1.2"] }, "filament:ABS")).toMatch(/needs a ABS preset/);
    expect(slotMismatch({ type: "filament", filament_type: ["PC"] }, "filament:OTHER_1")).toMatch(/no density/);
  });

  it("can start from one of OrcaSlicer's generics, with the filament's real density", () => {
    expect(startingPreset("PC-PBT-GF", "Generic PC @System", 1.3)).toEqual({
      type: "filament",
      name: "PC-PBT-GF (from Generic PC)",
      inherits: "Generic PC @System",
      from: "User",
      instantiation: "true",
      filament_density: ["1.30"],
    });
    expect(startingPreset("ABS-CF", "Generic ABS @System")).not.toHaveProperty("filament_density");
    expect(() => startingPreset("X", "Generic ABS @System", 9)).toThrow(RangeError);
  });

  it("reads back the density and generic a stored preset was made with", () => {
    const sent = startingPreset("PC-PBT-GF", "Generic PC @System", 1.4);
    expect(filamentPresetFacts(sent)).toEqual({ densityGcm3: 1.4, startedFrom: "Generic PC @System" });
    // Once the worker has resolved it, the resolved density is what slices use.
    expect(filamentPresetFacts(sent, { filament_density: ["1.42"] })).toEqual({ densityGcm3: 1.42, startedFrom: "Generic PC @System" });
    // An exported preset inherits from a vendor preset, maybe without a density of its own.
    expect(filamentPresetFacts({ inherits: "Numakers PLA+", name: "Mine" })).toEqual({});
    expect(filamentPresetFacts({ inherits: "Numakers PLA+" }, { filament_density: "1.24" })).toEqual({ densityGcm3: 1.24 });
    expect(filamentPresetFacts({ filament_density: ["0"] })).toEqual({});
    expect(filamentPresetFacts(null, "nonsense")).toEqual({});
  });

  it("lists each generic once", () => {
    expect(new Set(ORCA_GENERIC_FILAMENTS).size).toBe(ORCA_GENERIC_FILAMENTS.length);
    for (const g of ORCA_GENERIC_FILAMENTS) expect(g).toMatch(/^Generic .+ @System$/);
  });
});
