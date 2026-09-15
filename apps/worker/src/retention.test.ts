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
  settingFindUnique: vi.fn(),
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
    appSetting: { findUnique: mocks.settingFindUnique },
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

const { loadRetentionPolicy, runRetention } = await import("./retention");

const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never;
const POLICY = { uploadRetentionHours: 24, fileRetentionDays: 30, quotationRetentionDays: 90 };

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
  mocks.settingFindUnique.mockResolvedValue(null);
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

    await runRetention(log, POLICY);

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

    await runRetention(log, POLICY);

    expect(existsSync(liveStored)).toBe(true);
    expect(existsSync(liveSource)).toBe(true);
    expect(existsSync(deadSource)).toBe(false);
  });

  it("leaves the public showcase alone", async () => {
    // The showcase lives under uploadDir/showcase and has no model row, so an
    // orphan sweep that walked it — or that ever started matching directories
    // recursively — would silently delete the published gallery. Nothing else
    // catches that; the photos would simply stop loading one morning.
    const showcase = join(mocks.state.dir, "showcase");
    await mkdir(showcase);
    const photo = await putOld(join(showcase, `${DEAD_ID}.png`));
    const jpeg = await putOld(join(showcase, `${LIVE_ID}.jpg`));

    await runRetention(log, POLICY);

    expect(existsSync(photo)).toBe(true);
    expect(existsSync(jpeg)).toBe(true);
  });

});

describe("the owner's retention settings", () => {
  it("use the environment until saved, then the saved days", async () => {
    expect(await loadRetentionPolicy(log)).toEqual({ uploadRetentionHours: 24, fileRetentionDays: 30, quotationRetentionDays: 90 });
    mocks.settingFindUnique.mockResolvedValue({ value: { uploadRetentionDays: 3, fileRetentionDays: 60, quotationRetentionDays: null } });
    expect(await loadRetentionPolicy(log)).toEqual({ uploadRetentionHours: 72, fileRetentionDays: 60, quotationRetentionDays: null });
  });

  it("skip the sweep when the settings can't be read, rather than delete on a guess", async () => {
    mocks.settingFindUnique.mockRejectedValue(new Error("permission denied for table AppSetting"));
    expect(await loadRetentionPolicy(log)).toBeNull();
  });

  it("never delete quotations when kept for good, or on a purge", async () => {
    const finished = { id: "q1", number: "RSP-2026-0001", items: [], status: "COMPLETED" };
    mocks.quotationFindMany.mockResolvedValueOnce([finished]).mockResolvedValue([]);
    await runRetention(log, { ...POLICY, quotationRetentionDays: null });
    expect(mocks.quotationDeleteMany).not.toHaveBeenCalled();

    mocks.quotationFindMany.mockReset().mockResolvedValueOnce([finished]).mockResolvedValue([]);
    const report = await runRetention(log, POLICY, { purgeOnly: true });
    expect(mocks.quotationDeleteMany).not.toHaveBeenCalled();
    expect(report.deletedQuotations).toBe(0);
  });

  it("still delete finished quotations past the saved days", async () => {
    mocks.quotationFindMany
      .mockResolvedValueOnce([]) // files stage
      .mockResolvedValueOnce([{ id: "q1", number: "RSP-2026-0001", items: [] }])
      .mockResolvedValue([]);
    const report = await runRetention(log, POLICY);
    expect(mocks.quotationDeleteMany).toHaveBeenCalledOnce();
    expect(report.deletedQuotations).toBe(1);
  });
});
