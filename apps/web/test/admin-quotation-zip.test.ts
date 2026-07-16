import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ findUnique: vi.fn() }));

const opened = vi.hoisted(
  () => [] as Array<{ path: string; handle: { close: ReturnType<typeof vi.fn> } }>,
);

const storage = vi.hoisted(() => ({
  modelPath: vi.fn((id: string, format: string) => `MODELDIR/${id}.${format}`),
  sourceStepPath: vi.fn((id: string) => `MODELDIR/${id}.step`),
  pdfPath: vi.fn((number: string) => `PDFDIR/${number}.pdf`),
  openPrivateFile: vi.fn(),
}));

const requireAdminApi = vi.hoisted(() => vi.fn(async (): Promise<Response | null> => null));

vi.mock("@print/db", () => ({ prisma: { quotation: { findUnique: db.findUnique } } }));
vi.mock("@/lib/storage", () => storage);
vi.mock("@/lib/env", () => ({ env: { maxUploadBytes: 250 * 1024 * 1024 } }));
vi.mock("@/lib/api-util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-util")>();
  return {
    contentDispositionFilename: actual.contentDispositionFilename,
    requireAdminApi,
    jsonError: (status: number, code: string, message: string) =>
      Response.json({ error: { code, message } }, { status }),
  };
});

const { GET } = await import("@/app/api/admin/quotations/[id]/zip/route");

const QUOTE_ID = "3f9f6d3e-9d2f-4a7e-8f6a-2b1c9d8e7f6a";

let dir: string;
const bytes: Record<string, Buffer> = {
  "model-1.stl": Buffer.from("STL BYTES ONE"),
  "model-2.stl": Buffer.from("STL BYTES TWO, LONGER"),
  "model-4.stl": Buffer.from("CONVERTED STL FROM STEP"),
  "model-4.step": Buffer.from("ISO-10303-21; original CAD source"),
  "model-5.stl": Buffer.from("CONVERTED BUT SOURCE LOST"),
  "model-3.3mf": Buffer.from("PK fake 3mf container"),
  "RSP-2026-0002.pdf": Buffer.from("%PDF-1.7 fake quotation pdf"),
};

function item(modelId: string, originalName: string, format: string, storedPath: string | null) {
  const file = bytes[`${modelId}.${format}`];
  return {
    modelId,
    model: {
      id: modelId,
      originalName,
      format,
      sizeBytes: file ? file.length : 123,
      storedPath,
    },
  };
}

const quotation = {
  id: QUOTE_ID,
  number: "RSP-2026-0002",
  items: [
    item("model-1", "part.stl", "stl", "stored"),
    item("model-2", "part.stl", "stl", "stored"),
    item("model-3", "thing.3mf", "3mf", "stored"),
  ],
};

function request(): NextRequest {
  return new Request(`https://print.rish.pw/api/admin/quotations/${QUOTE_ID}/zip`) as NextRequest;
}

const ctx = { params: Promise.resolve({ id: QUOTE_ID }) };

async function collect(response: Response): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  const reader = response.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return Buffer.concat(parts);
}

