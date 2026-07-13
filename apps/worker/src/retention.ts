import { lstat, opendir, rm as removeTree, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import { prisma } from "@print/db";
import { UUID_PATTERN } from "@print/shared";
import { config } from "./config.js";

async function rm(path: string | null | undefined): Promise<void> {
  if (!path) return;
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

const UUID_FILE_RE = new RegExp(`^${UUID_PATTERN}\\.(?:stl|3mf|obj|amf)$`, "i");
const UUID_THUMB_RE = new RegExp(`^${UUID_PATTERN}\\.png$`, "i");
const PDF_RE = /^RSP-\d{4}-\d{4,}\.pdf$/;
const ORPHAN_GRACE_MS = 2 * 60 * 60 * 1000;
const FORMATS = new Set(["stl", "3mf", "obj", "amf"]);

function expectedModelPath(model: { id: string; format: string }): string | null {
  return FORMATS.has(model.format)
    ? resolve(config.uploadDir, `${model.id}.${model.format}`)
    : null;
}

function expectedThumbPath(modelId: string): string {
  return resolve(config.uploadDir, "thumbs", `${modelId}.png`);
}

function expectedPdfPath(quotationNumber: string): string | null {
  const filename = `${quotationNumber}.pdf`;
  return PDF_RE.test(filename) ? resolve(config.pdfDir, filename) : null;
}

async function cleanOrphanFiles(
  directory: string,
  namePattern: RegExp,
  cutoff: number,
  resolveKeep: (candidates: { name: string; path: string }[]) => Promise<Set<string>>,
): Promise<number> {
  let removed = 0;
  let batch: { name: string; path: string }[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const candidates = batch;
    batch = [];
    const keep = await resolveKeep(candidates);
    for (const candidate of candidates) {
      if (keep.has(candidate.path)) continue;
      try {
        await unlink(candidate.path);
        removed += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  };

  let dir;
  try {
    dir = await opendir(directory);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  for await (const entry of dir) {
    if (!namePattern.test(entry.name)) continue;
    const path = resolve(directory, entry.name);
    try {
      const info = await lstat(path);
      if (info.mtimeMs >= cutoff) continue;
      batch.push({ name: entry.name, path });
      if (batch.length >= 500) await flush();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  await flush();
  return removed;
}

async function reconcileOrphans(now: number): Promise<number> {
  const cutoff = now - ORPHAN_GRACE_MS;
  let removed = 0;
  removed += await cleanOrphanFiles(
    resolve(config.uploadDir),
    UUID_FILE_RE,
    cutoff,
    async (candidates) => {
      const ids = candidates.map((candidate) => candidate.name.slice(0, 36));
      const models = await prisma.uploadedModel.findMany({
        where: { id: { in: ids } },
        select: { id: true, format: true, storedPath: true },
      });
      return new Set(
        models
          .filter((model) => {
            const expected = expectedModelPath(model);
            return expected && model.storedPath && resolve(model.storedPath) === expected;
          })
          .map((model) => expectedModelPath(model)!),
      );
    },
  );
  removed += await cleanOrphanFiles(
    resolve(config.uploadDir, "thumbs"),
    UUID_THUMB_RE,
    cutoff,
    async (candidates) => {
      const ids = candidates.map((candidate) => candidate.name.slice(0, 36));
      const models = await prisma.uploadedModel.findMany({
        where: { id: { in: ids } },
        select: { id: true, thumbPath: true },
      });
      return new Set(
        models
          .filter(
            (model) =>
              model.thumbPath && resolve(model.thumbPath) === expectedThumbPath(model.id),
          )
          .map((model) => expectedThumbPath(model.id)),
      );
    },
  );
  removed += await cleanOrphanFiles(
    resolve(config.pdfDir),
    PDF_RE,
    cutoff,
    async (candidates) => {
      const numbers = candidates.map((candidate) => candidate.name.slice(0, -4));
      const quotations = await prisma.quotation.findMany({
        where: { number: { in: numbers } },
        select: { number: true, pdfPath: true },
      });
      return new Set(
        quotations
          .filter(
            (quotation) =>
              quotation.pdfPath &&
              resolve(quotation.pdfPath) === resolve(config.pdfDir, `${quotation.number}.pdf`),
          )
          .map((quotation) => resolve(config.pdfDir, `${quotation.number}.pdf`)),
      );
    },
  );

  // Temp files have no DB row by design. An accepted ingest ticket owns its
  // file until terminal worker cleanup; the bounded FIFO should transit far
  // inside this two-hour grace, while producer/worker crash leftovers age out.
  const tmpDir = resolve(config.uploadDir, "tmp");
  try {
    const dir = await opendir(tmpDir);
    for await (const entry of dir) {
      const path = join(tmpDir, entry.name);
      try {
        if ((await lstat(path)).mtimeMs >= cutoff) continue;
        await removeTree(path, { recursive: true, force: true });
        removed += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return removed;
}

/**
 * Data-retention sweep (runs daily):
 *  1. Delete uploads that were never attached to a quotation once they exceed
 *     UPLOAD_RETENTION_HOURS — files, thumbnails and DB rows.
 *  2. Remove the model files of quotations in a terminal state older than
 *     FILE_RETENTION_DAYS, keeping the DB rows and PDFs for the record.
 *  3. Delete terminal quotations and their customer data once they exceed
 *     QUOTATION_RETENTION_DAYS, then remove their unreferenced storage.
 */
export async function runRetention(log: Logger): Promise<void> {
  const now = Date.now();

  const uploadCutoff = new Date(now - config.uploadRetentionHours * 3600_000);
  let deletedUploads = 0;
  let afterUploadId: string | undefined;
  while (true) {
    const staleUploads = await prisma.uploadedModel.findMany({
      where: {
        createdAt: { lt: uploadCutoff },
        items: { none: {} },
        ...(afterUploadId ? { id: { gt: afterUploadId } } : {}),
      },
      orderBy: { id: "asc" },
      take: 250,
    });
    if (staleUploads.length === 0) break;
    afterUploadId = staleUploads.at(-1)!.id;
    for (const model of staleUploads) {
      // Atomically re-check that checkout has not attached the model since the
      // snapshot above. Delete the row first, then unlink only after we own it.
      const { count } = await prisma.uploadedModel.deleteMany({
        where: { id: model.id, createdAt: { lt: uploadCutoff }, items: { none: {} } },
      });
      if (count === 0) continue;
      try {
        await rm(expectedModelPath(model));
        await rm(expectedThumbPath(model.id));
      } catch (err) {
        log.error(
          { modelId: model.id, err: String(err) },
          "stale upload cleanup failed; orphan reconciliation will retry",
        );
      }
      deletedUploads += 1;
    }
  }

  const fileCutoff = new Date(now - config.fileRetentionDays * 86_400_000);
  let purgedFiles = 0;
  let afterQuotationId: string | undefined;
  while (true) {
    const terminal = await prisma.quotation.findMany({
      where: {
        status: { in: ["COMPLETED", "DELIVERED", "CANCELLED"] },
        updatedAt: { lt: fileCutoff },
        ...(afterQuotationId ? { id: { gt: afterQuotationId } } : {}),
      },
      include: { items: { select: { modelId: true } } },
      orderBy: { id: "asc" },
      take: 200,
    });
    if (terminal.length === 0) break;
    afterQuotationId = terminal.at(-1)!.id;
    const modelIds = new Set<string>();
    for (const quotation of terminal) {
      for (const item of quotation.items) modelIds.add(item.modelId);
    }

    for (const modelId of modelIds) {
      const model = await prisma.uploadedModel.findUnique({ where: { id: modelId } });
      if (!model?.storedPath) continue;

      // Legacy data may share a model across quotations. Retain it while any
      // reference is non-terminal or still inside its retention period.
      const protectedReferences = await prisma.quotationItem.count({
        where: {
          modelId,
          quotation: {
            OR: [
              { status: { notIn: ["COMPLETED", "DELIVERED", "CANCELLED"] } },
              { updatedAt: { gte: fileCutoff } },
            ],
          },
        },
      });
      if (protectedReferences > 0) continue;

      const { count } = await prisma.uploadedModel.updateMany({
        // Terminal statuses are immutable in the admin API. Reassert all
        // references and their age in the same statement that clears paths.
        where: {
          id: modelId,
          items: {
            every: {
              quotation: {
                status: { in: ["COMPLETED", "DELIVERED", "CANCELLED"] },
                updatedAt: { lt: fileCutoff },
              },
            },
          },
        },
        data: { storedPath: "", thumbPath: null },
      });
      if (count === 0) continue;
      try {
        await rm(expectedModelPath(model));
        await rm(expectedThumbPath(model.id));
      } catch (err) {
        log.error(
          { modelId, err: String(err) },
          "retained model cleanup failed; orphan reconciliation will retry",
        );
      }
      purgedFiles += 1;
    }
  }

  const quotationCutoff = new Date(
    now - config.quotationRetentionDays * 86_400_000,
  );
  let deletedQuotations = 0;
  let deletedQuotationModels = 0;
  let afterExpiredQuotationId: string | undefined;
  while (true) {
    const expired = await prisma.quotation.findMany({
      where: {
        status: { in: ["COMPLETED", "DELIVERED", "CANCELLED"] },
        updatedAt: { lt: quotationCutoff },
        ...(afterExpiredQuotationId ? { id: { gt: afterExpiredQuotationId } } : {}),
      },
      include: { items: { select: { modelId: true } } },
      orderBy: { id: "asc" },
      take: 200,
    });
    if (expired.length === 0) break;
    afterExpiredQuotationId = expired.at(-1)!.id;

    for (const quotation of expired) {
      const modelIds = [...new Set(quotation.items.map((item) => item.modelId))];

      // Reassert the terminal state and age while claiming the destructive
      // action. A concurrent manual delete wins with count=0; no files are
      // touched unless this sweep deleted the quotation row and its cascades.
      const { count } = await prisma.quotation.deleteMany({
        where: {
          id: quotation.id,
          status: { in: ["COMPLETED", "DELIVERED", "CANCELLED"] },
          updatedAt: { lt: quotationCutoff },
        },
      });
      if (count === 0) continue;
      deletedQuotations += 1;

      try {
        await rm(expectedPdfPath(quotation.number));
      } catch (err) {
        log.error(
          { quotationId: quotation.id, err: String(err) },
          "expired quotation PDF cleanup failed; orphan reconciliation will retry",
        );
      }

      for (const modelId of modelIds) {
        const model = await prisma.uploadedModel.findUnique({ where: { id: modelId } });
        if (!model) continue;

        // A model shared with another quotation remains durable. Claim the
        // orphan atomically before unlinking so a concurrent attachment wins.
        const { count: deletedModels } = await prisma.uploadedModel.deleteMany({
          where: { id: modelId, items: { none: {} } },
        });
        if (deletedModels === 0) continue;
        deletedQuotationModels += 1;
        try {
          await rm(expectedModelPath(model));
          await rm(expectedThumbPath(model.id));
        } catch (err) {
          log.error(
            { quotationId: quotation.id, modelId, err: String(err) },
            "expired quotation model cleanup failed; orphan reconciliation will retry",
          );
        }
      }
    }
  }

  const orphanFiles = await reconcileOrphans(now);

  log.info(
    {
      staleUploads: deletedUploads,
      purgedFiles,
      deletedQuotations,
      deletedQuotationModels,
      orphanFiles,
    },
    "retention sweep complete",
  );
}
