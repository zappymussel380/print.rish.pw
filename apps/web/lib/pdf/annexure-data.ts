import type { MaterialId, SupportMode } from "@print/shared";
import type { PdfAnnexure } from "./quotation-pdf";

/** Prisma returns Decimal columns; Number() coerces those and plain numbers
 *  alike. Used by both the checkout route and admin PDF regeneration so the
 *  annexure page never sees a Decimal. */
const num = (value: unknown): number => (value == null ? 0 : Number(value));

export interface AnnexureInput {
  fileName: string;
  thumbnailPng: Buffer | null;
  model: {
    bboxXMm: unknown;
    bboxYMm: unknown;
    bboxZMm: unknown;
    volumeCm3: unknown;
    format: string;
    sizeBytes: number;
  };
  slice: {
    filamentGrams: unknown;
    filamentMm: unknown;
    printSeconds: number | null;
    slicerVersion: string | null;
  };
  settings: {
    material: MaterialId;
    colour: string;
    layerHeightUm: number;
    infillPct: number;
    supports: SupportMode;
    quantity: number;
  };
  pricing: {
    materialPaise: number;
    electricityPaise: number;
    maintenancePaise: number;
    subtotalPaise: number;
  };
}

export function buildAnnexure(input: AnnexureInput): PdfAnnexure {
  return {
    fileName: input.fileName,
    thumbnailPng: input.thumbnailPng,
    geometry: {
      bboxXMm: num(input.model.bboxXMm),
      bboxYMm: num(input.model.bboxYMm),
      bboxZMm: num(input.model.bboxZMm),
      volumeCm3: num(input.model.volumeCm3),
      format: input.model.format,
      sizeBytes: input.model.sizeBytes,
    },
    settings: { ...input.settings },
    slicer: {
      filamentGrams: num(input.slice.filamentGrams),
      filamentMm: num(input.slice.filamentMm),
      printSeconds: input.slice.printSeconds ?? 0,
      slicerVersion: input.slice.slicerVersion,
    },
    pricing: { ...input.pricing },
  };
}
