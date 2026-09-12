import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG, MATERIAL_IDS } from "@print/shared";
import { MACHINE_PROFILE, config, filamentProfile, stubSlicerEnabled } from "./config";

describe("stubSlicerEnabled", () => {
  it("is disabled when the flag is absent or explicitly false", () => {
    expect(stubSlicerEnabled(undefined, "development")).toBe(false);
    expect(stubSlicerEnabled("false", "production")).toBe(false);
  });

  it("is available only in an explicitly development or test process", () => {
    expect(stubSlicerEnabled("true", "development")).toBe(true);
    expect(stubSlicerEnabled("true", "test")).toBe(true);
  });

  it("refuses the stub in production", () => {
    expect(() => stubSlicerEnabled("true", "production")).toThrow(/restricted/);
  });

  it("refuses the stub when NODE_ENV is unset", () => {
    const original = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(() => stubSlicerEnabled("true")).toThrow(/restricted/);
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });

  it("rejects ambiguous flag values", () => {
    expect(() => stubSlicerEnabled("1", "test")).toThrow(/true or false/);
  });
});

describe("filamentProfile", () => {
  const readProfile = (file: string) =>
    JSON.parse(readFileSync(join(config.profilesDir, file), "utf8")) as Record<string, unknown>;
  const machine = readProfile(MACHINE_PROFILE);

  it("gives every material its own shipped profile", () => {
    const files = MATERIAL_IDS.map(filamentProfile);
    expect(new Set(files).size).toBe(MATERIAL_IDS.length);
  });

  it.each(MATERIAL_IDS)("%s loads as a complete A1 preset of the right family", (material) => {
    const profile = readProfile(filamentProfile(material));
    // Shape the Orca CLI accepts without resolving anything.
    expect(profile.type).toBe("filament");
    expect(profile.instantiation).toBe("true");
    expect(profile).not.toHaveProperty("inherits");
    expect(profile.compatible_printers).toContain(machine.name);
    // Numakers exports write the per-filament vector `filament_notes` as a bare
    // "" — Orca 2.4.1 reads that as an empty vector and aborts in set_at()
    // before slicing anything (every slice failed NO_OUTPUT, exit 134).
    expect(profile).not.toHaveProperty("filament_notes");
    // PLA tiers must never slice with PETG temperatures, or vice versa.
    const family = material.startsWith("PETG") ? "PETG" : "PLA";
    expect((profile.filament_type as string[])[0]!.startsWith(family)).toBe(true);
    // The catalog's informational density tracks the profile the grams come from.
    expect(Number((profile.filament_density as string[])[0])).toBe(
      CATALOG.materials[material].densityGcm3,
    );
  });
});