describe("admin quotation ZIP download", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "zip-test-"));
    for (const [name, data] of Object.entries(bytes)) {
      await writeFile(join(dir, name), data);
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    opened.length = 0;
    db.findUnique.mockResolvedValue(quotation);
    requireAdminApi.mockResolvedValue(null);
    storage.openPrivateFile.mockImplementation(async (path: string) => {
      const real = join(dir, path.replace(/^(MODELDIR|PDFDIR)\//, ""));
      const handle = await open(real, "r");
      const size = (await handle.stat()).size;
      const tracked = { path, handle };
      vi.spyOn(handle, "close");
      opened.push(tracked as never);
      return { handle, size };
    });
  });

  it("includes the original STEP source beside the converted mesh", async () => {
    db.findUnique.mockResolvedValue({
      id: QUOTE_ID,
      number: "RSP-2026-0002",
      items: [
        {
          modelId: "model-4",
          model: {
            id: "model-4",
            originalName: "bracket.stl",
            format: "stl",
            sourceFormat: "step",
            sizeBytes: bytes["model-4.stl"]!.length,
            storedPath: "stored",
          },
        },
        {
          modelId: "model-5",
          model: {
            id: "model-5",
            originalName: "gone.stl",
            format: "stl",
            sourceFormat: "step",
            sizeBytes: bytes["model-5.stl"]!.length,
            storedPath: "stored",
          },
        },
      ],
    });

    const response = await GET(request(), ctx);

    expect(response.status).toBe(200);
    const zip = unzipSync(await collect(response));
    expect(Object.keys(zip).sort()).toEqual([
      "MISSING_FILES.txt",
      "RSP-2026-0002.pdf",
      "bracket.step",
      "bracket.stl",
      "gone.stl",
    ]);
    expect(Buffer.from(zip["bracket.step"]!)).toEqual(bytes["model-4.step"]);
    expect(Buffer.from(zip["bracket.stl"]!)).toEqual(bytes["model-4.stl"]);
    expect(Buffer.from(zip["MISSING_FILES.txt"]!).toString()).toContain("gone.step");
  });

  it("streams a zip of deduped model files plus the quotation PDF", async () => {
    const response = await GET(request(), ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toContain("RSP-2026-0002.zip");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");

    const unzipped = unzipSync(new Uint8Array(await collect(response)));
    expect(Object.keys(unzipped).sort()).toEqual([
      "RSP-2026-0002.pdf",
      "part (2).stl",
      "part.stl",
      "thing.3mf",
    ]);
    expect(Buffer.from(unzipped["part.stl"]!)).toEqual(bytes["model-1.stl"]);
    expect(Buffer.from(unzipped["part (2).stl"]!)).toEqual(bytes["model-2.stl"]);
    expect(Buffer.from(unzipped["thing.3mf"]!)).toEqual(bytes["model-3.3mf"]);
    expect(Buffer.from(unzipped["RSP-2026-0002.pdf"]!)).toEqual(bytes["RSP-2026-0002.pdf"]);

    for (const entry of opened) expect(entry.handle.close).toHaveBeenCalled();
  });

  it("lists unavailable files in MISSING_FILES.txt instead of failing", async () => {
    db.findUnique.mockResolvedValue({
      ...quotation,
      items: [
        item("model-1", "part.stl", "stl", "stored"),
        item("model-gone", "vanished.stl", "stl", null),
      ],
    });

    const response = await GET(request(), ctx);

    expect(response.status).toBe(200);
    const unzipped = unzipSync(new Uint8Array(await collect(response)));
    expect(Object.keys(unzipped).sort()).toEqual([
      "MISSING_FILES.txt",
      "RSP-2026-0002.pdf",
      "part.stl",
    ]);
    const missingNote = Buffer.from(unzipped["MISSING_FILES.txt"]!).toString();
    expect(missingNote).toContain("vanished.stl");
  });

  it("notes a missing quotation PDF rather than erroring", async () => {
    storage.openPrivateFile.mockImplementation(async (path: string) => {
      if (path.startsWith("PDFDIR/")) throw new Error("ENOENT");
      const real = join(dir, path.replace(/^MODELDIR\//, ""));
      const handle = await open(real, "r");
      return { handle, size: (await handle.stat()).size };
    });

    const response = await GET(request(), ctx);
    const unzipped = unzipSync(new Uint8Array(await collect(response)));

    expect(Object.keys(unzipped)).toContain("MISSING_FILES.txt");
    expect(Buffer.from(unzipped["MISSING_FILES.txt"]!).toString()).toContain(
      "RSP-2026-0002.pdf",
    );
  });

  it("short-circuits when the admin gate rejects", async () => {
    requireAdminApi.mockResolvedValue(
      Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }),
    );

    const response = await GET(request(), ctx);

    expect(response.status).toBe(401);
    expect(db.findUnique).not.toHaveBeenCalled();
  });

  it("returns a uniform 404 for an unknown quotation", async () => {
    db.findUnique.mockResolvedValue(null);

    const response = await GET(request(), ctx);

    expect(response.status).toBe(404);
  });

  it("returns a uniform 404 for a malformed id", async () => {
    const response = await GET(request(), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(404);
    expect(db.findUnique).not.toHaveBeenCalled();
  });

  it("closes every open handle when the download is cancelled", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024, 7);
    await writeFile(join(dir, "model-big.stl"), big);
    db.findUnique.mockResolvedValue({
      ...quotation,
      items: [item("model-big", "big.stl", "stl", "stored")],
    });

    const response = await GET(request(), ctx);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => {
      expect(opened.length).toBeGreaterThan(0);
      for (const entry of opened) expect(entry.handle.close).toHaveBeenCalled();
    });
  });
});
