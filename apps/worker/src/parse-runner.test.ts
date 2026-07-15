import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ParseRunnerPublicError,
  removeParseWorkDir,
  renderThumbnailIsolated,
  runPreparedParse,
} from "./parse-runner";

const JOB_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let dir = "";
let workRoot = "";

function fixture(name: string): Promise<Buffer> {
  return readFile(resolve(process.cwd(), "../../packages/geometry/fixtures", name));
}

const realChild = [
  resolve(process.cwd(), "node_modules/.bin/tsx"),
  resolve(process.cwd(), "src/parse-child.ts"),
];

/** A stand-in child: runs `script` with the params JSON as its last argv. */
function fakeChild(script: string): string[] {
  return [process.execPath, "-e", script];
}

async function stageSource(contents: Buffer): Promise<string> {
  const path = join(dir, "upload.bin");
  await writeFile(path, contents);
  return path;
}

function inputFor(contents: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    jobId: JOB_ID,
    sourcePath: join(dir, "upload.bin"),
    sizeBytes: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
    originalName: "cube.stl",
    format: "stl" as const,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "print-parse-runner-"));
  workRoot = join(dir, "work");
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

describe("runPreparedParse", () => {
  it("stages, spawns the real child, and returns validated metadata and files", async () => {
    const contents = await fixture("cube.stl");
    await stageSource(contents);

    const prepared = await runPreparedParse(inputFor(contents), {
      childCommand: realChild, sandbox: false,
      workRoot,
    });
    try {
      expect(prepared.result.models).toHaveLength(1);
      const model = prepared.result.models[0]!;
      expect(model).toMatchObject({
        originalName: "cube.stl",
        format: "stl",
        derived: false,
        triangleCount: 12,
      });
      await expect(readFile(join(prepared.outDir, model.fileName))).resolves.toEqual(contents);
      const thumb = await readFile(join(prepared.outDir, model.thumbFile!));
      expect(thumb.subarray(0, 4)).toEqual(PNG_MAGIC);
    } finally {
      await removeParseWorkDir(prepared.workDir);
    }
    await expect(readFile(join(workRoot, JOB_ID, "out", "model-0.stl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to stage a source whose hash does not match the queued metadata", async () => {
    const contents = await fixture("cube.stl");
    await stageSource(contents);

    await expect(
      runPreparedParse(inputFor(contents, { sha256: "0".repeat(64) }), {
        childCommand: realChild, sandbox: false,
        workRoot,
      }),
    ).rejects.toThrow(/hash/i);
  });

  it("surfaces the child's customer-safe failure as a public error", async () => {
    const contents = Buffer.from("not an STL");
    await stageSource(contents);

    await expect(
      runPreparedParse(inputFor(contents), { childCommand: realChild, workRoot, sandbox: false }),
    ).rejects.toMatchObject({
      failure: { code: "INVALID_MODEL_MALFORMED" },
    });
  });

  it("rejects a child that prints garbage instead of contract JSON", async () => {
    const contents = await fixture("cube.stl");
    await stageSource(contents);

    await expect(
      runPreparedParse(inputFor(contents), {
        childCommand: fakeChild("console.log('junk'); process.exit(0);"),
        workRoot,
      }),
    ).rejects.toThrow(/contract/i);
  });

  it("rejects declared output files that are symlinks or lie about their size", async () => {
    const contents = await fixture("cube.stl");
    await stageSource(contents);
    const lyingChild = fakeChild(`
      const { symlinkSync } = require("node:fs");
      const { join } = require("node:path");
      const params = JSON.parse(process.argv.at(-1));
      symlinkSync("/etc/passwd", join(params.outDir, "model-0.stl"));
      console.log(JSON.stringify({
        ok: true,
        totalBytes: 10,
        models: [{
          fileName: "model-0.stl", thumbFile: null, originalName: "cube.stl",
          format: "stl", fileHash: "${"a".repeat(64)}", sizeBytes: 10, derived: false,
          bboxMm: { x: 1, y: 1, z: 1 }, volumeCm3: 1, triangleCount: 12,
        }],
      }));
    `);

    await expect(
      runPreparedParse(inputFor(contents), { childCommand: lyingChild, workRoot }),
    ).rejects.toThrow();
  });

  it("kills a wedged child at the timeout instead of waiting forever", async () => {
    const contents = await fixture("cube.stl");
    await stageSource(contents);

    await expect(
      runPreparedParse(inputFor(contents), {
        childCommand: fakeChild("setTimeout(() => {}, 120000);"),
        workRoot,
        timeoutMs: 500,
      }),
    ).rejects.toThrow(/timed out/i);
  }, 15_000);
});

describe("renderThumbnailIsolated", () => {
  it("returns PNG bytes for a stored model", async () => {
    const contents = await fixture("cube.stl");
    await stageSource(contents);

    const png = await renderThumbnailIsolated(
      {
        jobId: JOB_ID,
        sourcePath: join(dir, "upload.bin"),
        sizeBytes: contents.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
        format: "stl",
      },
      { childCommand: realChild, workRoot, sandbox: false },
    );

    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
    await expect(readFile(join(workRoot, JOB_ID))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("error types", () => {
  it("keeps public failures distinguishable for the ingest processor", () => {
    const error = new ParseRunnerPublicError({ code: "FILE_TOO_LARGE", message: "too big" });
    expect(error.failure.code).toBe("FILE_TOO_LARGE");
  });
});
