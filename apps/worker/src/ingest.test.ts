import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  state: {
    dir: "",
    storageReserveBytes: 1,
    maxUploadBytes: 10 * 1024 * 1024,
    stepConvertBin: "/usr/bin/occt-draw-7.6",
  },
  count: vi.fn(),
  aggregate: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
  transaction: vi.fn(),
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
    get maxUploadBytes() {
      return mocks.state.maxUploadBytes;
    },
    maxSessionUploadBytes: 20 * 1024 * 1024,
    maxModelsPerSession: 20,
    get storageReserveBytes() {
      return mocks.state.storageReserveBytes;
    },
    thumbSize: 128,
    storageUid: typeof process.getuid === "function" ? process.getuid() : 1001,
    storageGid: typeof process.getgid === "function" ? process.getgid() : 1001,
    parserUid: typeof process.getuid === "function" ? process.getuid() : 1003,
    parserGid: typeof process.getgid === "function" ? process.getgid() : 3100,
    get parseWorkRoot() {
      return join(mocks.state.dir, "parse-work");
    },
    parseTimeoutMs: 60_000,
    get stepConvertBin() {
      return mocks.state.stepConvertBin;
    },
    stepConvertTimeoutMs: 30_000,
  },
}));

const { INGEST_WORKER_OPTIONS, processIngestJob, terminalCleanup } = await import("./ingest");

const REAL_PARSE_CHILD = [
  resolve(process.cwd(), "node_modules/.bin/tsx"),
  resolve(process.cwd(), "src/parse-child.ts"),
];

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
    parse: { childCommand: REAL_PARSE_CHILD, sandbox: false },
  };
}

async function putTemp(contents: Buffer, name = TMP_NAME): Promise<string> {
  const path = join(mocks.state.dir, "tmp", name);
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  return path;
}

/** DRAWEXE stand-in with the real argv contract: emits `payload` as the
 * converted STL plus the success sentinel. */
async function putFakeConverter(payload: Buffer): Promise<string> {
  const payloadPath = join(mocks.state.dir, "converter-payload.stl");
  await writeFile(payloadPath, payload);
  const bin = join(mocks.state.dir, "fake-occt.sh");
  await writeFile(
    bin,
    `#!/bin/bash\nSCRIPT="\${@: -1}"\ncat ${payloadPath} > "$(dirname "$SCRIPT")/step-converted.stl"\necho STEP_CONVERT_OK\n`,
    { mode: 0o755 },
  );
  return bin;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.state.dir = await mkdtemp(join(tmpdir(), "print-ingest-test-"));
  mocks.state.storageReserveBytes = 1;
  mocks.state.maxUploadBytes = 10 * 1024 * 1024;
  await mkdir(join(mocks.state.dir, "tmp"), { recursive: true });
  mocks.count.mockResolvedValue(0);
  mocks.aggregate.mockResolvedValue({ _sum: { sizeBytes: 0 } });
  mocks.create.mockResolvedValue({});
  mocks.deleteMany.mockResolvedValue({ count: 0 });
  mocks.transaction.mockImplementation(async (action: (tx: unknown) => Promise<unknown>) =>
    action({ uploadedModel: { create: mocks.create } }),
  );
});

afterEach(async () => {
  if (mocks.state.dir) await rm(mocks.state.dir, { recursive: true, force: true });
});

