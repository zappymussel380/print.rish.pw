import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prisma } from "@print/db";
import pino from "pino";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  assertSameDatabaseEndpoint,
  integrationConnection,
} from "./support/connections";

const DAY_MS = 86_400_000;

const webConnection = integrationConnection("DATABASE_URL", "print_web");
const workerConnection = integrationConnection("WORKER_DATABASE_URL", "print_worker");
const ownerConnection = integrationConnection("MIGRATION_DATABASE_URL", "print_owner");
assertSameDatabaseEndpoint(webConnection, workerConnection, ownerConnection);

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalUploadDir = process.env.UPLOAD_DIR;
const originalPdfDir = process.env.PDF_DIR;
const originalFileRetentionDays = process.env.FILE_RETENTION_DAYS;
const originalQuotationRetentionDays = process.env.QUOTATION_RETENTION_DAYS;
const storageRoot = await mkdtemp(join(tmpdir(), "print-quotation-retention-"));
const uploadDir = join(storageRoot, "uploads");
const pdfDir = join(storageRoot, "pdfs");

process.env.DATABASE_URL = workerConnection.url;
process.env.UPLOAD_DIR = uploadDir;
process.env.PDF_DIR = pdfDir;
// Keep the older model-file sweep out of this test's way so the filesystem
// assertions exercise quotation deletion itself.
process.env.FILE_RETENTION_DAYS = "365";
// An operator cannot extend retention beyond the public 90-day promise.
// Supplying a larger value exercises the production cap.
process.env.QUOTATION_RETENTION_DAYS = "365";
await mkdir(join(uploadDir, "thumbs"), { recursive: true });
await mkdir(pdfDir, { recursive: true });

// @print/db caches its development client on globalThis. Select the worker URL
// before importing the production sweep and make the role under test explicit.
delete (globalThis as { prisma?: unknown }).prisma;
const { PrismaClient, prisma: workerPrisma } = await import("@print/db");
const webPrisma = new PrismaClient({ datasourceUrl: webConnection.url });
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerConnection.url });
const { runRetention } = await import("../../worker/src/retention.js");

const fixtureSuffix = Date.now();
const agedQuotationId = randomUUID();
const agedDeliveredQuotationId = randomUUID();
const agedCancelledQuotationId = randomUUID();
const freshQuotationId = randomUUID();
const activeQuotationId = randomUUID();
const agedQuotationNumber = `RSP-2097-${fixtureSuffix}1`;
const agedDeliveredQuotationNumber = `RSP-2097-${fixtureSuffix}2`;
const agedCancelledQuotationNumber = `RSP-2097-${fixtureSuffix}3`;
const freshQuotationNumber = `RSP-2097-${fixtureSuffix}4`;
const activeQuotationNumber = `RSP-2097-${fixtureSuffix}5`;
const agedHistoryId = randomUUID();
const exclusiveModelId = randomUUID();
const sharedModelId = randomUUID();
const activeModelId = randomUUID();
const exclusiveSliceId = randomUUID();
const sharedSliceId = randomUUID();
const activeSliceId = randomUUID();

const exclusiveModelPath = join(uploadDir, `${exclusiveModelId}.stl`);
const exclusiveThumbPath = join(uploadDir, "thumbs", `${exclusiveModelId}.png`);
const sharedModelPath = join(uploadDir, `${sharedModelId}.stl`);
const sharedThumbPath = join(uploadDir, "thumbs", `${sharedModelId}.png`);
const activeModelPath = join(uploadDir, `${activeModelId}.stl`);
const activeThumbPath = join(uploadDir, "thumbs", `${activeModelId}.png`);
const agedPdfPath = join(pdfDir, `${agedQuotationNumber}.pdf`);
const freshPdfPath = join(pdfDir, `${freshQuotationNumber}.pdf`);
const activePdfPath = join(pdfDir, `${activeQuotationNumber}.pdf`);

