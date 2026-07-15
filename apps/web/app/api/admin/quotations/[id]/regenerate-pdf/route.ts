import { writeFile } from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@print/db";
import type { MaterialId, SupportMode } from "@print/shared";
import { jsonError, requireAdminApi } from "@/lib/api-util";
import { env } from "@/lib/env";
import { buildAnnexure } from "@/lib/pdf/annexure-data";
import { renderQuotationPdf } from "@/lib/pdf/quotation-pdf";
import { assertSameOrigin, withRedisLock } from "@/lib/security";
import {
  ensureStorageDirs,
  hasPdfStorageHeadroom,
  pdfPath,
  removeQuietly,
} from "@/lib/storage";
import { readThumbPng } from "@/lib/thumbs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** Rebuild a quotation's PDF from its frozen items — for quotations issued
 *  before a template change (or whose original render failed). Prices, specs
 *  and slicer stats come from the QuotationItem snapshot, so a regenerated
 *  document never drifts from what was quoted. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  const { id } = await ctx.params;

  const quotation = await prisma.quotation.findUnique({
    where: { id },
    include: { items: { include: { model: true, sliceResult: true } } },
  });
  if (!quotation) return jsonError(404, "NOT_FOUND", "Quotation not found");

  const lines = quotation.items.map((item) => ({
    fileName: item.model.originalName,
    material: item.material as MaterialId,
    colour: item.colour,
    layerHeightUm: item.layerHeightUm,
    infillPct: item.infillPct,
    supports: item.supports.toLowerCase() as SupportMode,
    quantity: item.quantity,
    totalGrams: Number(item.unitGrams) * item.quantity,
    totalPrintSeconds: item.unitPrintSeconds * item.quantity,
    subtotalPaise: item.subtotalPaise,
  }));

  const annexures = await Promise.all(
    quotation.items.map(async (item, i) =>
      buildAnnexure({
        fileName: item.model.originalName,
        thumbnailPng: await readThumbPng(item.model.id, item.model.fileHash, item.model.thumbPath),
        model: item.model,
        slice: item.sliceResult,
        settings: {
          material: lines[i]!.material,
          colour: item.colour,
          layerHeightUm: item.layerHeightUm,
          infillPct: item.infillPct,
          supports: lines[i]!.supports,
          quantity: item.quantity,
        },
        pricing: {
          materialPaise: item.materialPaise,
          electricityPaise: item.electricityPaise,
          maintenancePaise: item.maintenancePaise,
          subtotalPaise: item.subtotalPaise,
        },
      }),
    ),
  );

  try {
    await ensureStorageDirs();
    const pdf = await renderQuotationPdf({
      number: quotation.number,
      createdAt: quotation.createdAt,
      customer: {
        name: quotation.customerName,
        email: quotation.customerEmail,
        phone: quotation.customerPhone,
        city: quotation.customerCity,
        notes: quotation.notes,
      },
      lines,
      setupFeePaise: quotation.setupFeePaise,
      shippingPaise: quotation.shippingPaise,
      totalPaise: quotation.totalPaise,
      totalGrams: lines.reduce((sum, line) => sum + line.totalGrams, 0),
      totalPrintSeconds: lines.reduce((sum, line) => sum + line.totalPrintSeconds, 0),
      completion: quotation.estimatedCompletion,
      annexures,
    });
    if (pdf.length > MAX_PDF_BYTES) {
      throw new Error("Generated quotation PDF exceeds the size limit");
    }

    const path = pdfPath(quotation.number);
    const persisted = await withRedisLock(
      "pdf-write",
      async () => {
        if (!(await hasPdfStorageHeadroom(pdf.length + env.storageReserveBytes))) {
          throw new Error("Insufficient reserved capacity for quotation PDF");
        }
        // Replace, don't overwrite in place: wx keeps the invariant that a
        // stored PDF file is always complete.
        await removeQuietly(path);
        await writeFile(path, pdf, { flag: "wx", mode: 0o600 });
        try {
          await prisma.quotation.update({ where: { id }, data: { pdfPath: path } });
        } catch (err) {
          await removeQuietly(path).catch(() => {});
          throw err;
        }
      },
      { leaseMs: 30_000, waitMs: 10_000 },
    );
    if (persisted === null) {
      return jsonError(503, "PDF_BUSY", "PDF storage is busy. Try again shortly");
    }
    return NextResponse.json({ number: quotation.number, bytes: pdf.length });
  } catch {
    return jsonError(500, "PDF_REGENERATION_FAILED", "Could not regenerate the quotation PDF");
  }
}
