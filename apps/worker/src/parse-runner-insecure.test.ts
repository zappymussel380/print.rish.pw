import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ dir: "" }));

// ALLOW_INSECURE_SLICER is the repo's local-dev escape hatch for running
// untrusted children without the setpriv identity drop (root checkouts under
// /root are unreadable to the parser uid). The runner must honor it so the
// local HTTP flow harness can run; production never sets it (NODE_ENV guard).
vi.mock("./config.js", () => ({
  config: {
    get parseWorkRoot() {
      return join(state.dir, "work");
    },
    parseTimeoutMs: 60_000,
    parserUid: 1003,
    parserGid: 3100,
    maxUploadBytes: 10 * 1024 * 1024,
    thumbSize: 64,
    allowInsecureSlicer: true,
  },
}));

const { removeParseWorkDir, runPreparedParse } = await import("./parse-runner");

describe("runPreparedParse under ALLOW_INSECURE_SLICER", () => {
  beforeEach(async () => {
    state.dir = await mkdtemp(join(tmpdir(), "print-parse-insecure-"));
  });
  afterEach(async () => {
    if (state.dir) await rm(state.dir, { recursive: true, force: true });
    state.dir = "";
  });

  it("skips the identity drop so a root dev checkout can still parse", async () => {
    const contents = await readFile(
      resolve(process.cwd(), "../../packages/geometry/fixtures", "cube.stl"),
    );
    const sourcePath = join(state.dir, "upload.bin");
    await writeFile(sourcePath, contents);

    const prepared = await runPreparedParse(
      {
        jobId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        sourcePath,
        sizeBytes: contents.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
        originalName: "cube.stl",
        format: "stl",
      },
      {
        childCommand: [
          resolve(process.cwd(), "node_modules/.bin/tsx"),
          resolve(process.cwd(), "src/parse-child.ts"),
        ],
      },
    );
    try {
      expect(prepared.result.models[0]).toMatchObject({ originalName: "cube.stl" });
    } finally {
      await removeParseWorkDir(prepared.workDir);
    }
  });
});
