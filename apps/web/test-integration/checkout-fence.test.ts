import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Prisma, PrismaClient, prisma } from "@print/db";
import { DEFAULT_MODEL_CONFIG, sliceArtifactKey } from "@print/shared";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { redis } from "@/lib/redis";
import {
  assertSameDatabaseEndpoint,
  integrationConnection,
} from "./support/connections";

const checkoutFixture = vi.hoisted(() => ({
  sessionId: "6a86537f-bbc4-45d8-b9b6-8f4c6efe62ec",
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    getQuoteSessionId: async () => checkoutFixture.sessionId,
  };
});

vi.mock("@/lib/pdf/quotation-pdf", () => ({
  renderQuotationPdf: vi.fn(async () => Buffer.from("%PDF-1.4\n%%EOF\n")),
}));

vi.mock("@/lib/telegram", () => ({
  notifyNewQuotation: vi.fn(async () => {}),
  sendOperatorAlert: vi.fn(async () => {}),
}));

const webConnection = integrationConnection("DATABASE_URL", "print_web");
const workerConnection = integrationConnection("WORKER_DATABASE_URL", "print_worker");
const ownerConnection = integrationConnection("MIGRATION_DATABASE_URL", "print_owner");
assertSameDatabaseEndpoint(webConnection, workerConnection, ownerConnection);

const workerPrisma = new PrismaClient({ datasourceUrl: workerConnection.url });
const ownerPrisma = new PrismaClient({ datasourceUrl: ownerConnection.url });
const modelId = randomUUID();
const sliceResultId = randomUUID();
const fileHash = randomBytes(32).toString("hex");
const sliceSettings = {
  material: DEFAULT_MODEL_CONFIG.material,
  layerHeightUm: DEFAULT_MODEL_CONFIG.layerHeightUm,
  infillPct: DEFAULT_MODEL_CONFIG.infillPct,
  supports: DEFAULT_MODEL_CONFIG.supports,
};
const settingsKey = sliceArtifactKey("stl", sliceSettings);

const originalUploadDir = process.env.UPLOAD_DIR;
const originalPdfDir = process.env.PDF_DIR;
let storageRoot = "";
let checkoutPost: typeof import("@/app/api/quotations/route").POST;

async function cleanupCheckoutRows(): Promise<void> {
  await ownerPrisma.quotation.deleteMany({
    where: { items: { some: { modelId } } },
  });
  await ownerPrisma.uploadedModel.deleteMany({ where: { id: modelId } });
  await ownerPrisma.sliceResult.deleteMany({ where: { id: sliceResultId } });
}

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "print-checkout-fence-"));
  process.env.UPLOAD_DIR = join(storageRoot, "uploads");
  process.env.PDF_DIR = join(storageRoot, "pdfs");
  ({ POST: checkoutPost } = await import("@/app/api/quotations/route"));

  await prisma.uploadedModel.create({
    data: {
      id: modelId,
      sessionId: checkoutFixture.sessionId,
      originalName: "checkout-fence.stl",
      storedPath: join(process.env.UPLOAD_DIR, `${modelId}.stl`),
      fileHash,
      sizeBytes: 684,
      format: "stl",
      bboxXMm: 20,
      bboxYMm: 20,
      bboxZMm: 20,
      volumeCm3: 8,
    },
  });

  // Match production privilege flow: web creates lifecycle/cache identity;
  // only the worker role may persist trusted slicer measurements.
  await prisma.sliceResult.create({
    data: {
      id: sliceResultId,
      attemptId: randomUUID(),
      fileHash,
      settingsKey,
      settingsJson: sliceSettings as Prisma.InputJsonValue,
      status: "QUEUED",
      slicerVersion: "",
    },
  });
  await workerPrisma.sliceResult.update({
    where: { id: sliceResultId },
    data: {
      status: "DONE",
      progressPct: 100,
      progressStage: "complete",
      progressMessage: "Slicing complete",
      filamentGrams: new Prisma.Decimal("12.500"),
      filamentMm: new Prisma.Decimal("4200.0"),
      printSeconds: 3600,
      supportGrams: new Prisma.Decimal("0.000"),
      slicerVersion: "integration-test",
      completedAt: new Date(),
    },
  });
});

afterAll(async () => {
  await cleanupCheckoutRows();
  await redis.del("rl:checkout:198.51.100.42", "rl:checkout-global:all");
  await Promise.all([
    prisma.$disconnect(),
    workerPrisma.$disconnect(),
    ownerPrisma.$disconnect(),
    redis.quit(),
  ]);
  delete (globalThis as { prisma?: unknown; redis?: unknown }).prisma;
  delete (globalThis as { prisma?: unknown; redis?: unknown }).redis;
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  if (originalUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = originalUploadDir;
  if (originalPdfDir === undefined) delete process.env.PDF_DIR;
  else process.env.PDF_DIR = originalPdfDir;
});

function checkoutRequest(): NextRequest {
  const origin = process.env.APP_ORIGIN ?? "http://localhost:3000";
  return new NextRequest(`${origin}/api/quotations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
      "x-real-ip": "198.51.100.42",
    },
    body: JSON.stringify({
      customer: {
        name: "Checkout Fence",
        email: "checkout-fence@example.com",
        phone: "+919876543210",
        city: "Guwahati",
        notes: "",
      },
      items: [{ modelId, config: DEFAULT_MODEL_CONFIG }],
    }),
  });
}

describe("checkout single-use database fence", () => {
  it("allows exactly one of two concurrent requests to claim a model", async () => {
    const originalFindFirst = prisma.uploadedModel.findFirst.bind(prisma.uploadedModel);
    let observedReads = 0;
    let releaseReads: (() => void) | undefined;
    let rejectReads: ((error: Error) => void) | undefined;
    const bothReads = new Promise<void>((resolve, reject) => {
      releaseReads = resolve;
      rejectReads = reject;
    });
    const barrierTimeout = setTimeout(() => {
      rejectReads?.(new Error("Both checkout requests did not reach the claim barrier"));
    }, 5_000);

    const findFirstSpy = vi.spyOn(prisma.uploadedModel, "findFirst");
    findFirstSpy.mockImplementation(
      (async (args: Parameters<typeof originalFindFirst>[0]) => {
        const model = await originalFindFirst(args);
        if (model?.id === modelId) {
          expect(model.submittedAt).toBeNull();
          observedReads += 1;
          if (observedReads === 2) {
            clearTimeout(barrierTimeout);
            releaseReads?.();
          }
          await bothReads;
        }
        return model;
      }) as unknown as typeof prisma.uploadedModel.findFirst,
    );

    let responses: [Response, Response];
    try {
      responses = await Promise.all([
        checkoutPost(checkoutRequest()),
        checkoutPost(checkoutRequest()),
      ]);
    } finally {
      clearTimeout(barrierTimeout);
      findFirstSpy.mockRestore();
    }

    expect(observedReads).toBe(2);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const conflict = responses.find((response) => response.status === 409)!;
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "MODEL_ALREADY_SUBMITTED" },
    });

    await expect(
      prisma.quotation.count({ where: { items: { some: { modelId } } } }),
    ).resolves.toBe(1);
    await expect(prisma.quotationItem.count({ where: { modelId } })).resolves.toBe(1);
    await expect(
      prisma.statusHistory.count({
        where: { quotation: { items: { some: { modelId } } } },
      }),
    ).resolves.toBe(1);

    const claimedModel = await prisma.uploadedModel.findUnique({
      where: { id: modelId },
      select: { submittedAt: true },
    });
    expect(claimedModel?.submittedAt).toBeInstanceOf(Date);
  });
});
