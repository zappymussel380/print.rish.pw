import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentPrint } from "@print/shared";

const state = vi.hoisted(() => ({ dir: "" }));

vi.mock("@/lib/env", () => ({
  env: {
    get uploadDir() {
      return state.dir;
    },
    get pdfDir() {
      return join(state.dir, "pdfs");
    },
  },
}));

const { pruneUnreferencedShowcasePhotos } = await import("@/lib/showcase-photos");

const ID = {
  kept: "11111111-1111-4111-8111-111111111111",
  removed: "22222222-2222-4222-8222-222222222222",
  fresh: "33333333-3333-4333-8333-333333333333",
  abandoned: "44444444-4444-4444-8444-444444444444",
};

const print = (id: string): RecentPrint => ({
  id,
  caption: "Clip",
  material: "PLA",
  photoExt: "png",
  createdAt: new Date().toISOString(),
});

const photo = (id: string) => join(state.dir, "showcase", `${id}.png`);

async function write(id: string, ageMs = 0): Promise<string> {
  const path = photo(id);
  await writeFile(path, "x");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await utimes(path, when, when);
  }
  return path;
}

beforeEach(async () => {
  state.dir = await mkdtemp(join(tmpdir(), "print-showcase-"));
  await mkdir(join(state.dir, "showcase"));
});

afterEach(async () => {
  if (state.dir) await rm(state.dir, { recursive: true, force: true });
});

describe("pruneUnreferencedShowcasePhotos", () => {
  it("keeps every photo the saved list still points at", async () => {
    await write(ID.kept);
    const removed = await pruneUnreferencedShowcasePhotos([print(ID.kept)]);
    expect(removed).toBe(0);
    expect(existsSync(photo(ID.kept))).toBe(true);
  });

  it("deletes a photo the admin just removed, without waiting out a grace", async () => {
    await write(ID.kept);
    await write(ID.removed);

    const removed = await pruneUnreferencedShowcasePhotos(
      [print(ID.kept)],
      [print(ID.kept), print(ID.removed)],
    );

    expect(removed).toBe(1);
    expect(existsSync(photo(ID.kept))).toBe(true);
    expect(existsSync(photo(ID.removed))).toBe(false);
  });

  it("spares a just-uploaded photo whose caption is still being written", async () => {
    await write(ID.fresh);
    const removed = await pruneUnreferencedShowcasePhotos([], []);
    expect(removed).toBe(0);
    expect(existsSync(photo(ID.fresh))).toBe(true);
  });

  it("eventually collects an upload that was never saved", async () => {
    await write(ID.abandoned, 2 * 60 * 60 * 1000);
    const removed = await pruneUnreferencedShowcasePhotos([], []);
    expect(removed).toBe(1);
    expect(existsSync(photo(ID.abandoned))).toBe(false);
  });

  it("ignores files that are not showcase photos", async () => {
    const stray = join(state.dir, "showcase", "notes.txt");
    await writeFile(stray, "x");
    const when = new Date(Date.now() - 5 * 60 * 60 * 1000);
    await utimes(stray, when, when);

    const removed = await pruneUnreferencedShowcasePhotos([], []);

    expect(removed).toBe(0);
    expect(existsSync(stray)).toBe(true);
  });

  it("does nothing when the directory does not exist yet", async () => {
    await rm(join(state.dir, "showcase"), { recursive: true });
    await expect(pruneUnreferencedShowcasePhotos([], [])).resolves.toBe(0);
  });
});
