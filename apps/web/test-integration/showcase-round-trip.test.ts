import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { integrationConnection } from "./support/connections";

const webConnection = integrationConnection("DATABASE_URL", "print_web");

const storageRoot = await mkdtemp(join(tmpdir(), "print-showcase-integration-"));
const uploadDir = join(storageRoot, "uploads");
process.env.UPLOAD_DIR = uploadDir;
process.env.PDF_DIR = join(storageRoot, "pdfs");
process.env.DATABASE_URL = webConnection.url;
await mkdir(join(uploadDir, "showcase"), { recursive: true });
await mkdir(process.env.PDF_DIR, { recursive: true });

delete (globalThis as { prisma?: unknown }).prisma;
const { prisma } = await import("@print/db");
const { getRecentPrints, saveRecentPrints, RECENT_PRINTS_KEY } = await import(
  "@/lib/recent-prints"
);
const { showcasePath } = await import("@/lib/storage");
const { pruneUnreferencedShowcasePhotos } = await import("@/lib/showcase-photos");
const { sanitizeImage } = await import("@/lib/image-sanitize");
const { GET: getPhoto } = await import("@/app/api/showcase/[id]/photo/route");
const { GET: getShowcase } = await import("@/app/api/showcase/route");

/** A real 1x1 PNG carrying a tEXt chunk, so the sanitiser has work to do. */
const rawPhoto = () =>
  Buffer.concat([
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    ),
  ]);

const req = () => ({}) as unknown as NextRequest;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: RECENT_PRINTS_KEY } }).catch(() => {});
});

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: RECENT_PRINTS_KEY } }).catch(() => {});
  await rm(storageRoot, { recursive: true, force: true });
});

describe("recent-prints showcase against a real database and disk", () => {
  it("round-trips a print through Postgres and serves its photo bytes back", async () => {
    const id = randomUUID();
    const photo = sanitizeImage(rawPhoto());
    await writeFile(showcasePath(id, photo.kind), photo.bytes, { flag: "wx", mode: 0o600 });

    const saved = await saveRecentPrints({
      prints: [{ id, caption: "Cable clip", material: "PETG", photoExt: photo.kind }],
    });
    expect(saved).toHaveLength(1);

    // Read back through a fresh query, not the in-memory value.
    const row = await prisma.appSetting.findUnique({ where: { key: RECENT_PRINTS_KEY } });
    expect(row).not.toBeNull();
    expect((row!.value as { prints: { caption: string }[] }).prints[0]!.caption).toBe("Cable clip");

    const res = await getPhoto(req(), ctx(id));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    const served = Buffer.from(await res.arrayBuffer());
    expect(served).toEqual(photo.bytes);
  });

  it("publishes the saved showcase on the public endpoint", async () => {
    const id = randomUUID();
    const photo = sanitizeImage(rawPhoto());
    await writeFile(showcasePath(id, photo.kind), photo.bytes, { flag: "wx", mode: 0o600 });
    await saveRecentPrints({
      prints: [{ id, caption: "Bench block", material: "PLA", colour: "Matte black", photoExt: photo.kind }],
    });

    const res = await getShowcase();
    const body = (await res.json()) as { prints: { id: string; colour?: string }[] };

    expect(res.headers.get("Cache-Control")).toContain("public");
    expect(body.prints.map((p) => p.id)).toContain(id);
    expect(body.prints[0]!.colour).toBe("Matte black");
  });

  it("deletes the photo from disk when the print is removed from the list", async () => {
    const kept = randomUUID();
    const dropped = randomUUID();
    const photo = sanitizeImage(rawPhoto());
    for (const id of [kept, dropped]) {
      await writeFile(showcasePath(id, photo.kind), photo.bytes, { flag: "wx", mode: 0o600 });
    }
    const before = await saveRecentPrints({
      prints: [kept, dropped].map((id) => ({
        id,
        caption: `Print ${id.slice(0, 4)}`,
        material: "PLA",
        photoExt: photo.kind,
      })),
    });

    const after = await saveRecentPrints({
      prints: [{ id: kept, caption: "Kept", material: "PLA", photoExt: photo.kind }],
    });
    await pruneUnreferencedShowcasePhotos(after, before);

    expect(existsSync(showcasePath(kept, photo.kind))).toBe(true);
    expect(existsSync(showcasePath(dropped, photo.kind))).toBe(false);
    // And the removed print stops being served.
    expect((await getPhoto(req(), ctx(dropped))).status).toBe(404);
  });

  it("survives a corrupt stored value rather than taking the homepage down", async () => {
    await prisma.appSetting.upsert({
      where: { key: RECENT_PRINTS_KEY },
      create: { key: RECENT_PRINTS_KEY, value: { prints: "not a list" } },
      update: { value: { prints: "not a list" } },
    });

    await expect(getRecentPrints()).resolves.toEqual([]);
    expect((await getShowcase()).status).toBe(200);
  });

  it("keeps a photo whose bytes are gone out of the served page", async () => {
    const id = randomUUID();
    const photo = sanitizeImage(rawPhoto());
    await writeFile(showcasePath(id, photo.kind), photo.bytes, { flag: "wx", mode: 0o600 });
    await saveRecentPrints({
      prints: [{ id, caption: "Vanishing", material: "PLA", photoExt: photo.kind }],
    });
    await rm(showcasePath(id, photo.kind));

    // The row still lists it, but the route must 404 rather than throw.
    expect((await getPhoto(req(), ctx(id))).status).toBe(404);
  });
});
