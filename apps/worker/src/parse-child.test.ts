import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelParseError } from "@print/geometry";
import { parseChildOutputSchema, type ParseChildParams } from "@print/shared";
import { executeParseChild, ParseChildPublicError } from "./parse-child";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let dir = "";

function fixture(name: string): Promise<Buffer> {
  return readFile(resolve(process.cwd(), "../../packages/geometry/fixtures", name));
}

async function stage(contents: Buffer): Promise<{ inputPath: string; outDir: string }> {
  const inputPath = join(dir, "input", "model.bin");
  await writeFile(inputPath, contents);
  return { inputPath, outDir: join(dir, "out") };
}

function prepareParams(
  staged: { inputPath: string; outDir: string },
  contents: Buffer,
  overrides: Partial<Extract<ParseChildParams, { mode: "prepare" }>> = {},
): ParseChildParams {
  return {
    mode: "prepare",
    inputPath: staged.inputPath,
    originalName: "cube.stl",
    format: "stl",
    sourceSha256: createHash("sha256").update(contents).digest("hex"),
    outDir: staged.outDir,
    thumbSize: 64,
    maxUploadBytes: 10 * 1024 * 1024,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "print-parse-child-"));
  await mkdir(join(dir, "input"));
  await mkdir(join(dir, "out"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

describe("executeParseChild prepare mode", () => {
  it("writes canonical bytes and a thumbnail and reports untrusted-safe metadata", async () => {
    const contents = await fixture("cube.stl");
    const staged = await stage(contents);

    const result = await executeParseChild(prepareParams(staged, contents));

    expect(result.models).toHaveLength(1);
    const model = result.models[0]!;
    expect(model).toMatchObject({
      fileName: "model-0.stl",
      thumbFile: "thumb-0.png",
      originalName: "cube.stl",
      format: "stl",
      derived: false,
      sizeBytes: contents.length,
      triangleCount: 12,
      bboxMm: { x: 20, y: 20, z: 20 },
    });
    expect(model.fileHash).toBe(createHash("sha256").update(contents).digest("hex"));
    await expect(readFile(join(staged.outDir, "model-0.stl"))).resolves.toEqual(contents);
    const thumb = await readFile(join(staged.outDir, "thumb-0.png"));
    expect(thumb.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(parseChildOutputSchema.parse(result)).toEqual(result);
  });

  it("canonicalizes archives so only derived STL bytes leave the sandbox", async () => {
    const contents = await fixture("cube.3mf");
    const staged = await stage(contents);

    const result = await executeParseChild(
      prepareParams(staged, contents, { originalName: "cube.3mf", format: "3mf" }),
    );

    const model = result.models[0]!;
    expect(model).toMatchObject({ format: "stl", derived: true, fileName: "model-0.stl" });
    expect(model.fileHash).not.toBe(createHash("sha256").update(contents).digest("hex"));
    const written = await readFile(join(staged.outDir, model.fileName));
    expect(written.length).toBe(model.sizeBytes);
  });

  it("converts STEP uploads into a derived canonical STL", async () => {
    const stepContents = await readFile(resolve(process.cwd(), "test-fixtures", "box.step"));
    const cube = await fixture("cube.stl");
    const staged = await stage(stepContents);
    const payload = join(dir, "payload.stl");
    await writeFile(payload, cube);
    const fakeOcct = join(dir, "fake-occt.sh");
    await writeFile(
      fakeOcct,
      `#!/bin/bash\nSCRIPT="\${@: -1}"\ncat ${payload} > "$(dirname "$SCRIPT")/step-converted.stl"\necho STEP_CONVERT_OK\n`,
      { mode: 0o755 },
    );

    const result = await executeParseChild(
      prepareParams(staged, stepContents, {
        originalName: "box.step",
        format: "step",
        stepConvertBin: fakeOcct,
      }),
    );

    expect(result.models).toHaveLength(1);
    const model = result.models[0]!;
    expect(model).toMatchObject({
      format: "stl",
      derived: true,
      fileName: "model-0.stl",
      originalName: "box.stl",
      thumbFile: "thumb-0.png",
    });
    const written = await readFile(join(staged.outDir, model.fileName));
    expect(written.equals(cube)).toBe(true);
    expect(model.fileHash).toBe(createHash("sha256").update(cube).digest("hex"));
  });

  it("reports STEP converter failures with their public code", async () => {
    const stepContents = await readFile(resolve(process.cwd(), "test-fixtures", "box.step"));
    const staged = await stage(stepContents);
    const fakeOcct = join(dir, "fake-occt-broken.sh");
    await writeFile(fakeOcct, "#!/bin/bash\nexit 0\n", { mode: 0o755 });

    const attempt = executeParseChild(
      prepareParams(staged, stepContents, {
        originalName: "box.step",
        format: "step",
        stepConvertBin: fakeOcct,
      }),
    );
    await expect(attempt).rejects.toMatchObject({
      name: "ParseChildPublicError",
      publicCode: "STEP_CONVERT_FAILED",
    });
  });

  it("propagates parse rejections for malformed models", async () => {
    const contents = Buffer.from("not an STL");
    const staged = await stage(contents);

    await expect(executeParseChild(prepareParams(staged, contents))).rejects.toBeInstanceOf(
      ModelParseError,
    );
  });

  it("refuses to write canonical files past the upload limit", async () => {
    // A small deflated archive can expand into a canonical STL far larger
    // than the uploaded bytes; the child must not write it to the shared
    // tmpfs. Repeat the cube's triangles until the derived STL exceeds the
    // limit while the compressed upload stays tiny.
    const { strToU8, unzipSync, zipSync } = await import("fflate");
    const archive = await fixture("cube.3mf");
    const xml = Buffer.from(unzipSync(new Uint8Array(archive))["3D/3dmodel.model"]!).toString();
    const triangles = xml.match(/<triangle[^>]*\/>/g)!.join("");
    const inflated = xml.replace("</triangles>", `${triangles.repeat(400)}</triangles>`);
    const bomb = Buffer.from(
      zipSync({ "3D/3dmodel.model": strToU8(inflated) }, { level: 9 }),
    );
    expect(bomb.length).toBeLessThan(100_000);
    const staged = await stage(bomb);

    const attempt = executeParseChild(
      prepareParams(staged, bomb, {
        originalName: "bomb.3mf",
        format: "3mf",
        maxUploadBytes: 100_000,
      }),
    );

    await expect(attempt).rejects.toBeInstanceOf(ParseChildPublicError);
    await expect(attempt).rejects.toMatchObject({ publicCode: "FILE_TOO_LARGE" });
  });
});

describe("executeParseChild thumbnail mode", () => {
  it("renders a PNG for a stored model", async () => {
    const contents = await fixture("cube.stl");
    const staged = await stage(contents);
    const outPath = join(staged.outDir, "thumb.png");

    await executeParseChild({
      mode: "thumbnail",
      inputPath: staged.inputPath,
      format: "stl",
      outPath,
      thumbSize: 64,
      maxUploadBytes: 10 * 1024 * 1024,
    });

    const thumb = await readFile(outPath);
    expect(thumb.subarray(0, 4)).toEqual(PNG_MAGIC);
  });
});

describe("parse-child CLI", () => {
  async function runCli(params: ParseChildParams): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }> {
    return await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(
        resolve(process.cwd(), "node_modules/.bin/tsx"),
        ["src/parse-child.ts", JSON.stringify(params)],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
      child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
      child.once("error", rejectPromise);
      child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
    });
  }

  it("prints a schema-valid success line and exits zero", async () => {
    const contents = await fixture("cube.stl");
    const staged = await stage(contents);

    const run = await runCli(prepareParams(staged, contents));

    expect(run.code).toBe(0);
    const output = parseChildOutputSchema.parse(JSON.parse(run.stdout));
    expect(output.ok).toBe(true);
  });

  it("reports customer-safe parse failures as JSON with a non-zero exit", async () => {
    const contents = Buffer.from("not an STL");
    const staged = await stage(contents);

    const run = await runCli(prepareParams(staged, contents));

    expect(run.code).toBe(64);
    const output = parseChildOutputSchema.parse(JSON.parse(run.stdout));
    expect(output).toMatchObject({
      ok: false,
      publicCode: "INVALID_MODEL_MALFORMED",
    });
  });

  it("exits with an internal code for invalid parameters without leaking JSON", async () => {
    const child = spawn(
      resolve(process.cwd(), "node_modules/.bin/tsx"),
      ["src/parse-child.ts", "{\"mode\":\"nope\"}"],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const code = await new Promise((resolvePromise) => child.once("close", resolvePromise));
    expect(code).toBe(70);
  });
});