describe("ingest worker contract", () => {
  it("uses one non-replaying consumer with a short lock now that parsing is off-loop", () => {
    expect(INGEST_WORKER_OPTIONS).toEqual({
      concurrency: 1,
      maxStalledCount: 0,
      lockDuration: 2 * 60_000,
    });
  });

  it("parses uploads in the isolated child process, not in the orchestrator", async () => {
    const contents = await fixture("cube.stl");
    await putTemp(contents);
    const job = makeJob(contents);
    const ctx = context();
    // A sentinel child proves the processor delegates: if ingest still parsed
    // in-process, this healthy cube would ingest fine and the test would fail.
    ctx.parse = {
      childCommand: [
        process.execPath,
        "-e",
        `process.stdout.write(JSON.stringify({ ok: false, publicCode: "INVALID_MODEL_SENTINEL", message: "from the child" }) + "\\n"); process.exit(64);`,
      ],
      sandbox: false,
    };

    await expect(processIngestJob(job, ctx)).rejects.toThrow("INVALID_MODEL_SENTINEL");

    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        publicFailure: expect.objectContaining({
          code: "INVALID_MODEL_SENTINEL",
          message: "from the child",
        }),
      }),
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
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
    expect(createData.thumbPath).toMatch(/thumbs[/\\].+\.png$/);
    const thumb = await readFile(createData.thumbPath);
    expect(thumb.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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

  it("enforces canonical-file limits even when the upload itself is small", async () => {
    // A deflated archive can expand into a canonical STL far larger than the
    // uploaded bytes; the customer must still see FILE_TOO_LARGE.
    const { strToU8, unzipSync, zipSync } = await import("fflate");
    const archive = await fixture("cube.3mf");
    const xml = Buffer.from(unzipSync(new Uint8Array(archive))["3D/3dmodel.model"]!).toString();
    const triangles = xml.match(/<triangle[^>]*\/>/g)!.join("");
    const inflated = xml.replace("</triangles>", `${triangles.repeat(400)}</triangles>`);
    const bomb = Buffer.from(zipSync({ "3D/3dmodel.model": strToU8(inflated) }, { level: 9 }));
    mocks.state.maxUploadBytes = 100_000;
    expect(bomb.length).toBeLessThan(100_000);
    await putTemp(bomb);
    const job = makeJob(bomb, { originalName: "bomb.3mf", format: "3mf" });

    await expect(processIngestJob(job, context())).rejects.toThrow("FILE_TOO_LARGE");
    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        publicFailure: expect.objectContaining({ code: "FILE_TOO_LARGE" }),
      }),
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
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

  it("keeps the original STEP source beside the converted model", async () => {
    const stepContents = await readFile(resolve(process.cwd(), "test-fixtures", "box.step"));
    const cube = await fixture("cube.stl");
    const fakeOcct = await putFakeConverter(cube);
    mocks.state.stepConvertBin = fakeOcct;
    const tempPath = await putTemp(stepContents);
    const job = makeJob(stepContents, { originalName: "box.step", format: "step" });

    const result = await processIngestJob(job, context());

    expect(result.model).toMatchObject({ originalName: "box.stl", format: "stl" });
    const createData = mocks.create.mock.calls[0]![0].data;
    expect(createData.sourceFormat).toBe("step");
    await expect(readFile(createData.storedPath)).resolves.toEqual(cube);
    const sourcePath = join(mocks.state.dir, `${createData.id}.step`);
    await expect(readFile(sourcePath)).resolves.toEqual(stepContents);
    await expect(readFile(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back the retained STEP source when persistence fails", async () => {
    const stepContents = await readFile(resolve(process.cwd(), "test-fixtures", "box.step"));
    const fakeOcct = await putFakeConverter(await fixture("cube.stl"));
    mocks.state.stepConvertBin = fakeOcct;
    await putTemp(stepContents);
    mocks.create.mockRejectedValueOnce(new Error("database failed"));
    const job = makeJob(stepContents, { originalName: "box.step", format: "step" });

    await expect(processIngestJob(job, context())).rejects.toThrow("INGEST_FAILED");

    const createData = mocks.create.mock.calls[0]![0].data;
    await expect(readFile(createData.storedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(mocks.state.dir, `${createData.id}.step`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back every generated artifact and row identity when persistence fails", async () => {
    const { strToU8, zipSync } = await import("fflate");
    const twoObjectModel = `<?xml version="1.0" encoding="UTF-8"?>
      <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
        <resources>
          <object id="1" type="model"><mesh>
            <vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices>
            <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
          </mesh></object>
          <object id="2" type="model"><mesh>
            <vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="0" y="20" z="0"/></vertices>
            <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
          </mesh></object>
        </resources>
        <build><item objectid="1"/><item objectid="2"/></build>
      </model>`;
    const plateSettings = `<?xml version="1.0"?><config>
      <plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/></model_instance></plate>
      <plate><metadata key="plater_id" value="2"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate>
    </config>`;
    const contents = Buffer.from(
      zipSync({
        "3D/3dmodel.model": strToU8(twoObjectModel),
        "Metadata/model_settings.config": strToU8(plateSettings),
      }),
    );
    await putTemp(contents);
    mocks.create.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("database failed"));
    const job = makeJob(contents, { originalName: "plates.3mf", format: "3mf" });

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

  it("releases admission, reservation, and temp file for a job whose processor never ran", async () => {
    // A job failed as stalled (maxStalledCount: 0) skips processIngestJob
    // entirely, so the failed-event handler must run terminal cleanup itself.
    const contents = await fixture("cube.stl");
    const tempPath = await putTemp(contents);
    const job = makeJob(contents);
    const ctx = context();

    await terminalCleanup(job, ctx);

    await expect(readFile(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(ctx.redis.zrem).toHaveBeenCalledWith(
      UPLOAD_STORAGE_RESERVATION_KEY,
      job.data.reservationMember,
    );
    expect(ctx.redis.zrem).toHaveBeenCalledWith(INGEST_ADMISSION_KEY, TICKET);
    expect(mocks.transaction).not.toHaveBeenCalled();
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
