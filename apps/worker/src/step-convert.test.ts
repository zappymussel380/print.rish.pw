import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseModel } from "@print/geometry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StepConvertError, convertStepToStl } from "./step-convert.js";

const REAL_BIN = "/usr/bin/occt-draw-7.6";

let root: string;
let scratch: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "step-convert-"));
  scratch = join(root, "out");
  await mkdir(scratch);
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true });
});

async function writeStep(name = "model.step", contents?: string): Promise<string> {
  const path = join(root, name);
  await writeFile(
    path,
    contents ??
      "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
  );
  return path;
}

/** Stand-in for DRAWEXE: same argv contract (`-b -f <script.tcl>`), behavior
 * baked per script. Locates the scratch dir from the tcl path. */
async function fakeBin(body: string): Promise<string> {
  const path = join(root, `fake-${Math.random().toString(36).slice(2)}.sh`);
  await writeFile(path, `#!/bin/bash\nSCRIPT="\${@: -1}"\nSCRATCH="$(dirname "$SCRIPT")"\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function publicCodeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StepConvertError) return error.publicCode;
    throw error;
  }
  throw new Error("expected convertStepToStl to reject");
}

describe("convertStepToStl", () => {
  it("returns the produced STL bytes on success", async () => {
    const bin = await fakeBin(
      `printf 'FAKESTLBYTES' > "$SCRATCH/step-converted.stl"\necho STEP_CONVERT_OK`,
    );
    const stl = await convertStepToStl(await writeStep(), scratch, { bin });
    expect(stl.toString()).toBe("FAKESTLBYTES");
    const script = await readFile(join(scratch, "step-convert.tcl"), "utf8");
    expect(script).toContain("ReadStep");
    expect(script).toContain("incmesh");
    expect(script).toContain(join(scratch, "step-converted.stl"));
  });

  it("rejects inputs without a STEP header before spawning the converter", async () => {
    const bin = await fakeBin(`touch "$SCRATCH/invoked"`);
    const input = await writeStep("garbage.step", "solid nope\nendsolid nope\n");
    expect(await publicCodeOf(convertStepToStl(input, scratch, { bin }))).toBe("STEP_INVALID");
    expect(existsSync(join(scratch, "invoked"))).toBe(false);
  });

  it("fails honestly when the converter produces no output file", async () => {
    const bin = await fakeBin(`echo STEP_CONVERT_OK`);
    expect(await publicCodeOf(convertStepToStl(await writeStep(), scratch, { bin }))).toBe(
      "STEP_CONVERT_FAILED",
    );
  });

  it("fails honestly when the converter aborts mid-script", async () => {
    const bin = await fakeBin(`printf 'PARTIAL' > "$SCRATCH/step-converted.stl"`);
    expect(await publicCodeOf(convertStepToStl(await writeStep(), scratch, { bin }))).toBe(
      "STEP_CONVERT_FAILED",
    );
  });

  it("kills a hung converter and reports a timeout", async () => {
    const bin = await fakeBin(`sleep 30`);
    const started = Date.now();
    expect(
      await publicCodeOf(convertStepToStl(await writeStep(), scratch, { bin, timeoutMs: 250 })),
    ).toBe("STEP_CONVERT_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("caps the tessellated mesh size", async () => {
    const bin = await fakeBin(
      `head -c 2048 /dev/zero > "$SCRATCH/step-converted.stl"\necho STEP_CONVERT_OK`,
    );
    expect(
      await publicCodeOf(convertStepToStl(await writeStep(), scratch, { bin, maxStlBytes: 1024 })),
    ).toBe("STEP_MESH_TOO_LARGE");
  });
});

describe.skipIf(!existsSync(REAL_BIN))("convertStepToStl with OpenCASCADE", () => {
  it("converts the box fixture into a parseable 20×30×10 mm mesh", async () => {
    const fixture = resolve(process.cwd(), "test-fixtures", "box.step");
    const stl = await convertStepToStl(fixture, scratch, { bin: REAL_BIN });
    const parsed = parseModel(stl, "stl");
    expect(parsed.bboxMm.x).toBeCloseTo(20, 1);
    expect(parsed.bboxMm.y).toBeCloseTo(30, 1);
    expect(parsed.bboxMm.z).toBeCloseTo(10, 1);
    expect(parsed.triangleCount).toBeGreaterThanOrEqual(12);
  });
});
