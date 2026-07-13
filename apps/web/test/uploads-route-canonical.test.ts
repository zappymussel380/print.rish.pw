import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: { dir: "" },
  count: vi.fn(),
  reserveStorageBytes: vi.fn(),
  releaseStorageReservation: vi.fn(),
  reserveIngestAdmission: vi.fn(),
  releaseIngestAdmission: vi.fn(),
  getIngestCountAhead: vi.fn(),
  queueAdd: vi.fn(),
  queueGetJob: vi.fn(),
  sendOperatorAlert: vi.fn(),
  removeQuietly: vi.fn(),
}));

vi.mock("@print/db", () => ({
  prisma: { uploadedModel: { count: mocks.count } },
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
}));

vi.mock("@/lib/ingest-queue", () => ({
  reserveIngestAdmission: mocks.reserveIngestAdmission,
  releaseIngestAdmission: mocks.releaseIngestAdmission,
  getIngestCountAhead: mocks.getIngestCountAhead,
}));

vi.mock("@/lib/queue", () => ({
  getIngestQueue: vi.fn(() => ({
    add: mocks.queueAdd,
    getJob: mocks.queueGetJob,
  })),
}));

vi.mock("@/lib/session", () => ({
  getOrCreateQuoteSessionId: vi.fn(async () => "11111111-1111-4111-8111-111111111111"),
}));

vi.mock("@/lib/telegram", () => ({ sendOperatorAlert: mocks.sendOperatorAlert }));

vi.mock("@/lib/storage", () => ({
  availableStorageBytes: vi.fn(async () => 10 * 1024 * 1024 * 1024),
  ensureStorageDirs: vi.fn(async () => {
    await mkdir(join(mocks.state.dir, "tmp"), { recursive: true });
  }),
  tmpUploadPath: vi.fn(() => join(mocks.state.dir, "tmp", crypto.randomUUID())),
  removeQuietly: mocks.removeQuietly,
}));

const { POST } = await import("@/app/api/uploads/route");

function uploadRequest(contents: Buffer, filename = "customer-cube.3mf") {
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(contents)]), filename);
  return new Request("http://localhost/api/uploads", { method: "POST", body: form });
}

function queuedTempPath(): string {
  const data = mocks.queueAdd.mock.calls[0]?.[1] as { tmpName: string };
  return join(mocks.state.dir, "tmp", data.tmpName);
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.state.dir = await mkdtemp(join(tmpdir(), "print-upload-test-"));
  await mkdir(join(mocks.state.dir, "tmp"), { recursive: true });
  mocks.count.mockResolvedValue(0);
  mocks.reserveStorageBytes.mockResolvedValue("1234:22222222-2222-4222-8222-222222222222");
  mocks.releaseStorageReservation.mockResolvedValue(undefined);
  mocks.reserveIngestAdmission.mockResolvedValue({ position: 0 });
  mocks.releaseIngestAdmission.mockResolvedValue(undefined);
  mocks.getIngestCountAhead.mockResolvedValue(0);
  mocks.queueAdd.mockResolvedValue({ id: "unused" });
  mocks.queueGetJob.mockResolvedValue(undefined);
  mocks.sendOperatorAlert.mockResolvedValue(undefined);
  mocks.removeQuietly.mockImplementation(async (path: string | null | undefined) => {
    if (path) await rm(path, { force: true, recursive: true });
  });
});

afterEach(async () => {
  if (mocks.state.dir) await rm(mocks.state.dir, { recursive: true, force: true });
});

