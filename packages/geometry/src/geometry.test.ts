import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  extract3mfPlates,
  extract3mfSourceConfig,
  inspect3mfUpload,
  MAX_3MF_PLATES,
  ModelParseError,
  parseModel,
} from "./index";
import {
  MAX_SKELETON_ELEMENTS,
  MAX_XML_BYTES,
  MAX_XML_DEPTH,
  MAX_XML_ELEMENTS,
  parseXml,
} from "./xml";
import { extractZipEntries, MAX_ZIP_ENTRIES } from "./zip";

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

  /** Regression: a detailed but entirely ordinary Bambu Studio export was
   *  refused as a zip bomb. Its `3D/3dmodel.model` was 99.8 MiB of XML at a
   *  6:1 deflate ratio, over both the old 8 MiB byte ceiling and the old
   *  100k element ceiling. This builds a mesh large enough to clear both of
   *  those old limits while staying small enough to keep the suite quick. */
  it("parses a detailed model whose XML exceeds the former 8 MiB ceiling", () => {
    const triangleCount = 150_000;
    const vertexCount = triangleCount / 2;
    const vertices = Array.from(
      { length: vertexCount },
      (_, i) =>
        `<vertex x="${(Math.sin(i) * 40).toFixed(6)}" y="${(Math.cos(i) * 40).toFixed(6)}" z="${((i % 500) * 0.05).toFixed(6)}"/>`,
    ).join("");
    const triangles = Array.from(
      { length: triangleCount },
      (_, i) =>
        `<triangle v1="${i % vertexCount}" v2="${(i + 1) % vertexCount}" v3="${(i + 2) % vertexCount}"/>`,
    ).join("");
    const model = `<?xml version="1.0" encoding="UTF-8"?>
      <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
        <resources><object id="1" type="model"><mesh>
          <vertices>${vertices}</vertices><triangles>${triangles}</triangles>
        </mesh></object></resources>
        <build><item objectid="1"/></build>
      </model>`;

    // The guards this regression is about are the ones the old limits tripped.
    expect(Buffer.byteLength(model)).toBeGreaterThan(8 * 1024 * 1024);
    expect(triangleCount + vertexCount).toBeGreaterThan(100_000);

    const archive = Buffer.from(
      zipSync({
        "[Content_Types].xml": strToU8(
          '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
        ),
        "_rels/.rels": strToU8(
          '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
        ),
        "3D/3dmodel.model": strToU8(model),
      }),
    );

    const parsed = parseModel(archive, "3mf");
    expect(parsed.triangleCount).toBe(triangleCount);
  });

  /** The old wording ("Compressed entry expands beyond the allowed size") read
   *  as an accusation of hostility to anyone who had simply exported a dense
   *  mesh, and hinted at nothing they could act on. */
  it("describes an oversized entry as too detailed rather than as an attack", () => {
    const archive = Buffer.from(zipSync({ "3D/3dmodel.model": strToU8("<model/>".repeat(1000)) }));
    let message = "";
    try {
      extractZipEntries(archive, (name) => name.endsWith(".model"), { maxEntryBytes: 64 });
    } catch (err) {
      message = (err as ModelParseError).message;
    }
    expect(message).toMatch(/more detailed/);
    expect(message).not.toMatch(/expands beyond/);
  });

  it("rejects containers with an excessive number of entries", () => {
    const entries = Object.fromEntries(
      Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, index) => [
        `Metadata/padding-${index}.txt`,
        new Uint8Array([index & 0xff]),
      ]),
    );
    const archive = Buffer.from(zipSync(entries));
    expect(() => parseModel(archive, "3mf")).toThrowError(/entries/);
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

  it("normalizes 3MF coordinates and translations from declared units to millimetres", () => {
    const inchModel = `<?xml version="1.0" encoding="UTF-8"?>
      <model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
        <resources><object id="1" type="model"><mesh>
          <vertices>
            <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
          </vertices>
          <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
        </mesh></object></resources>
        <build>
          <item objectid="1" transform="1 0 0 0 1 0 0 0 1 2 0 0"/>
        </build>
      </model>`;
    const archive = Buffer.from(zipSync({ "3D/3dmodel.model": strToU8(inchModel) }));

    const parsed = parseModel(archive, "3mf");

    expect(parsed.triangleCount).toBe(1);
    expect(parsed.bboxMm.x).toBeCloseTo(25.4, 4);
    expect(parsed.bboxMm.y).toBeCloseTo(25.4, 4);
    // The item's 2-inch translation must be scaled too, not copied through as
    // 2mm. A single build item keeps its authored position, so the smallest x
    // coordinate is the translation itself.
    let minX = Infinity;
    for (let i = 0; i < parsed.positions.length; i += 3) minX = Math.min(minX, parsed.positions[i]!);
    expect(minX).toBeCloseTo(50.8, 4);
  });

  it("rejects an unknown 3MF unit instead of silently changing print scale", () => {
    const model = `<?xml version="1.0"?>
      <model unit="parsec" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
        <resources><object id="1" type="model"><mesh>
          <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
          <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
        </mesh></object></resources><build><item objectid="1"/></build>
      </model>`;
    const archive = Buffer.from(zipSync({ "3D/3dmodel.model": strToU8(model) }));

    expect(() => parseModel(archive, "3mf")).toThrowError(/unsupported unit/);
  });

  it.each([
    ["ABS", "ABS"],
    ["ABS-GF", "ABS"],
    ["ASA", "ASA"],
    ["PLA Silk", "PLA"],
  ])("imports a 3MF sliced with %s filament as %s", (filamentType, material) => {
    const model = `<?xml version="1.0" encoding="UTF-8"?>
      <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
        <resources>
          <object id="1" type="model">
            <mesh>
              <vertices>
                <vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/>
                <vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="20"/>
              </vertices>
              <triangles>
                <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>
                <triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/>
              </triangles>
            </mesh>
          </object>
        </resources>
        <build><item objectid="1"/></build>
      </model>`;
    const archive = Buffer.from(
      zipSync({
        "[Content_Types].xml": strToU8("<Types/>"),
        "3D/3dmodel.model": strToU8(model),
        "Metadata/project_settings.config": strToU8(JSON.stringify({ filament_type: [filamentType] })),
      }),
    );
    expect(extract3mfSourceConfig(archive)?.material).toBe(material);
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
        <object id="1"><metadata key="extruder" value="1"/></object>
        <object id="2">
          <metadata key="enable_support" value="1"/>
          <metadata key="extruder" value="1"/>
        </object>
        <plate>
          <metadata key="plater_id" value="1"/>
          <model_instance><metadata key="object_id" value="1"/></model_instance>
        </plate>
        <plate>
          <metadata key="plater_id" value="2"/>
          <model_instance><metadata key="object_id" value="2"/></model_instance>
        </plate>
      </config>`;
    const projectSettings = JSON.stringify({
      filament_type: ["PETG"],
      layer_height: "0.16",
      sparse_infill_density: "25%",
      enable_support: "0",
    });
    const archive = Buffer.from(
      zipSync({
        "[Content_Types].xml": strToU8("<Types/>"),
        "3D/3dmodel.model": strToU8(mainModel),
        "3D/Objects/object_1.model": strToU8(objectModel(10)),
        "3D/Objects/object_2.model": strToU8(objectModel(20)),
        "Metadata/model_settings.config": strToU8(settings),
        "Metadata/project_settings.config": strToU8(projectSettings),
      }),
    );

    const full = parseModel(archive, "3mf");
    const plates = extract3mfPlates(archive);
    const source = extract3mfSourceConfig(archive);

    // parseModel packs loose build items rather than inheriting the source
    // slicer's plate coordinates, so the merged model holds both parts without
    // spanning the 320mm their authored positions were 300mm apart across.
    expect(full.triangleCount).toBe(8);
    expect(full.bboxMm.x).toBeLessThanOrEqual(256);
    expect(plates).toHaveLength(2);
    expect(plates.map((plate) => plate.configuredSupports)).toEqual([false, true]);
    expect(plates.map((plate) => plate.sourceConfig)).toEqual([
      { material: "PETG", layerHeightUm: 160, infillPct: 25, supports: "off" },
      { material: "PETG", layerHeightUm: 160, infillPct: 25, supports: "auto" },
    ]);
    expect(source).toEqual({
      material: "PETG",
      layerHeightUm: 160,
      infillPct: 25,
      supports: "auto",
    });
    for (const plate of plates) {
      expect(plate.model.bboxMm).toEqual({ x: 20, y: 20, z: 20 });
      expect(parseModel(plate.stl, "stl").bboxMm).toEqual({ x: 20, y: 20, z: 20 });
    }
  });

  it("rejects 3MF projects that multiply geometry across excessive plates", () => {
    const model = `<?xml version="1.0" encoding="UTF-8"?>
      <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
        <resources><object id="1" type="model"><mesh>
          <vertices>
            <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
          </vertices>
          <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
        </mesh></object></resources>
        <build><item objectid="1"/></build>
      </model>`;
    const plates = Array.from(
      { length: MAX_3MF_PLATES + 1 },
      (_, index) => `<plate><metadata key="plater_id" value="${index + 1}"/>
        <model_instance><metadata key="object_id" value="1"/></model_instance></plate>`,
    ).join("");
    const archive = Buffer.from(
      zipSync({
        "3D/3dmodel.model": strToU8(model),
        "Metadata/model_settings.config": strToU8(`<config>${plates}</config>`),
      }),
    );

    expect(() => extract3mfPlates(archive)).toThrowError(/printable plates/);
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

  it("rejects excessive element counts and nesting before DOM allocation", () => {
    expect(() => parseXml(`<root>${"<x/>".repeat(MAX_XML_ELEMENTS + 1)}</root>`, "test")).toThrowError(
      /elements/,
    );
    expect(() =>
      parseXml(`${"<x>".repeat(MAX_XML_DEPTH + 1)}${"</x>".repeat(MAX_XML_DEPTH + 1)}`, "test"),
    ).toThrowError(/nesting/);
  });
});

describe("multi-part 3MF packing", () => {
  /** One axis-aligned box, `size` mm on a side, as a 3MF mesh object. */
  const boxObject = (id: number, size: number) => `
    <object id="${id}" type="model"><mesh>
      <vertices>
        <vertex x="0" y="0" z="0"/>
        <vertex x="${size}" y="0" z="0"/>
        <vertex x="0" y="${size}" z="0"/>
        <vertex x="0" y="0" z="${size}"/>
      </vertices>
      <triangles>
        <triangle v1="0" v2="2" v3="1"/>
        <triangle v1="0" v2="1" v3="3"/>
        <triangle v1="1" v2="2" v3="3"/>
        <triangle v1="2" v2="0" v3="3"/>
      </triangles>
    </mesh></object>`;

  const archiveOf = (objects: string, items: string) =>
    Buffer.from(
      zipSync({
        "3D/3dmodel.model": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
          <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
            <resources>${objects}</resources>
            <build>${items}</build>
          </model>`),
      }),
    );

  const translate = (x: number) => `1 0 0 0 1 0 0 0 1 ${x} 0 0`;

  it("quotes a part the source slicer parked off the plate and flagged unprintable", () => {
    // The shape of hdd-adapter-x4.3mf: two copies of the same part, the second
    // sitting past the right-hand bed edge with printable="0". Before this was
    // fixed the second copy was dropped outright, halving filament and price.
    const archive = archiveOf(
      `${boxObject(1, 20)}${boxObject(2, 20)}`,
      `<item objectid="1" transform="${translate(30)}" printable="1"/>
       <item objectid="2" transform="${translate(300)}" printable="0"/>`,
    );

    const inspection = inspect3mfUpload(archive);

    expect(inspection.partCount).toBe(2);
    expect(inspection.droppedParts).toBe(0);
    expect(inspection.plates).toHaveLength(0);
    expect(inspection.model?.triangleCount).toBe(8);
    // Both parts, and the whole thing sits inside the bed rather than spanning
    // the 320mm their authored positions were apart.
    expect(inspection.model!.bboxMm.x).toBeLessThanOrEqual(256);
    expect(inspection.model!.bboxMm.y).toBeLessThanOrEqual(256);
  });

  it("splits parts across plates once one bed is full", () => {
    const objects = Array.from({ length: 4 }, (_, i) => boxObject(i + 1, 150)).join("");
    const items = Array.from(
      { length: 4 },
      (_, i) => `<item objectid="${i + 1}" transform="${translate(i * 200)}"/>`,
    ).join("");

    const inspection = inspect3mfUpload(archiveOf(objects, items));

    // Four 150mm parts cannot share a 256mm bed: two per plate at most.
    expect(inspection.model).toBeNull();
    expect(inspection.plates.length).toBeGreaterThan(1);
    expect(inspection.plates.reduce((sum, plate) => sum + plate.partCount, 0)).toBe(4);
    for (const plate of inspection.plates) {
      expect(plate.computed).toBe(true);
      expect(plate.model.bboxMm.x).toBeLessThanOrEqual(256);
      expect(plate.model.bboxMm.y).toBeLessThanOrEqual(256);
      expect(parseModel(plate.stl, "stl").triangleCount).toBe(plate.partCount * 4);
    }
  });

  it("gives a part larger than the bed a plate of its own instead of failing", () => {
    const archive = archiveOf(
      `${boxObject(1, 20)}${boxObject(2, 400)}`,
      `<item objectid="1"/><item objectid="2" transform="${translate(500)}"/>`,
    );

    const inspection = inspect3mfUpload(archive);

    expect(inspection.plates).toHaveLength(2);
    expect(inspection.plates.some((plate) => plate.model.bboxMm.x > 256)).toBe(true);
  });

  it("honours a caller-supplied bed size when packing", () => {
    const archive = archiveOf(
      `${boxObject(1, 60)}${boxObject(2, 60)}`,
      `<item objectid="1"/><item objectid="2" transform="${translate(300)}"/>`,
    );

    // Both parts share the default 256mm bed, but not a 100mm one.
    expect(inspect3mfUpload(archive).plates).toHaveLength(0);
    expect(inspect3mfUpload(archive, { bedMm: [100, 100, 100] }).plates).toHaveLength(2);
  });

  it("leaves a single-item 3MF at its authored coordinates", () => {
    const archive = archiveOf(boxObject(1, 20), `<item objectid="1" transform="${translate(40)}"/>`);

    const model = parseModel(archive, "3mf");

    let minX = Infinity;
    for (let i = 0; i < model.positions.length; i += 3) minX = Math.min(minX, model.positions[i]!);
    expect(minX).toBeCloseTo(40, 4);
    expect(model.triangleCount).toBe(4);
  });

  it("counts build items whose geometry cannot be resolved", () => {
    const archive = archiveOf(
      boxObject(1, 20),
      `<item objectid="1"/><item objectid="1" transform="${translate(50)}"/><item objectid="99"/>`,
    );

    const inspection = inspect3mfUpload(archive);

    expect(inspection.partCount).toBe(2);
    expect(inspection.droppedParts).toBe(1);
  });
});

