import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL_CONFIG } from "@print/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const stubFixture = vi.hoisted(() => ({ workRoot: "" }));

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      stubSlicer: true,
      get workRoot() {
        return stubFixture.workRoot;
      },
    },
  };
});

import { runSlice } from "./orca";

const settings = {
  material: DEFAULT_MODEL_CONFIG.material,
  layerHeightUm: DEFAULT_MODEL_CONFIG.layerHeightUm,
  infillPct: DEFAULT_MODEL_CONFIG.infillPct,
  supports: DEFAULT_MODEL_CONFIG.supports,
};
const identity = { uid: 1002, gid: 3000 };

afterEach(async () => {
  if (stubFixture.workRoot) {
    await rm(stubFixture.workRoot, { recursive: true, force: true });
    stubFixture.workRoot = "";
  }
});

describe("runSlice stub mode", () => {
  it("stages and hashes the database-owned file before returning synthetic stats", async () => {
    stubFixture.workRoot = await mkdtemp(join(tmpdir(), "print-orca-stub-"));
    const source = join(stubFixture.workRoot, "source.stl");
    const contents = Buffer.from("verified stub input");
    await writeFile(source, contents, { mode: 0o600 });
    const workDir = join(stubFixture.workRoot, "job");

    const outcome = await runSlice(
      {
        storedPath: source,
        fileHash: createHash("sha256").update(contents).digest("hex"),
        sizeBytes: contents.length,
        format: "stl",
      },
      settings,
      workDir,
      identity,
    );

    expect(outcome).toMatchObject({
      ok: true,
      filamentGrams: 5,
      slicerVersion: "stub-slicer-v1",
      rawMeta: { stubSlicer: true },
    });
    await expect(readFile(join(workDir, "input", "model.stl"))).resolves.toEqual(contents);
  });

  it("rejects a file whose contents do not match the queued hash", async () => {
    stubFixture.workRoot = await mkdtemp(join(tmpdir(), "print-orca-stub-"));
    const source = join(stubFixture.workRoot, "source.stl");
    const contents = Buffer.from("tampered stub input");
    await writeFile(source, contents, { mode: 0o600 });

    await expect(
      runSlice(
        {
          storedPath: source,
          fileHash: "0".repeat(64),
          sizeBytes: contents.length,
          format: "stl",
        },
        settings,
        join(stubFixture.workRoot, "job"),
        identity,
      ),
    ).rejects.toThrow(/hash changed/);
  });
});
