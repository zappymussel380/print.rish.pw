import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isZip, parseModel } from "@print/geometry";
import { prepareUploadModels } from "./upload-prepare";

function fixture(name: string): Promise<Buffer> {
  return readFile(resolve(process.cwd(), "../../packages/geometry/fixtures", name));
}

describe("worker upload preparation", () => {
  it("canonicalizes an archive to the exact STL bytes the worker persists", async () => {
    const archive = await fixture("cube.3mf");
    const sourceSha256 = createHash("sha256").update(archive).digest("hex");

    const prepared = prepareUploadModels({
      contents: archive,
      originalName: "customer-cube.3mf",
      format: "3mf",
      sourceSha256,
    });

    expect(prepared.models).toHaveLength(1);
    const model = prepared.models[0]!;
    expect(model).toMatchObject({
      originalName: "customer-cube.stl",
      format: "stl",
      derived: true,
    });
    expect(isZip(model.contents)).toBe(false);
    expect(model.fileHash).toBe(createHash("sha256").update(model.contents).digest("hex"));
    expect(model.fileHash).not.toBe(sourceSha256);
    expect(parseModel(model.contents, "stl").bboxMm).toEqual({ x: 20, y: 20, z: 20 });
  });

  it("retains raw model bytes and the streaming transport hash", async () => {
    const contents = await fixture("cube.obj");
    const sourceSha256 = createHash("sha256").update(contents).digest("hex");

    const prepared = prepareUploadModels({
      contents,
      originalName: "cube.obj",
      format: "obj",
      sourceSha256,
    });

    expect(prepared.totalBytes).toBe(contents.length);
    expect(prepared.models[0]).toMatchObject({
      originalName: "cube.obj",
      format: "obj",
      derived: false,
      fileHash: sourceSha256,
      sizeBytes: contents.length,
    });
    expect(prepared.models[0]!.contents).toBe(contents);
  });
});