describe("streamed 3MF mesh reading", () => {
  /** Units the 3MF parser accepts, mirrored here so the oracle below scales
   *  coordinates the same way the parser does. */
  const UNIT_TO_MM: Record<string, number> = {
    micron: 0.001,
    millimeter: 1,
    centimeter: 10,
    inch: 25.4,
    foot: 304.8,
    meter: 1000,
  };

  const byLocalName = (parent: Element | Document, name: string): Element[] => {
    const all = parent.getElementsByTagName("*");
    const out: Element[] = [];
    for (let i = 0; i < all.length; i++) {
      if (all[i]!.localName === name) out.push(all[i]! as unknown as Element);
    }
    return out;
  };

  /**
   * The mesh reader exactly as it worked before streaming: an xmldom DOM with
   * one node per vertex and per triangle.
   *
   * Kept as an executable oracle rather than deleted. The rewrite's whole
   * claim is that it reads identical geometry for a fraction of the memory,
   * and the only way to check the first half of that claim is to keep the
   * implementation it replaced and compare against it.
   */
  const meshViaDom = (modelXml: string, meshIndex = 0): Float32Array => {
    const doc = new DOMParser().parseFromString(modelXml, "text/xml");
    const root = doc.documentElement!;
    const unitScale = UNIT_TO_MM[(root.getAttribute("unit") ?? "millimeter").toLowerCase()]!;
    const mesh = byLocalName(root, "mesh")[meshIndex]!;

    const verts: number[] = [];
    for (const v of byLocalName(byLocalName(mesh, "vertices")[0]!, "vertex")) {
      verts.push(
        Number(v.getAttribute("x")) * unitScale,
        Number(v.getAttribute("y")) * unitScale,
        Number(v.getAttribute("z")) * unitScale,
      );
    }
    const tris = byLocalName(byLocalName(mesh, "triangles")[0]!, "triangle");
    const positions = new Float32Array(tris.length * 9);
    const vertexCount = verts.length / 3;
    tris.forEach((t, i) => {
      (["v1", "v2", "v3"] as const).forEach((attr, j) => {
        const idx = Number(t.getAttribute(attr));
        if (!Number.isInteger(idx) || idx < 0 || idx >= vertexCount) {
          throw new ModelParseError("3MF triangle references a missing vertex");
        }
        positions[i * 9 + j * 3] = verts[idx * 3]!;
        positions[i * 9 + j * 3 + 1] = verts[idx * 3 + 1]!;
        positions[i * 9 + j * 3 + 2] = verts[idx * 3 + 2]!;
      });
    });
    return positions;
  };

  const archiveOf = (modelXml: string) =>
    Buffer.from(zipSync({ "3D/3dmodel.model": strToU8(modelXml) }));

  /** A single-object, single-build-item, untransformed 3MF. That shape leaves
   *  `parseModel().positions` byte-identical to the mesh the reader produced —
   *  nothing downstream translates or normalizes it — so any difference here
   *  is a difference in mesh reading and nothing else. */
  const wrap = (body: string, unit = "millimeter", objectId = "1") =>
    `<?xml version="1.0" encoding="UTF-8"?>
    <model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
      <resources>${body}</resources>
      <build><item objectid="${objectId}"/></build>
    </model>`;

  const TETRA_VERTICES = `
    <vertex x="0" y="0" z="0"/>
    <vertex x="10.5" y="0" z="0"/>
    <vertex x="0" y="7.25" z="0"/>
    <vertex x="0" y="0" z="3.125"/>`;
  const TETRA_TRIANGLES = `
    <triangle v1="0" v2="1" v3="2"/>
    <triangle v1="0" v2="1" v3="3"/>
    <triangle v1="0" v2="2" v3="3"/>
    <triangle v1="1" v2="2" v3="3"/>`;
  const object = (id: string, vertices = TETRA_VERTICES, triangles = TETRA_TRIANGLES) =>
    `<object id="${id}" type="model"><mesh>
       <vertices>${vertices}</vertices><triangles>${triangles}</triangles>
     </mesh></object>`;

  const expectSameAsDom = (modelXml: string, meshIndex = 0) => {
    const streamed = parseModel(archiveOf(modelXml), "3mf");
    expect(streamed.positions).toEqual(meshViaDom(modelXml, meshIndex));
  };

  it("reads the same geometry as the DOM parser it replaced", () => {
    expectSameAsDom(wrap(object("1")));
  });

  it.each([
    ["inch", "inch"],
    ["micron", "micron"],
    ["meter", "meter"],
  ])("applies the %s unit scale exactly as the DOM parser did", (_label, unit) => {
    expectSameAsDom(wrap(object("1"), unit));
  });

  /** The scanner must find meshes through real tokenization. Searching the
   *  bytes for "<mesh" would pick up every one of these. */
  it("ignores markup quoted inside comments, CDATA and processing instructions", () => {
    const decoys = `
      <!-- <mesh><vertices><vertex x="999" y="999" z="999"/></vertices></mesh> -->
      <metadata name="notes"><![CDATA[ <triangle v1="9" v2="9" v3="9"/> ]]></metadata>
      <?sliced <mesh><vertex x="42"/> ?>`;
    expectSameAsDom(wrap(`${decoys}${object("1")}`));
  });

  it("does not mistake a '>' inside an attribute value for the end of a tag", () => {
    // Legal XML: only '<' and '&' must be escaped in an attribute value.
    const body = `<object id="1" type="model" name="a > b then /> more"><mesh>
        <vertices>${TETRA_VERTICES}</vertices><triangles>${TETRA_TRIANGLES}</triangles>
      </mesh></object>`;
    expectSameAsDom(wrap(body));
  });

  it("reads single-quoted attributes and tolerates spacing and attribute order", () => {
    const vertices = `
      <vertex y='0' x='0' z='0' />
      <vertex   x='10.5'   y='0'   z='0'  />
      <vertex z='0' y='7.25' x='0'/>
      <vertex x='0' z='3.125' y='0' extra='ignored'/>`;
    expectSameAsDom(wrap(object("1", vertices)));
  });

  it("strips namespace prefixes when matching mesh elements", () => {
    const model = `<?xml version="1.0" encoding="UTF-8"?>
      <m:model unit="millimeter" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
        <m:resources><m:object id="1" type="model"><m:mesh>
          <m:vertices>
            <m:vertex x="0" y="0" z="0"/><m:vertex x="10.5" y="0" z="0"/>
            <m:vertex x="0" y="7.25" z="0"/><m:vertex x="0" y="0" z="3.125"/>
          </m:vertices>
          <m:triangles>
            <m:triangle v1="0" v2="1" v3="2"/><m:triangle v1="0" v2="1" v3="3"/>
            <m:triangle v1="0" v2="2" v3="3"/><m:triangle v1="1" v2="2" v3="3"/>
          </m:triangles>
        </m:mesh></m:object></m:resources>
        <m:build><m:item objectid="1"/></m:build>
      </m:model>`;
    expectSameAsDom(model);
  });

  /** Number(getAttribute(...)) reads a missing attribute as 0; the streaming
   *  reader has to agree, or meshes silently shift. */
  it("treats a missing coordinate as zero, as the DOM parser did", () => {
    const vertices = `
      <vertex y="0" z="0"/>
      <vertex x="10.5" z="0"/>
      <vertex x="0" y="7.25"/>
      <vertex x="0" y="0" z="3.125"/>`;
    expectSameAsDom(wrap(object("1", vertices)));
  });

  it("picks the right mesh when a document holds several", () => {
    const twoObjects = `${object("1")}${object("2", TETRA_VERTICES.replace(/10\.5/, "4.75"))}`;
    expectSameAsDom(wrap(twoObjects, "millimeter", "2"), 1);
  });

  it("still rejects a triangle pointing past the vertex list", () => {
    const model = wrap(object("1", TETRA_VERTICES, '<triangle v1="0" v2="1" v3="99"/>'));
    expect(() => parseModel(archiveOf(model), "3mf")).toThrowError(/missing vertex/);
  });

  it("still rejects a mesh with no vertices or triangles", () => {
    const model = wrap('<object id="1" type="model"><mesh/></object>');
    expect(() => parseModel(archiveOf(model), "3mf")).toThrowError(
      /missing vertices\/triangles/,
    );
  });

  it("rejects a model part whose mesh is never closed", () => {
    const model = `<?xml version="1.0"?>
      <model unit="millimeter"><resources><object id="1"><mesh>
        <vertices>${TETRA_VERTICES}</vertices><triangles>${TETRA_TRIANGLES}</triangles>
      </object></resources><build><item objectid="1"/></build></model>`;
    expect(() => parseModel(archiveOf(model), "3mf")).toThrowError(ModelParseError);
  });

  /** Structure is bounded separately from geometry now, so a file can be dense
   *  in triangles or dense in objects but not unbounded in either. */
  it("rejects a model whose structure exceeds the skeleton element ceiling", () => {
    const filler = "<metadata/>".repeat(MAX_SKELETON_ELEMENTS + 1);
    const model = wrap(`${filler}${object("1")}`);
    expect(() => parseModel(archiveOf(model), "3mf")).toThrowError(/elements/);
  });

  /** The regression this whole change exists for: mesh XML is no longer
   *  measured against the DOM ceiling, so a model part far past it parses. */
  it("parses a model part larger than the DOM byte ceiling", () => {
    const triangleCount = 500_000;
    const vertexCount = triangleCount / 2;
    const vertices = Array.from(
      { length: vertexCount },
      (_, i) =>
        `<vertex x="${(Math.sin(i) * 40).toFixed(6)}" y="${(Math.cos(i) * 40).toFixed(6)}" z="${((i % 500) * 0.05).toFixed(6)}"/>`,
    ).join("");
    const triangles = Array.from(
      { length: triangleCount },
      (_, i) =>
        `<triangle v1="${i % vertexCount}" v2="${(i + 1) % vertexCount}" v3="${(i + 2) % vertexCount}"/>`,
    ).join("");
    const model = wrap(object("1", vertices, triangles));

    expect(Buffer.byteLength(model)).toBeGreaterThan(MAX_XML_BYTES);
    const parsed = parseModel(archiveOf(model), "3mf");
    expect(parsed.triangleCount).toBe(triangleCount);
  });
});
