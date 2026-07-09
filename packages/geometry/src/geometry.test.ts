import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extract3mfPlates, ModelParseError, parseModel } from "./index";
import { MAX_XML_BYTES, parseXml } from "./xml";

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

  it("parses split 3MF projects with geometry outside the main model part", () => {
    const mainModel = `<?xml version="1.0" encoding="UTF-8"?>
      <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
        <resources>
          <object id="1" type="model">
            <components><component objectid="100"/></components>
          </object>
        </resources>
        <build><item objectid="1"/></build>
      </model>`;
    const objectModel = `<?xml version="1.0" encoding="UTF-8"?>
      <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
        <resources>
          <object id="100" type="model">
            <mesh>
              <vertices>
                <vertex x="0" y="0" z="0"/>
                <vertex x="20" y="0" z="0"/>
                <vertex x="0" y="20" z="0"/>
              </vertices>
              <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
            </mesh>
          </object>
        </resources>
      </model>`;
    const archive = Buffer.from(
      zipSync({
        "[Content_Types].xml": strToU8("<Types/>"),
        "3D/3dmodel.model": strToU8(mainModel),
        "3D/Objects/object_1.model": strToU8(objectModel),
      }),
    );

    const model = parseModel(archive, "3mf");

    expect(model.triangleCount).toBe(1);
    expect(model.bboxMm).toEqual({ x: 20, y: 20, z: 0 });
  });

  it("extracts Bambu-style 3MF plates as normalized STL models", () => {
    const mainModel = `<?xml version="1.0" encoding="UTF-8"?>
      <model unit="millimeter"
        xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
        xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
        <resources>
          <object id="1" type="model">
            <components><component p:path="/3D/Objects/object_1.model" objectid="10"/></components>
          </object>
          <object id="2" type="model">
            <components><component p:path="/3D/Objects/object_2.model" objectid="20"/></components>
          </object>
        </resources>
        <build>
          <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
          <item objectid="2" transform="1 0 0 0 1 0 0 0 1 300 0 0"/>
        </build>
      </model>`;
    const objectModel = (id: number) => `<?xml version="1.0" encoding="UTF-8"?>
      <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
        <resources>
          <object id="${id}" type="model">
            <mesh>
              <vertices>
                <vertex x="0" y="0" z="0"/>
                <vertex x="20" y="0" z="0"/>
                <vertex x="0" y="20" z="0"/>
                <vertex x="0" y="0" z="20"/>
              </vertices>
              <triangles>
                <triangle v1="0" v2="2" v3="1"/>
                <triangle v1="0" v2="1" v3="3"/>
                <triangle v1="1" v2="2" v3="3"/>
                <triangle v1="2" v2="0" v3="3"/>
              </triangles>
            </mesh>
          </object>
        </resources>
      </model>`;
    const settings = `<?xml version="1.0" encoding="UTF-8"?>
      <config>
        <object id="2"><metadata key="enable_support" value="1"/></object>
        <plate>
          <metadata key="plater_id" value="1"/>
          <model_instance><metadata key="object_id" value="1"/></model_instance>
        </plate>
        <plate>
          <metadata key="plater_id" value="2"/>
          <model_instance><metadata key="object_id" value="2"/></model_instance>
        </plate>
      </config>`;
    const archive = Buffer.from(
      zipSync({
        "[Content_Types].xml": strToU8("<Types/>"),
        "3D/3dmodel.model": strToU8(mainModel),
        "3D/Objects/object_1.model": strToU8(objectModel(10)),
        "3D/Objects/object_2.model": strToU8(objectModel(20)),
        "Metadata/model_settings.config": strToU8(settings),
      }),
    );

    const full = parseModel(archive, "3mf");
    const plates = extract3mfPlates(archive);

    expect(full.bboxMm.x).toBeCloseTo(320, 3);
    expect(plates).toHaveLength(2);
    expect(plates.map((plate) => plate.configuredSupports)).toEqual([false, true]);
    for (const plate of plates) {
      expect(plate.model.bboxMm).toEqual({ x: 20, y: 20, z: 20 });
      expect(parseModel(plate.stl, "stl").bboxMm).toEqual({ x: 20, y: 20, z: 20 });
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

  it("rejects XML models carrying a DOCTYPE (billion-laughs guard)", () => {
    // Classic entity-expansion bomb: without the DOCTYPE rejection xmldom
    // would happily expand internal entities during parsing.
    const bomb = Buffer.from(
      [
        '<?xml version="1.0"?>',
        "<!DOCTYPE amf [",
        '<!ENTITY a "aaaaaaaaaa">',
        '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">',
        '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">',
        "]>",
        '<amf unit="millimeter"><object id="0"><mesh/></object></amf>',
      ].join("\n"),
    );
    expect(() => parseModel(bomb, "amf")).toThrowError(/DOCTYPE/);
  });

  it("rejects a DOCTYPE regardless of case or leading comments", () => {
    const sneaky = Buffer.from(
      '<?xml version="1.0"?><!-- x --><!doctype amf><amf><object><mesh/></object></amf>',
    );
    expect(() => parseModel(sneaky, "amf")).toThrowError(/DOCTYPE/);
  });
});

describe("parseXml guards", () => {
  it("rejects XML text above MAX_XML_BYTES before DOM parsing", () => {
    // Padding inside a comment keeps the document trivially small for the DOM
    // if the size guard were ever bypassed — the test must not depend on
    // actually parsing a 128 MB document.
    const oversized = `<!--${"x".repeat(MAX_XML_BYTES)}--><amf/>`;
    expect(() => parseXml(oversized, "test")).toThrowError(/exceeds/);
  });
});
