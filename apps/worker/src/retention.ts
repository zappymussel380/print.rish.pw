import { unlink } from "node:fs/promises";
import type { Logger } from "pino";
import { prisma } from "@print/db";
import { config } from "./config.js";

async function rm(path: string | null | undefined): Promise<void> {
  if (!path) return;
  try {
    await unlink(path);
  } catch {
    /* already gone */
  }
}

/**
 * Data-retention sweep (runs daily):
 *  1. Delete uploads that were never attached to a quotation once they exceed
 *     UPLOAD_RETENTION_HOURS — files, thumbnails and DB rows.
 *  2. Remove the model files of quotations in a terminal state older than
 *     FILE_RETENTION_DAYS, keeping the DB rows and PDFs for the record.
 */
export async function runRetention(log: Logger): Promise<void> {
  const now = Date.now();

  const uploadCutoff = new Date(now - config.uploadRetentionHours * 3600_000);
  const staleUploads = await prisma.uploadedModel.findMany({
    where: { createdAt: { lt: uploadCutoff }, items: { none: {} } },
  });
  for (const model of staleUploads) {
    await rm(model.storedPath);
    await rm(model.thumbPath);
    await prisma.uploadedModel.delete({ where: { id: model.id } });
  }

  const fileCutoff = new Date(now - config.fileRetentionDays * 86_400_000);
  const terminal = await prisma.quotation.findMany({
    where: {
      status: { in: ["COMPLETED", "DELIVERED", "CANCELLED"] },
      updatedAt: { lt: fileCutoff },
    },
    include: { items: { select: { modelId: true } } },
  });
  const modelIds = new Set<string>();
  for (const q of terminal) for (const item of q.items) modelIds.add(item.modelId);

  let purgedFiles = 0;
  for (const modelId of modelIds) {
    const model = await prisma.uploadedModel.findUnique({ where: { id: modelId } });
    if (model?.storedPath) {
      await rm(model.storedPath);
      purgedFiles += 1;
    }
  }

  log.info(
    { staleUploads: staleUploads.length, purgedFiles },
    "retention sweep complete",
  );
}