describe("POST /api/uploads queued ingest", () => {
  it("streams the unchanged upload to a bounded FIFO ticket and transfers cleanup", async () => {
    const archive = await readFile(
      join(process.cwd(), "..", "..", "packages", "geometry", "fixtures", "cube.3mf"),
    );

    const response = await POST(uploadRequest(archive) as never);

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({ ticket: expect.any(String), position: 0 });
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "ingest",
      expect.objectContaining({
        tmpName: expect.stringMatching(/^[0-9a-f-]{36}$/),
        sessionId: "11111111-1111-4111-8111-111111111111",
        originalName: "customer-cube.3mf",
        format: "3mf",
        sizeBytes: archive.length,
        sha256: createHash("sha256").update(archive).digest("hex"),
        reservationMember: "1234:22222222-2222-4222-8222-222222222222",
      }),
      { jobId: body.ticket },
    );
    await expect(access(queuedTempPath())).resolves.toBeUndefined();
    expect(mocks.releaseIngestAdmission).toHaveBeenCalledWith(body.ticket);
    expect(mocks.releaseStorageReservation).not.toHaveBeenCalled();
  });

  it("rejects a full admission set and cleans all producer-owned resources", async () => {
    mocks.reserveIngestAdmission.mockResolvedValue(null);
    const contents = Buffer.from("solid cube\nendsolid cube\n");

    const response = await POST(uploadRequest(contents, "cube.stl") as never);

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INGEST_QUEUE_FULL" },
    });
    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(mocks.removeQuietly).toHaveBeenCalledOnce();
    expect(mocks.releaseStorageReservation).toHaveBeenCalledWith(
      "1234:22222222-2222-4222-8222-222222222222",
    );
    expect(mocks.sendOperatorAlert).toHaveBeenCalledWith(
      "ingest_queue_depth",
      "Upload ingest queue reached its hard admission limit of 25.",
    );
  });

  it("cleans admission, temp, and storage when enqueue is confirmed absent", async () => {
    mocks.queueAdd.mockRejectedValue(new Error("connection reset"));
    mocks.queueGetJob.mockResolvedValue(undefined);

    const response = await POST(uploadRequest(Buffer.from("solid x\nendsolid x\n"), "x.stl") as never);

    expect(response.status).toBe(503);
    expect(mocks.releaseIngestAdmission).toHaveBeenCalledOnce();
    expect(mocks.removeQuietly).toHaveBeenCalledOnce();
    expect(mocks.releaseStorageReservation).toHaveBeenCalledOnce();
  });

  it("preserves resources when an enqueue outcome cannot be determined", async () => {
    mocks.queueAdd.mockRejectedValue(new Error("connection reset"));
    mocks.queueGetJob.mockRejectedValue(new Error("redis unavailable"));

    const response = await POST(uploadRequest(Buffer.from("solid x\nendsolid x\n"), "x.stl") as never);

    expect(response.status).toBe(503);
    expect(mocks.releaseIngestAdmission).not.toHaveBeenCalled();
    expect(mocks.removeQuietly).not.toHaveBeenCalled();
    expect(mocks.releaseStorageReservation).not.toHaveBeenCalled();
    await expect(access(queuedTempPath())).resolves.toBeUndefined();
  });

  it("returns the ticket when lookup verifies an add whose response was lost", async () => {
    mocks.queueAdd.mockImplementation(async (_name, data) => {
      mocks.queueGetJob.mockResolvedValue({ data });
      throw new Error("response lost");
    });
    mocks.getIngestCountAhead.mockResolvedValue(3);

    const response = await POST(uploadRequest(Buffer.from("solid x\nendsolid x\n"), "x.stl") as never);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ position: 3 });
    expect(mocks.releaseIngestAdmission).toHaveBeenCalledOnce();
    expect(mocks.releaseStorageReservation).not.toHaveBeenCalled();
  });

  it("alerts on high accepted queue depth without delaying acceptance", async () => {
    mocks.reserveIngestAdmission.mockResolvedValue({ position: 20 });
    mocks.getIngestCountAhead.mockResolvedValue(20);

    const response = await POST(uploadRequest(Buffer.from("solid x\nendsolid x\n"), "x.stl") as never);

    expect(response.status).toBe(202);
    expect(mocks.sendOperatorAlert).toHaveBeenCalledWith(
      "ingest_queue_depth",
      "Upload ingest queue has at least 21 admitted jobs.",
    );
  });
});