function verifier(): string {
  return `sha256:${createHash("sha256").update(randomUUID()).digest("hex")}`;
}

async function removeFixtureRows(): Promise<void> {
  await ownerPrisma.quotation.deleteMany({
    where: {
      id: {
        in: [
          agedQuotationId,
          agedDeliveredQuotationId,
          agedCancelledQuotationId,
          freshQuotationId,
          activeQuotationId,
        ],
      },
    },
  });
  await ownerPrisma.uploadedModel.deleteMany({
    where: { id: { in: [exclusiveModelId, sharedModelId, activeModelId] } },
  });
  await ownerPrisma.sliceResult.deleteMany({
    where: { id: { in: [exclusiveSliceId, sharedSliceId, activeSliceId] } },
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(removeFixtureRows);

afterAll(async () => {
  await Promise.all([
    workerPrisma.$disconnect(),
    webPrisma.$disconnect(),
    ownerPrisma.$disconnect(),
  ]);
  delete (globalThis as { prisma?: unknown }).prisma;
  await rm(storageRoot, { recursive: true, force: true });
  restoreEnv("DATABASE_URL", originalDatabaseUrl);
  restoreEnv("UPLOAD_DIR", originalUploadDir);
  restoreEnv("PDF_DIR", originalPdfDir);
  restoreEnv("FILE_RETENTION_DAYS", originalFileRetentionDays);
  restoreEnv("QUOTATION_RETENTION_DAYS", originalQuotationRetentionDays);
});

describe("quotation PII retention against real services", () => {
  it("deletes aged terminal data but preserves fresh, active, and shared records", async () => {
    await removeFixtureRows();

    const agedAt = new Date(Date.now() - 91 * DAY_MS);
    const freshAt = new Date(Date.now() - 89 * DAY_MS);
    const exclusiveContents = "aged-exclusive-model";
    const sharedContents = "shared-model";
    const activeContents = "active-model";

    await Promise.all([
      writeFile(exclusiveModelPath, exclusiveContents),
      writeFile(exclusiveThumbPath, "aged-exclusive-thumb"),
      writeFile(sharedModelPath, sharedContents),
      writeFile(sharedThumbPath, "shared-thumb"),
      writeFile(activeModelPath, activeContents),
      writeFile(activeThumbPath, "active-thumb"),
      writeFile(agedPdfPath, "aged-terminal-pdf"),
      writeFile(freshPdfPath, "fresh-terminal-pdf"),
      writeFile(activePdfPath, "aged-active-pdf"),
    ]);

    await webPrisma.uploadedModel.createMany({
      data: [
        {
          id: exclusiveModelId,
          sessionId: randomUUID(),
          originalName: "aged-exclusive.stl",
          storedPath: exclusiveModelPath,
          fileHash: createHash("sha256").update(exclusiveContents).digest("hex"),
          sizeBytes: exclusiveContents.length,
          format: "stl",
          thumbPath: exclusiveThumbPath,
        },
        {
          id: sharedModelId,
          sessionId: randomUUID(),
          originalName: "shared.stl",
          storedPath: sharedModelPath,
          fileHash: createHash("sha256").update(sharedContents).digest("hex"),
          sizeBytes: sharedContents.length,
          format: "stl",
          thumbPath: sharedThumbPath,
        },
        {
          id: activeModelId,
          sessionId: randomUUID(),
          originalName: "active.stl",
          storedPath: activeModelPath,
          fileHash: createHash("sha256").update(activeContents).digest("hex"),
          sizeBytes: activeContents.length,
          format: "stl",
          thumbPath: activeThumbPath,
        },
      ] satisfies Prisma.UploadedModelCreateManyInput[],
    });

    await webPrisma.sliceResult.createMany({
      data: [
        {
          id: exclusiveSliceId,
          fileHash: createHash("sha256").update(exclusiveContents).digest("hex"),
          settingsKey: `quotation-retention:${randomUUID()}`,
          settingsJson: {},
          slicerVersion: "integration-test",
        },
        {
          id: sharedSliceId,
          fileHash: createHash("sha256").update(sharedContents).digest("hex"),
          settingsKey: `quotation-retention:${randomUUID()}`,
          settingsJson: {},
          slicerVersion: "integration-test",
        },
        {
          id: activeSliceId,
          fileHash: createHash("sha256").update(activeContents).digest("hex"),
          settingsKey: `quotation-retention:${randomUUID()}`,
          settingsJson: {},
          slicerVersion: "integration-test",
        },
      ] satisfies Prisma.SliceResultCreateManyInput[],
    });

    await webPrisma.quotation.createMany({
      data: [
        {
          id: agedQuotationId,
          number: agedQuotationNumber,
          status: "COMPLETED",
          customerName: "Delete Me",
          customerEmail: "delete-me@example.invalid",
          customerPhone: "0000000001",
          customerCity: "Test",
          setupFeePaise: 0,
          totalPaise: 100,
          pricingSnapshot: {},
          pdfPath: agedPdfPath,
          accessToken: verifier(),
          accessTokenExpiresAt: agedAt,
          createdAt: agedAt,
          updatedAt: agedAt,
        },
        {
          id: freshQuotationId,
          number: freshQuotationNumber,
          status: "DELIVERED",
          customerName: "Keep Fresh",
          customerEmail: "keep-fresh@example.invalid",
          customerPhone: "0000000002",
          customerCity: "Test",
          setupFeePaise: 0,
          totalPaise: 100,
          pricingSnapshot: {},
          pdfPath: freshPdfPath,
          accessToken: verifier(),
          accessTokenExpiresAt: freshAt,
          createdAt: freshAt,
          updatedAt: freshAt,
        },
        {
          id: agedDeliveredQuotationId,
          number: agedDeliveredQuotationNumber,
          status: "DELIVERED",
          customerName: "Delete Delivered",
          customerEmail: "delete-delivered@example.invalid",
          customerPhone: "0000000004",
          customerCity: "Test",
          setupFeePaise: 0,
          totalPaise: 100,
          pricingSnapshot: {},
          accessToken: verifier(),
          accessTokenExpiresAt: agedAt,
          createdAt: agedAt,
          updatedAt: agedAt,
        },
        {
          id: agedCancelledQuotationId,
          number: agedCancelledQuotationNumber,
          status: "CANCELLED",
          customerName: "Delete Cancelled",
          customerEmail: "delete-cancelled@example.invalid",
          customerPhone: "0000000005",
          customerCity: "Test",
          setupFeePaise: 0,
          totalPaise: 100,
          pricingSnapshot: {},
          accessToken: verifier(),
          accessTokenExpiresAt: agedAt,
          createdAt: agedAt,
          updatedAt: agedAt,
        },
        {
          id: activeQuotationId,
          number: activeQuotationNumber,
          status: "PRINTING",
          customerName: "Keep Active",
          customerEmail: "keep-active@example.invalid",
          customerPhone: "0000000003",
          customerCity: "Test",
          setupFeePaise: 0,
          totalPaise: 100,
          pricingSnapshot: {},
          pdfPath: activePdfPath,
          accessToken: verifier(),
          accessTokenExpiresAt: agedAt,
          createdAt: agedAt,
          updatedAt: agedAt,
        },
      ] satisfies Prisma.QuotationCreateManyInput[],
    });

    await webPrisma.statusHistory.createMany({
      data: [
        {
          id: agedHistoryId,
          quotationId: agedQuotationId,
          toStatus: "COMPLETED",
          note: "aged terminal fixture",
          createdAt: agedAt,
        },
        {
          quotationId: freshQuotationId,
          toStatus: "DELIVERED",
          note: "fresh terminal fixture",
          createdAt: freshAt,
        },
        {
          quotationId: activeQuotationId,
          toStatus: "PRINTING",
          note: "aged active fixture",
          createdAt: agedAt,
        },
      ] satisfies Prisma.StatusHistoryCreateManyInput[],
    });

    const item = {
      material: "PLA",
      colour: "black",
      layerHeightUm: 200,
      infillPct: 20,
      supports: "OFF",
      quantity: 1,
      unitGrams: "1.000",
      unitPrintSeconds: 60,
      materialPaise: 10,
      electricityPaise: 10,
      maintenancePaise: 10,
      subtotalPaise: 30,
    } as const;
    await webPrisma.quotationItem.createMany({
      data: [
        {
          ...item,
          quotationId: agedQuotationId,
          modelId: exclusiveModelId,
          sliceResultId: exclusiveSliceId,
        },
        {
          ...item,
          quotationId: agedQuotationId,
          modelId: sharedModelId,
          sliceResultId: sharedSliceId,
        },
        {
          ...item,
          quotationId: freshQuotationId,
          modelId: sharedModelId,
          sliceResultId: sharedSliceId,
        },
        {
          ...item,
          quotationId: activeQuotationId,
          modelId: activeModelId,
          sliceResultId: activeSliceId,
        },
      ] satisfies Prisma.QuotationItemCreateManyInput[],
    });

    const [identity] = await workerPrisma.$queryRaw<{ role: string }[]>`
      SELECT current_user::text AS role
    `;
    expect(identity?.role).toBe(workerConnection.username);

    await runRetention(pino({ enabled: false }));

    await expect(
      webPrisma.quotation.findUnique({ where: { id: agedQuotationId } }),
    ).resolves.toBeNull();
    await expect(
      webPrisma.quotation.count({
        where: {
          id: { in: [agedDeliveredQuotationId, agedCancelledQuotationId] },
        },
      }),
    ).resolves.toBe(0);
    await expect(
      webPrisma.statusHistory.findUnique({ where: { id: agedHistoryId } }),
    ).resolves.toBeNull();
    await expect(
      webPrisma.quotationItem.count({ where: { quotationId: agedQuotationId } }),
    ).resolves.toBe(0);
    await expect(
      webPrisma.uploadedModel.findUnique({ where: { id: exclusiveModelId } }),
    ).resolves.toBeNull();
    await expect(access(agedPdfPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(exclusiveModelPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(exclusiveThumbPath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      webPrisma.quotation.findMany({
        where: { id: { in: [freshQuotationId, activeQuotationId] } },
        select: { id: true, status: true },
        orderBy: { id: "asc" },
      }),
    ).resolves.toEqual(
      [
        { id: freshQuotationId, status: "DELIVERED" },
        { id: activeQuotationId, status: "PRINTING" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    await expect(
      webPrisma.quotationItem.count({
        where: { quotationId: { in: [freshQuotationId, activeQuotationId] } },
      }),
    ).resolves.toBe(2);
    await expect(
      webPrisma.statusHistory.count({
        where: { quotationId: { in: [freshQuotationId, activeQuotationId] } },
      }),
    ).resolves.toBe(2);

    await expect(
      webPrisma.uploadedModel.findUnique({
        where: { id: sharedModelId },
        select: { id: true, items: { select: { quotationId: true } } },
      }),
    ).resolves.toEqual({ id: sharedModelId, items: [{ quotationId: freshQuotationId }] });
    await expect(readFile(sharedModelPath, "utf8")).resolves.toBe(sharedContents);
    await expect(readFile(sharedThumbPath, "utf8")).resolves.toBe("shared-thumb");
    await expect(readFile(activeModelPath, "utf8")).resolves.toBe(activeContents);
    await expect(readFile(activeThumbPath, "utf8")).resolves.toBe("active-thumb");
    await expect(readFile(freshPdfPath, "utf8")).resolves.toBe("fresh-terminal-pdf");
    await expect(readFile(activePdfPath, "utf8")).resolves.toBe("aged-active-pdf");
  });
});
