import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LIVE_ID = "11111111-1111-4111-8111-111111111111";
const DEAD_ID = "22222222-2222-4222-8222-222222222222";
const STALE_ID = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  state: { dir: "", pdfDir: "" },
  modelFindMany: vi.fn(),
  modelFindUnique: vi.fn(),
  modelDeleteMany: vi.fn(),
  modelUpdateMany: vi.fn(),
  quotationFindMany: vi.fn(),
  quotationDeleteMany: vi.fn(),
  itemCount: vi.fn(),
}));

vi.mock("@print/db", () => ({
  prisma: {
    uploadedModel: {
      findMany: mocks.modelFindMany,
      findUnique: mocks.modelFindUnique,
      deleteMany: mocks.modelDeleteMany,
      updateMany: mocks.modelUpdateMany,
    },
    quotation: {
      findMany: mocks.quotationFindMany,
      deleteMany: mocks.quotationDeleteMany,
    },
    quotationItem: { count: mocks.itemCount },
  },
}));

vi.mock("./config.js", () => ({
  config: {
    get uploadDir() {
      return mocks.state.dir;
    },
    get pdfDir() {
      return mocks.state.pdfDir;
    },
    uploadRetentionHours: 24,
    fileRetentionDays: 30,
    quotationRetentionDays: 90,
  },
}));

const { runRetention } = await import("./retention");

const log = { info: vi.fn(), error: vi.fn() } as never;

async function putOld(path: string): Promise<string> {
  await writeFile(path, "x");
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await utimes(path, old, old);
  return path;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.state.dir = await mkdtemp(join(tmpdir(), "print-retention-"));
  mocks.state.pdfDir = join(mocks.state.dir, "pdfs");
  await mkdir(join(mocks.state.dir, "thumbs"));
  await mkdir(mocks.state.pdfDir);
  mocks.modelFindMany.mockResolvedValue([]);
  mocks.modelFindUnique.mockResolvedValue(null);
  mocks.modelDeleteMany.mockResolvedValue({ count: 1 });
  mocks.modelUpdateMany.mockResolvedValue({ count: 1 });
  mocks.quotationFindMany.mockResolvedValue([]);
  mocks.quotationDeleteMany.mockResolvedValue({ count: 1 });
  mocks.itemCount.mockResolvedValue(0);
});

afterEach(async () => {
  if (mocks.state.dir) await rm(mocks.state.dir, { recursive: true, force: true });
});

describe("retention and STEP sources", () => {
  it("deletes the retained STEP source with a stale upload", async () => {
    const stored = join(mocks.state.dir, `${STALE_ID}.stl`);
    const source = join(mocks.state.dir, `${STALE_ID}.step`);
    await putOld(stored);
    await putOld(source);
    mocks.modelFindMany.mockImplementation(async (args: { where?: { createdAt?: unknown } }) => {
      if (args?.where?.createdAt && !mocks.modelFindMany.mock.settledResults.length) {
        return [
          {
            id: STALE_ID,
            format: "stl",
            sourceFormat: "step",
            storedPath: stored,
            thumbPath: null,
          },
        ];
      }
      return [];
    });

    await runRetention(log);

    expect(existsSync(stored)).toBe(false);
    expect(existsSync(source)).toBe(false);
  });

  it("keeps live STEP sources and reaps orphaned ones", async () => {
    const liveStored = join(mocks.state.dir, `${LIVE_ID}.stl`);
    const liveSource = join(mocks.state.dir, `${LIVE_ID}.step`);
    const deadSource = join(mocks.state.dir, `${DEAD_ID}.step`);
    await putOld(liveStored);
    await putOld(liveSource);
    await putOld(deadSource);
    mocks.modelFindMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) => {
      const ids = args?.where?.id?.in;
      if (!ids) return [];
      return ids.includes(LIVE_ID)
        ? [
            {
              id: LIVE_ID,
              format: "stl",
              sourceFormat: "step",
              storedPath: liveStored,
              thumbPath: null,
            },
          ]
        : [];
    });

    await runRetention(log);

    expect(existsSync(liveStored)).toBe(true);
    expect(existsSync(liveSource)).toBe(true);
    expect(existsSync(deadSource)).toBe(false);
  });
});
