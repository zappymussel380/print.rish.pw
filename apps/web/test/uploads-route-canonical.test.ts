import { createHash } from "node:crypto";
import { readFile, rm, mkdir, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isZip, parseModel } from "@print/geometry";

const MODEL_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  state: { dir: "" },
  create: vi.fn(),
  update: vi.fn(),
  deleteRow: vi.fn(),
  count: vi.fn(),
  aggregate: vi.fn(),
  reserveStorageBytes: vi.fn(),
  releaseStorageReservation: vi.fn(),
  withRedisLock: vi.fn(),
  moveIntoPlace: vi.fn(),
}));

vi.mock("@print/db", () => ({
  Prisma: {},
  prisma: {
    uploadedModel: {
      create: mocks.create,
      update: mocks.update,
      delete: mocks.deleteRow,
      count: mocks.count,
      aggregate: mocks.aggregate,
    },
  },
}));

vi.mock("@/lib/env", () => ({
  env: {
    maxUploadBytes: 300 * 1024 * 1024,
    maxUploadMb: 300,
    maxSessionUploadBytes: 900 * 1024 * 1024,
    uploadWindowBytes: 900 * 1024 * 1024,
    storageReserveBytes: 2 * 1024 * 1024 * 1024,
    maxModelsPerSession: 20,
  },
}));

vi.mock("@/lib/security", () => ({
  RATE_LIMITS: { upload: { max: 20, windowSeconds: 600 } },
  assertSameOrigin: vi.fn(() => true),
  clientIp: vi.fn(() => "127.0.0.1"),
  rateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  rateLimitBytes: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  reserveStorageBytes: mocks.reserveStorageBytes,
  releaseStorageReservation: mocks.releaseStorageReservation,
  withRedisLock: mocks.withRedisLock,
}));

vi.mock("@/lib/session", () => ({
  getOrCreateQuoteSessionId: vi.fn(async () => "session-1"),
}));

vi.mock("@/lib/storage", () => ({
  availableStorageBytes: vi.fn(async () => 10 * 1024 * 1024 * 1024),
  ensureStorageDirs: vi.fn(async () => {
    await mkdir(join(mocks.state.dir, "tmp"), { recursive: true });
    await mkdir(join(mocks.state.dir, "thumbs"), { recursive: true });
  }),
  hasStorageHeadroom: vi.fn(async () => true),
  modelPath: vi.fn((id: string, format: string) => join(mocks.state.dir, `${id}.${format}`)),
  moveIntoPlace: mocks.moveIntoPlace,
  removeQuietly: vi.fn(async (path: string | null | undefined) => {
    if (path) await rm(path, { force: true, recursive: true });
  }),
  thumbPath: vi.fn((id: string) => join(mocks.state.dir, "thumbs", `${id}.png`)),
  tmpUploadPath: vi.fn(() => join(mocks.state.dir, "tmp", crypto.randomUUID())),
}));

const { POST } = await import("@/app/api/uploads/route");

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.state.dir = await mkdtemp(join(tmpdir(), "print-upload-test-"));
  await mkdir(join(mocks.state.dir, "tmp"), { recursive: true });
  mocks.create.mockResolvedValue({ id: MODEL_ID });
  mocks.update.mockResolvedValue(undefined);
  mocks.deleteRow.mockResolvedValue(undefined);
  mocks.count.mockResolvedValue(0);
  mocks.aggregate.mockResolvedValue({ _sum: { sizeBytes: 0 } });
  mocks.reserveStorageBytes.mockResolvedValue("reservation");
  mocks.releaseStorageReservation.mockResolvedValue(undefined);
  mocks.withRedisLock.mockImplementation(
    async (_name: string, action: () => Promise<unknown>) => action(),
  );
  mocks.moveIntoPlace.mockImplementation(async (source: string, destination: string) => {
    await rename(source, destination);
  });
});

afterEach(async () => {
  if (mocks.state.dir) await rm(mocks.state.dir, { recursive: true, force: true });
});

describe("POST /api/uploads archive persistence", () => {
  it("stores a 3MF as final canonical STL bytes with matching DB identity", async () => {
    const archive = await readFile(
      join(process.cwd(), "..", "..", "packages", "geometry", "fixtures", "cube.3mf"),
    );
    const form = new FormData();
    form.append("file", new Blob([archive]), "customer-cube.3mf");
    const request = new Request("http://localhost/api/uploads", { method: "POST", body: form });

    const response = await POST(request as never);

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.model).toMatchObject({
      id: MODEL_ID,
      originalName: "customer-cube.stl",
      format: "stl",
    });
    const createData = mocks.create.mock.calls[0]![0].data;
    expect(createData).toMatchObject({
      originalName: "customer-cube.stl",
      format: "stl",
    });

    const storedPath = join(mocks.state.dir, `${MODEL_ID}.stl`);
    const stored = await readFile(storedPath);
    expect(isZip(stored)).toBe(false);
    expect(parseModel(stored, "stl").bboxMm).toEqual({ x: 20, y: 20, z: 20 });
    expect(createData.sizeBytes).toBe(stored.length);
    expect(createData.fileHash).toBe(createHash("sha256").update(stored).digest("hex"));
    expect(createData.fileHash).not.toBe(createHash("sha256").update(archive).digest("hex"));
    expect(mocks.moveIntoPlace).not.toHaveBeenCalled();
  });
});
