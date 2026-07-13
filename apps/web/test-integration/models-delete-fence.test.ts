import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSameDatabaseEndpoint,
  integrationConnection,
} from "./support/connections";

const modelDeleteFixture = vi.hoisted(() => ({
  sessionId: "8453a380-d97a-4c2c-9867-562b35f5028e",
}));

// Calling App Router handlers directly does not create Next's request-local
// cookie store. Keep only that request-context seam mocked; PostgreSQL, Redis,
// rate limiting, conditional deletes, and filesystem effects remain real.
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  getQuoteSessionId: async () => modelDeleteFixture.sessionId,
}));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const webConnection = integrationConnection("DATABASE_URL", "print_web");
const workerConnection = integrationConnection("WORKER_DATABASE_URL", "print_worker");
const ownerConnection = integrationConnection("MIGRATION_DATABASE_URL", "print_owner");
assertSameDatabaseEndpoint(webConnection, workerConnection, ownerConnection);

const originalUploadDir = process.env.UPLOAD_DIR;
const originalPdfDir = process.env.PDF_DIR;
const storageRoot = await mkdtemp(join(tmpdir(), "print-model-delete-fence-"));
const uploadDir = join(storageRoot, "uploads");
process.env.UPLOAD_DIR = uploadDir;
process.env.PDF_DIR = join(storageRoot, "pdfs");
await mkdir(join(uploadDir, "thumbs"), { recursive: true });

const { PrismaClient, prisma } = await import("@print/db");
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerConnection.url });
const { redis } = await import("@/lib/redis");
const { DELETE } = await import("@/app/api/models/route");

const sessionId = modelDeleteFixture.sessionId;
const racedModelId = randomUUID();
const keptModelId = randomUUID();
const orphanModelId = randomUUID();
const sliceResultId = randomUUID();
const quotationId = randomUUID();
const clientIp = "198.51.100.88";
const racedModelPath = join(uploadDir, `${racedModelId}.stl`);
const racedThumbPath = join(uploadDir, "thumbs", `${racedModelId}.png`);
const keptModelPath = join(uploadDir, `${keptModelId}.stl`);
const keptThumbPath = join(uploadDir, "thumbs", `${keptModelId}.png`);
const orphanModelPath = join(uploadDir, `${orphanModelId}.stl`);
const orphanThumbPath = join(uploadDir, "thumbs", `${orphanModelId}.png`);

async function removeFixtureRows(): Promise<void> {
  await ownerPrisma.quotation.deleteMany({ where: { id: quotationId } });
  await ownerPrisma.uploadedModel.deleteMany({
    where: { id: { in: [racedModelId, keptModelId, orphanModelId] } },
  });
  await ownerPrisma.sliceResult.deleteMany({ where: { id: sliceResultId } });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await removeFixtureRows();
  await redis.del(`rl:modelMutation:${clientIp}`);
});

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), ownerPrisma.$disconnect(), redis.quit()]);
  delete (globalThis as { prisma?: unknown; redis?: unknown }).prisma;
  delete (globalThis as { prisma?: unknown; redis?: unknown }).redis;
  await rm(storageRoot, { recursive: true, force: true });
  if (originalUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = originalUploadDir;
  if (originalPdfDir === undefined) delete process.env.PDF_DIR;
  else process.env.PDF_DIR = originalPdfDir;
});

describe("DELETE /api/models real-database fence", () => {
  it("preserves the keep list and a model attached after the stale snapshot", async () => {
    await removeFixtureRows();
    await Promise.all([
      writeFile(racedModelPath, "raced-model"),
      writeFile(racedThumbPath, "raced-thumb"),
      writeFile(keptModelPath, "kept-model"),
      writeFile(keptThumbPath, "kept-thumb"),
      writeFile(orphanModelPath, "orphan-model"),
      writeFile(orphanThumbPath, "orphan-thumb"),
    ]);

    const racedHash = createHash("sha256").update("raced-model").digest("hex");
    const keptHash = createHash("sha256").update("kept-model").digest("hex");
    const orphanHash = createHash("sha256").update("orphan-model").digest("hex");
    await ownerPrisma.uploadedModel.createMany({
      data: [
        {
          id: racedModelId,
          sessionId,
          originalName: "raced.stl",
          storedPath: racedModelPath,
          fileHash: racedHash,
          sizeBytes: 11,
          format: "stl",
          thumbPath: racedThumbPath,
        },
        {
          id: keptModelId,
          sessionId,
          originalName: "kept.stl",
          storedPath: keptModelPath,
          fileHash: keptHash,
          sizeBytes: 10,
          format: "stl",
          thumbPath: keptThumbPath,
        },
        {
          id: orphanModelId,
          sessionId,
          originalName: "orphan.stl",
          storedPath: orphanModelPath,
          fileHash: orphanHash,
          sizeBytes: 12,
          format: "stl",
          thumbPath: orphanThumbPath,
        },
      ],
    });
    await prisma.sliceResult.create({
      data: {
        id: sliceResultId,
        fileHash: racedHash,
        settingsKey: `models-delete-fence:${randomUUID()}`,
        settingsJson: {},
        slicerVersion: "integration-test",
      },
    });
    await prisma.quotation.create({
      data: {
        id: quotationId,
        number: `RSP-2099-${Date.now()}`,
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

    const enteredDelete = deferred();
    const releaseDelete = deferred();
    const realDeleteMany = prisma.uploadedModel.deleteMany.bind(prisma.uploadedModel);
    let heldFirstDelete = false;
    vi.spyOn(prisma.uploadedModel, "deleteMany").mockImplementation(
      (async (args: Parameters<typeof realDeleteMany>[0]) => {
        if (!heldFirstDelete) {
          heldFirstDelete = true;
          enteredDelete.resolve();
          await releaseDelete.promise;
        }
        return realDeleteMany(args);
      }) as unknown as typeof prisma.uploadedModel.deleteMany,
    );

    const origin = requiredEnv("APP_ORIGIN");
    const request = new NextRequest(`${origin}/api/models`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        origin,
        "sec-fetch-site": "same-origin",
        "x-real-ip": clientIp,
      },
      body: JSON.stringify({ keep: [keptModelId] }),
    });

    const deleteRequest = DELETE(request);
    await Promise.race([
      enteredDelete.promise,
      deleteRequest.then(() => {
        throw new Error("DELETE completed without reaching the conditional-delete barrier");
      }),
    ]);

    try {
      await prisma.quotationItem.create({
        data: {
          quotationId,
          modelId: racedModelId,
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

    const response = await deleteRequest;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ cleared: 1 });

    const models = await prisma.uploadedModel.findMany({
      where: { id: { in: [racedModelId, keptModelId, orphanModelId] } },
      select: { id: true, items: { select: { quotationId: true } } },
      orderBy: { id: "asc" },
    });
    expect(models).toHaveLength(2);
    expect(models.find((model) => model.id === racedModelId)?.items).toEqual([
      { quotationId },
    ]);
    expect(models.find((model) => model.id === keptModelId)?.items).toEqual([]);
    await expect(readFile(racedModelPath, "utf8")).resolves.toBe("raced-model");
    await expect(readFile(racedThumbPath, "utf8")).resolves.toBe("raced-thumb");
    await expect(readFile(keptModelPath, "utf8")).resolves.toBe("kept-model");
    await expect(readFile(keptThumbPath, "utf8")).resolves.toBe("kept-thumb");
    await expect(access(orphanModelPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(orphanThumbPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
