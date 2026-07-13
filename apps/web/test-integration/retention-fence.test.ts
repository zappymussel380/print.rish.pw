import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSameDatabaseEndpoint,
  integrationConnection,
} from "./support/connections";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const webConnection = integrationConnection("DATABASE_URL", "print_web");
const workerConnection = integrationConnection("WORKER_DATABASE_URL", "print_worker");
const ownerConnection = integrationConnection("MIGRATION_DATABASE_URL", "print_owner");
assertSameDatabaseEndpoint(webConnection, workerConnection, ownerConnection);

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalUploadDir = process.env.UPLOAD_DIR;
const originalPdfDir = process.env.PDF_DIR;
const storageRoot = await mkdtemp(join(tmpdir(), "print-retention-fence-"));
const uploadDir = join(storageRoot, "uploads");
process.env.UPLOAD_DIR = uploadDir;
process.env.PDF_DIR = join(storageRoot, "pdfs");
process.env.DATABASE_URL = workerConnection.url;
await mkdir(join(uploadDir, "thumbs"), { recursive: true });
await mkdir(process.env.PDF_DIR, { recursive: true });

// @print/db deliberately caches its development client on globalThis. Select
// the worker URL before importing the production sweep, and prevent a client
// left by another Vitest file from silently changing the role under test.
delete (globalThis as { prisma?: unknown }).prisma;
const { PrismaClient, prisma: workerPrisma } = await import("@print/db");
const webPrisma = new PrismaClient({ datasourceUrl: webConnection.url });
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerConnection.url });
const { runRetention } = await import("../../worker/src/retention.js");

const log = pino({ enabled: false });
const modelId = randomUUID();
const orphanModelId = randomUUID();
const sliceResultId = randomUUID();
const quotationId = randomUUID();
const modelPath = join(uploadDir, `${modelId}.stl`);
const thumbPath = join(uploadDir, "thumbs", `${modelId}.png`);
const orphanModelPath = join(uploadDir, `${orphanModelId}.stl`);
const orphanThumbPath = join(uploadDir, "thumbs", `${orphanModelId}.png`);

async function removeFixtureRows(): Promise<void> {
  await ownerPrisma.quotation.deleteMany({ where: { id: quotationId } });
  await ownerPrisma.uploadedModel.deleteMany({
    where: { id: { in: [modelId, orphanModelId] } },
  });
  await ownerPrisma.sliceResult.deleteMany({ where: { id: sliceResultId } });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await removeFixtureRows();
});

afterAll(async () => {
  await Promise.all([
    workerPrisma.$disconnect(),
    webPrisma.$disconnect(),
    ownerPrisma.$disconnect(),
  ]);
  delete (globalThis as { prisma?: unknown }).prisma;
  await rm(storageRoot, { recursive: true, force: true });
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = originalUploadDir;
  if (originalPdfDir === undefined) delete process.env.PDF_DIR;
  else process.env.PDF_DIR = originalPdfDir;
});

describe("worker retention real-database fence", () => {
  it("keeps a stale upload attached after the scan but before conditional deletion", async () => {
    await removeFixtureRows();
    await Promise.all([
      writeFile(modelPath, "retention-race-model"),
      writeFile(thumbPath, "retention-race-thumb"),
      writeFile(orphanModelPath, "retention-orphan-model"),
      writeFile(orphanThumbPath, "retention-orphan-thumb"),
    ]);

    const fileHash = createHash("sha256").update("retention-race-model").digest("hex");
    const orphanHash = createHash("sha256").update("retention-orphan-model").digest("hex");
    const staleCreatedAt = new Date(Date.now() - 7 * 86_400_000);
    await webPrisma.uploadedModel.createMany({
      data: [
        {
          id: modelId,
          sessionId: randomUUID(),
          originalName: "retention-race.stl",
          storedPath: modelPath,
          fileHash,
          sizeBytes: 20,
          format: "stl",
          thumbPath,
          createdAt: staleCreatedAt,
        },
        {
          id: orphanModelId,
          sessionId: randomUUID(),
          originalName: "retention-orphan.stl",
          storedPath: orphanModelPath,
          fileHash: orphanHash,
          sizeBytes: 22,
          format: "stl",
          thumbPath: orphanThumbPath,
          createdAt: staleCreatedAt,
        },
      ],
    });
    await webPrisma.sliceResult.create({
      data: {
        id: sliceResultId,
        fileHash,
        settingsKey: `retention-fence:${randomUUID()}`,
        settingsJson: {},
        slicerVersion: "integration-test",
      },
    });
    await webPrisma.quotation.create({
      data: {
        id: quotationId,
        number: `RSP-2098-${Date.now()}`,
        customerName: "Integration Test",
        customerEmail: "integration@example.invalid",
        customerPhone: "0000000000",
        customerCity: "Test",
        setupFeePaise: 0,
        totalPaise: 100,
        pricingSnapshot: {},
        accessToken: `sha256:${createHash("sha256").update(randomUUID()).digest("hex")}`,
        accessTokenExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    const [identity] = await workerPrisma.$queryRaw<{ role: string }[]>`
      SELECT current_user::text AS role
    `;
    expect(identity?.role).toBe(workerConnection.username);

    const enteredDelete = deferred();
    const releaseDelete = deferred();
    const realDeleteMany = workerPrisma.uploadedModel.deleteMany.bind(
      workerPrisma.uploadedModel,
    );
    let heldTarget = false;
    vi.spyOn(workerPrisma.uploadedModel, "deleteMany").mockImplementation(
      (async (args: Parameters<typeof realDeleteMany>[0]) => {
        const id = (args?.where as { id?: unknown } | undefined)?.id;
        if (!heldTarget && id === modelId) {
          heldTarget = true;
          enteredDelete.resolve();
          await releaseDelete.promise;
        }
        return realDeleteMany(args);
      }) as unknown as typeof workerPrisma.uploadedModel.deleteMany,
    );

    const sweep = runRetention(log);
    await Promise.race([
      enteredDelete.promise,
      sweep.then(() => {
        throw new Error("Retention completed without reaching the conditional-delete barrier");
      }),
    ]);

    try {
      await webPrisma.quotationItem.create({
        data: {
          quotationId,
          modelId,
          sliceResultId,
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
        },
      });
    } finally {
      releaseDelete.resolve();
    }

    await sweep;

    const model = await webPrisma.uploadedModel.findUnique({
      where: { id: modelId },
      select: { id: true, items: { select: { quotationId: true } } },
    });
    expect(model).toEqual({ id: modelId, items: [{ quotationId }] });
    await expect(readFile(modelPath, "utf8")).resolves.toBe("retention-race-model");
    await expect(readFile(thumbPath, "utf8")).resolves.toBe("retention-race-thumb");
    await expect(
      webPrisma.uploadedModel.findUnique({ where: { id: orphanModelId } }),
    ).resolves.toBeNull();
    await expect(access(orphanModelPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(orphanThumbPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
