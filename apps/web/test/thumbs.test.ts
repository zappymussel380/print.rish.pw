import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  update: vi.fn(),
  findFirst: vi.fn(),
}));
const storage = vi.hoisted(() => ({
  openPrivateFile: vi.fn(),
  readPrivateFile: vi.fn(),
  removeQuietly: vi.fn(),
}));

vi.mock("@print/db", () => ({
  prisma: { uploadedModel: { update: db.update, findFirst: db.findFirst } },
}));
vi.mock("@/lib/storage", () => ({
  thumbPath: (id: string) => `/data/uploads/thumbs/${id}.png`,
  openPrivateFile: storage.openPrivateFile,
  readPrivateFile: storage.readPrivateFile,
  removeQuietly: storage.removeQuietly,
}));

const { readThumbPng } = await import("@/lib/thumbs");

const MODEL_ID = "11111111-1111-4111-8111-111111111111";

describe("readThumbPng", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the PNG bytes of an owned thumbnail", async () => {
    storage.openPrivateFile.mockResolvedValue({ handle: { close: vi.fn() } });
    storage.readPrivateFile.mockResolvedValue(Buffer.from("png-bytes"));

    const png = await readThumbPng(MODEL_ID, "a".repeat(64), `/data/uploads/thumbs/${MODEL_ID}.png`);
    expect(png).toEqual(Buffer.from("png-bytes"));
  });

  it("returns null when no thumbnail can be resolved", async () => {
    storage.openPrivateFile.mockRejectedValue(new Error("ENOENT"));
    db.findFirst.mockResolvedValue(null);

    expect(await readThumbPng(MODEL_ID, "a".repeat(64), null)).toBeNull();
  });

  it("returns null when reading the resolved file fails", async () => {
    storage.openPrivateFile.mockResolvedValue({ handle: { close: vi.fn() } });
    storage.readPrivateFile.mockRejectedValue(new Error("EIO"));

    expect(
      await readThumbPng(MODEL_ID, "a".repeat(64), `/data/uploads/thumbs/${MODEL_ID}.png`),
    ).toBeNull();
  });
});
