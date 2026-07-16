import { describe, expect, it } from "vitest";
import { buildAnnexure } from "@/lib/pdf/annexure-data";

/** Prisma Decimal stand-in: Number() coerces via toString. */
class FakeDecimal {
  constructor(private readonly value: string) {}
  toString(): string {
    return this.value;
  }
}
const dec = (v: string) => new FakeDecimal(v) as unknown as number;

describe("buildAnnexure", () => {
  it("maps model, slice, settings and pricing into a PdfAnnexure, coercing Decimals", () => {
    const result = buildAnnexure({
      fileName: "Spacer_Plate.STL",
      thumbnailPng: Buffer.from("png"),
      model: {
        bboxXMm: dec("38.20"),
        bboxYMm: dec("120.00"),
        bboxZMm: dec("4.50"),
        volumeCm3: dec("21.70"),
        format: "stl",
        sizeBytes: 2663084,
      },
      slice: {
        filamentGrams: dec("38.60"),
        filamentMm: dec("12894.10"),
        printSeconds: 6120,
        slicerVersion: "OrcaSlicer 2.4.1",
      },
      settings: {
        material: "PETG",
        colour: "black",
        layerHeightUm: 200,
        infillPct: 15,
        supports: "auto",
        quantity: 1,
      },
      pricing: { materialPaise: 5000, electricityPaise: 3000, maintenancePaise: 1653, subtotalPaise: 9653 },
    });

    expect(result).toEqual({
      fileName: "Spacer_Plate.STL",
      thumbnailPng: Buffer.from("png"),
      geometry: {
        bboxXMm: 38.2,
        bboxYMm: 120,
        bboxZMm: 4.5,
        volumeCm3: 21.7,
        format: "stl",
        sizeBytes: 2663084,
      },
      settings: {
        material: "PETG",
        colour: "black",
        layerHeightUm: 200,
        infillPct: 15,
        supports: "auto",
        quantity: 1,
      },
      slicer: {
        filamentGrams: 38.6,
        filamentMm: 12894.1,
        printSeconds: 6120,
        slicerVersion: "OrcaSlicer 2.4.1",
      },
      pricing: { materialPaise: 5000, electricityPaise: 3000, maintenancePaise: 1653, subtotalPaise: 9653 },
    });
  });

  it("labels STEP-converted models honestly", () => {
    const result = buildAnnexure({
      fileName: "bracket.stl",
      thumbnailPng: null,
      model: {
        bboxXMm: 20,
        bboxYMm: 30,
        bboxZMm: 10,
        volumeCm3: 6,
        format: "stl",
        sourceFormat: "step",
        sizeBytes: 684,
      },
      slice: { filamentGrams: 5, filamentMm: 1500, printSeconds: 900, slicerVersion: null },
      settings: {
        material: "PLA",
        colour: "white",
        layerHeightUm: 200,
        infillPct: 15,
        supports: "auto",
        quantity: 1,
      },
      pricing: { materialPaise: 1, electricityPaise: 1, maintenancePaise: 1, subtotalPaise: 3 },
    });

    expect(result.geometry.format).toBe("step → stl");
  });

  it("tolerates null slicer metadata and missing thumbnail", () => {
    const result = buildAnnexure({
      fileName: "case.3mf",
      thumbnailPng: null,
      model: { bboxXMm: 1, bboxYMm: 2, bboxZMm: 3, volumeCm3: 4, format: "3mf", sizeBytes: 10 },
      slice: { filamentGrams: dec("5"), filamentMm: null, printSeconds: null, slicerVersion: null },
      settings: {
        material: "PLA",
        colour: "white",
        layerHeightUm: 120,
        infillPct: 40,
        supports: "off",
        quantity: 3,
      },
      pricing: { materialPaise: 1, electricityPaise: 2, maintenancePaise: 3, subtotalPaise: 6 },
    });
    expect(result.thumbnailPng).toBeNull();
    expect(result.slicer).toEqual({
      filamentGrams: 5,
      filamentMm: 0,
      printSeconds: 0,
      slicerVersion: null,
    });
  });
});
