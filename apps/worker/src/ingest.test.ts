import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseModel } from "@print/geometry";
import {
  INGEST_ADMISSION_KEY,
  UPLOAD_STORAGE_RESERVATION_KEY,
  type IngestJobData,
  type IngestJobResult,
} from "@print/shared";

const TICKET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TMP_NAME = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RESERVATION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const mocks = vi.hoisted(() => ({
  state: { dir: "", storageReserveBytes: 1 },
  count: vi.fn(),
  aggregate: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
  transaction: vi.fn(),
  prepare: vi.fn(),
  actualPrepare: undefined as ((input: unknown) => unknown) | undefined,
}));

vi.mock("@print/db", () => ({
  Prisma: {},
  prisma: {
    uploadedModel: {
      count: mocks.count,
      aggregate: mocks.aggregate,
      deleteMany: mocks.deleteMany,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("./config.js", () => ({
  config: {
    get uploadDir() {
      return mocks.state.dir;
    },
    maxUploadBytes: 10 * 1024 * 1024,
    maxSessionUploadBytes: 20 * 1024 * 1024,
    maxModelsPerSession: 20,
    get storageReserveBytes() {
      return mocks.state.storageReserveBytes;
    },
    thumbSize: 128,
    storageUid: typeof process.getuid === "function" ? process.getuid() : 1001,
    storageGid: typeof process.getgid === "function" ? process.getgid() : 1001,
  },
}));

vi.mock("./upload-prepare.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./upload-prepare")>();
  mocks.actualPrepare = actual.prepareUploadModels as (input: unknown) => unknown;
  return { ...actual, prepareUploadModels: mocks.prepare };
});

const { INGEST_WORKER_OPTIONS, processIngestJob } = await import("./ingest");

function fixture(name: string): Promise<Buffer> {
  return readFile(resolve(process.cwd(), "../../packages/geometry/fixtures", name));
}

function makeJob(contents: Buffer, overrides: Partial<IngestJobData> = {}) {
  const data: IngestJobData = {
    tmpName: TMP_NAME,
    sessionId: SESSION_ID,
    originalName: "cube.stl",
    format: "stl",
    sizeBytes: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
    reservationMember: `${Math.max(contents.length, 1_000_000)}:${RESERVATION_ID}`,
    ...overrides,
  };
  const job = {
    id: TICKET,
    data,
    opts: { attempts: 1 },
    updateData: vi.fn(async (next: IngestJobData) => {
      job.data = next;
    }),
  };
  return job as unknown as Job<IngestJobData, IngestJobResult>;
}

function context() {
  return {
    redis: { zrem: vi.fn(async () => 1) },
    log: { info: vi.fn(), warn: vi.fn() },
  };
}

async function putTemp(contents: Buffer, name = TMP_NAME): Promise<string> {
  const path = join(mocks.state.dir, "tmp", name);
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  return path;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.state.dir = await mkdtemp(join(tmpdir(), "print-ingest-test-"));
  mocks.state.storageReserveBytes = 1;
  await mkdir(join(mocks.state.dir, "tmp"), { recursive: true });
  mocks.count.mockResolvedValue(0);
  mocks.aggregate.mockResolvedValue({ _sum: { sizeBytes: 0 } });
  mocks.create.mockResolvedValue({});
  mocks.deleteMany.mockResolvedValue({ count: 0 });
  mocks.transaction.mockImplementation(async (action: (tx: unknown) => Promise<unknown>) =>
    action({ uploadedModel: { create: mocks.create } }),
  );
  mocks.prepare.mockImplementation((input: unknown) => mocks.actualPrepare!(input));
});

afterEach(async () => {
  if (mocks.state.dir) await rm(mocks.state.dir, { recursive: true, force: true });
});

describe("ingest worker contract", () => {
  it("uses one non-replaying consumer with a long parser lock", () => {
    expect(INGEST_WORKER_OPTIONS).toEqual({
      concurrency: 1,
      maxStalledCount: 0,
      lockDuration: 15 * 60_000,
    });
  });

  it("verifies, persists, and cleans a raw upload under worker ownership", async () => {
    const contents = await fixture("cube.stl");
    const tempPath = await putTemp(contents);
    const job = makeJob(contents);
    const ctx = context();

    const result = await processIngestJob(job, ctx);

    expect(result.models).toHaveLength(1);
    expect(result.model).toMatchObject({
      originalName: "cube.stl",
      format: "stl",
      sizeBytes: contents.length,
      triangleCount: 12,
    });
    expect(mocks.count).toHaveBeenCalledWith({
      where: { sessionId: SESSION_ID, items: { none: {} } },
    });
    const createData = mocks.create.mock.calls[0]![0].data;
    await expect(readFile(createData.storedPath)).resolves.toEqual(contents);
    expect(createData.fileHash).toBe(createHash("sha256").update(contents).digest("hex"));
    await expect(readFile(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(job.updateData).not.toHaveBeenCalled();
    expect(ctx.redis.zrem).toHaveBeenCalledWith(
      UPLOAD_STORAGE_RESERVATION_KEY,
      job.data.reservationMember,
    );
    expect(ctx.redis.zrem).toHaveBeenCalledWith(INGEST_ADMISSION_KEY, TICKET);
  });

  it("uses O_NOFOLLOW and never removes a symlink target", async () => {
    const contents = await fixture("cube.stl");
    const target = join(mocks.state.dir, "target.stl");
    await writeFile(target, contents);
    await symlink(target, join(mocks.state.dir, "tmp", TMP_NAME));
    const job = makeJob(contents);

    await expect(processIngestJob(job, context())).rejects.toThrow(
      "INGEST_FAILED",
    );

    await expect(readFile(target)).resolves.toEqual(contents);
    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        publicFailure: expect.objectContaining({ code: "INGEST_FAILED" }),
      }),
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects path-bearing Redis data before touching storage", async () => {
    const contents = await fixture("cube.stl");
    const job = makeJob(contents, { tmpName: "../../customer-file" });
    const ctx = context();

    await expect(processIngestJob(job, ctx)).rejects.toThrow(
      "INGEST_FAILED",
    );

    expect(job.updateData).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(ctx.redis.zrem).toHaveBeenCalledTimes(2);
    expect(ctx.redis.zrem).toHaveBeenCalledWith(INGEST_ADMISSION_KEY, TICKET);
    expect(ctx.redis.zrem).toHaveBeenCalledWith(
      UPLOAD_STORAGE_RESERVATION_KEY,
      job.data.reservationMember,
    );
  });

  it("fails closed when descriptor size differs from queued metadata", async () => {
    const contents = await fixture("cube.stl");
    await putTemp(contents);
    const job = makeJob(contents, { sizeBytes: contents.length - 1 });

    await expect(processIngestJob(job, context())).rejects.toThrow(
      "INGEST_FAILED",
    );

    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        publicFailure: expect.objectContaining({ code: "INGEST_FAILED" }),
      }),
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("fails closed when the descriptor hash differs from queued metadata", async () => {
    const contents = await fixture("cube.stl");
    await putTemp(contents);
    const job = makeJob(contents, { sha256: "0".repeat(64) });

    await expect(processIngestJob(job, context())).rejects.toThrow(
      "INGEST_FAILED",
    );

    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        publicFailure: expect.objectContaining({ code: "INGEST_FAILED" }),
      }),
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("records existing parse failures without exposing an internal failure reason", async () => {
    const contents = Buffer.from("not an STL");
    const tempPath = await putTemp(contents);
    const job = makeJob(contents);
    const ctx = context();

    await expect(processIngestJob(job, ctx)).rejects.toThrow("INVALID_MODEL_MALFORMED");

    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        publicFailure: expect.objectContaining({ code: "INVALID_MODEL_MALFORMED" }),
      }),
    );
    await expect(readFile(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(ctx.redis.zrem).toHaveBeenCalledTimes(2);
  });

  it("enforces the authoritative session count inside the consumer", async () => {
    const contents = await fixture("cube.stl");
    await putTemp(contents);
    mocks.count.mockResolvedValue(20);
    const job = makeJob(contents);

    await expect(processIngestJob(job, context())).rejects.toThrow("TOO_MANY_MODELS");

    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        publicFailure: expect.objectContaining({ code: "TOO_MANY_MODELS" }),
      }),
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("enforces canonical-file and aggregate-byte limits after parsing", async () => {
    const contents = await fixture("cube.stl");
    await putTemp(contents);
    const parsed = parseModel(contents, "stl");
    mocks.prepare.mockReturnValue({
      models: [
        {
          originalName: "cube.stl",
          format: "stl",
          contents,
          parsed,
          fileHash: createHash("sha256").update(contents).digest("hex"),
          sizeBytes: 10 * 1024 * 1024 + 1,
          derived: false,
        },
      ],
      totalBytes: 10 * 1024 * 1024 + 1,
    });
    const job = makeJob(contents);

    await expect(processIngestJob(job, context())).rejects.toThrow("FILE_TOO_LARGE");
    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        publicFailure: expect.objectContaining({ code: "FILE_TOO_LARGE" }),
      }),
    );
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it("enforces the authoritative session byte total inside the consumer", async () => {
    const contents = await fixture("cube.stl");
    await putTemp(contents);
    mocks.aggregate.mockResolvedValue({ _sum: { sizeBytes: 20 * 1024 * 1024 } });
    const job = makeJob(contents);

    await expect(processIngestJob(job, context())).rejects.toThrow(
      "SESSION_STORAGE_LIMIT",
    );
    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        publicFailure: expect.objectContaining({ code: "SESSION_STORAGE_LIMIT" }),
      }),
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rechecks filesystem reserve immediately before durable writes", async () => {
    const contents = await fixture("cube.stl");
    await putTemp(contents);
    mocks.state.storageReserveBytes = Number.MAX_SAFE_INTEGER;
    const job = makeJob(contents);

    await expect(processIngestJob(job, context())).rejects.toThrow("STORAGE_LOW");
    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        publicFailure: expect.objectContaining({ code: "STORAGE_LOW" }),
      }),
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rolls back every generated artifact and row identity when persistence fails", async () => {
    const contents = await fixture("cube.stl");
    await putTemp(contents);
    const parsed = parseModel(contents, "stl");
    const fileHash = createHash("sha256").update(contents).digest("hex");
    mocks.prepare.mockReturnValue({
      models: ["one", "two"].map((name) => ({
        originalName: `${name}.stl`,
        format: "stl",
        contents,
        parsed,
        fileHash,
        sizeBytes: contents.length,
        derived: true,
      })),
      totalBytes: contents.length * 2,
    });
    mocks.create.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("database failed"));
    const job = makeJob(contents);

    await expect(processIngestJob(job, context())).rejects.toThrow(
      "INGEST_FAILED",
    );

    const paths = mocks.create.mock.calls.map((call) => call[0].data.storedPath as string);
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: expect.arrayContaining([expect.any(String), expect.any(String)]) },
        items: { none: {} },
      },
    });
  });

  it("does not turn successful persistence into failure when Redis cleanup is down", async () => {
    const contents = await fixture("cube.stl");
    await putTemp(contents);
    const job = makeJob(contents);
    const ctx = context();
    ctx.redis.zrem.mockRejectedValue(new Error("redis unavailable"));

    await expect(processIngestJob(job, ctx)).resolves.toMatchObject({
      model: { originalName: "cube.stl" },
    });

    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cleanup: expect.any(String) }),
      "ingest terminal cleanup failed",
    );
  });
});
