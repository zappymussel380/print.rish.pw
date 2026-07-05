import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelParseError, parseModel } from "./index";

const fixture = (name: string) => readFileSync(join(__dirname, "..", "fixtures", name));

const cases = [
  ["binary STL", "cube.stl", "stl"],
  ["ASCII STL", "cube-ascii.stl", "stl"],
  ["OBJ", "cube.obj", "obj"],
  ["3MF", "cube.3mf", "3mf"],
  ["AMF", "cube.amf", "amf"],
] as const;

describe("parseModel", () => {
  it.each(cases)("parses a 20 mm cube from %s", (_label, file, format) => {
    const model = parseModel(fixture(file), format);
    expect(model.triangleCount).toBe(12);
    expect(model.bboxMm.x).toBeCloseTo(20, 3);
    expect(model.bboxMm.y).toBeCloseTo(20, 3);
    expect(model.bboxMm.z).toBeCloseTo(20, 3);
    expect(model.volumeCm3).toBeCloseTo(8, 3);
  });

  it("rejects zip bombs in 3MF containers", () => {
    expect(() => parseModel(fixture("bomb.3mf"), "3mf")).toThrowError(ModelParseError);
    try {
      parseModel(fixture("bomb.3mf"), "3mf");
    } catch (err) {
      expect((err as ModelParseError).code).toBe("ZIP_BOMB");
    }
  });

  it("rejects garbage bytes for every format", () => {
    const garbage = Buffer.from("not a model at all, sorry");
    for (const format of ["stl", "obj", "3mf", "amf"] as const) {
      expect(() => parseModel(garbage, format)).toThrowError(ModelParseError);
    }
  });

  it("rejects truncated binary STL", () => {
    const cube = fixture("cube.stl");
    expect(() => parseModel(cube.subarray(0, cube.length - 10), "stl")).toThrowError(
      ModelParseError,
    );
  });

  it("rejects unknown formats", () => {
    expect(() => parseModel(fixture("cube.stl"), "step")).toThrowError(ModelParseError);
  });

  it("fan-triangulates OBJ quads", () => {
    const quad = Buffer.from(
      ["v 0 0 0", "v 10 0 0", "v 10 10 0", "v 0 10 0", "f 1 2 3 4"].join("\n"),
    );
    const model = parseModel(quad, "obj");
    expect(model.triangleCount).toBe(2);
    expect(model.bboxMm).toEqual({ x: 10, y: 10, z: 0 });
  });
});
