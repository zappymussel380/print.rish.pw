import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isZip, parseModel } from "@print/geometry";
import { prepareUploadModels } from "@/lib/upload-prepare";

interface ZipEntryInput {
  localName: string;
  /** A different central name reproduces the local-header/central-directory split. */
  centralName?: string;
  data: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** Minimal stored-entry ZIP builder. It deliberately permits a central filename
 * that differs from the corresponding local header, which normal ZIP writers
 * correctly refuse to produce. */
function zip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const localName = Buffer.from(entry.localName, "utf8");
    const centralName = Buffer.from(entry.centralName ?? entry.localName, "utf8");
    const checksum = crc32(entry.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8); // stored
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(localName.length, 26);
    localParts.push(localHeader, localName, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10); // stored
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(centralName.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, centralName);

    localOffset += localHeader.length + localName.length + entry.data.length;
  }

  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

const modelXml = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
  <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
    <resources>
      <object id="1" type="model"><mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="20" y="0" z="0"/>
          <vertex x="0" y="20" z="0"/>
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh></object>
    </resources>
    <build><item objectid="1"/></build>
  </model>`);

const amfXml = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
  <amf unit="millimeter"><object id="0"><mesh>
    <vertices>
      <vertex><coordinates><x>0</x><y>0</y><z>0</z></coordinates></vertex>
      <vertex><coordinates><x>20</x><y>0</y><z>0</z></coordinates></vertex>
      <vertex><coordinates><x>0</x><y>20</y><z>0</z></coordinates></vertex>
    </vertices>
    <volume><triangle><v1>0</v1><v2>1</v2><v3>2</v3></triangle></volume>
  </mesh></object></amf>`);

describe("archive upload canonicalization", () => {
  it("persists a single 3MF as canonical STL even when its central directory disagrees", () => {
    const projectSettings = Buffer.from(
      JSON.stringify({
        filament_type: ["PETG"],
        layer_height: "0.16",
        sparse_infill_density: "25%",
        enable_support: "1",
      }),
    );
    const archive = zip([
      {
        localName: "3D/3dmodel.model",
        centralName: "central-decoy.bin",
        data: modelXml,
      },
      { localName: "Metadata/project_settings.config", data: projectSettings },
    ]);
    const sourceHash = digest(archive);

    const prepared = prepareUploadModels({
      contents: archive,
      originalName: "customer-project.3mf",
      format: "3mf",
      sourceSha256: sourceHash,
    });

    expect(prepared.models).toHaveLength(1);
    const model = prepared.models[0]!;
    expect(model).toMatchObject({
      originalName: "customer-project.stl",
      format: "stl",
      derived: true,
      defaultConfig: { material: "PETG", layerHeightUm: 160, infillPct: 25, supports: "auto" },
      sourceConfig: { material: "PETG", layerHeightUm: 160, infillPct: 25, supports: "auto" },
    });
    expect(model.lockedConfig).toBeUndefined();
    expect(isZip(model.contents)).toBe(false);
    expect(model.sizeBytes).toBe(model.contents.length);
    expect(prepared.totalBytes).toBe(model.contents.length);
    expect(model.fileHash).toBe(digest(model.contents));
    expect(model.fileHash).not.toBe(sourceHash);
    expect(parseModel(model.contents, "stl").bboxMm).toEqual({ x: 20, y: 20, z: 0 });
  });

  it("persists zipped AMF geometry as canonical STL", () => {
    const archive = zip([
      { localName: "model.amf", centralName: "decoy.bin", data: amfXml },
    ]);

    const prepared = prepareUploadModels({
      contents: archive,
      originalName: "part.amf",
      format: "amf",
      sourceSha256: digest(archive),
    });

    const model = prepared.models[0]!;
    expect(model).toMatchObject({ originalName: "part.stl", format: "stl", derived: true });
    expect(isZip(model.contents)).toBe(false);
    expect(model.sizeBytes).toBe(model.contents.length);
    expect(model.fileHash).toBe(digest(model.contents));
    expect(parseModel(model.contents, "stl").bboxMm).toEqual({ x: 20, y: 20, z: 0 });
  });

  it("retains raw non-archive model bytes and their streaming hash", () => {
    const sourceHash = digest(amfXml);
    const prepared = prepareUploadModels({
      contents: amfXml,
      originalName: "part.amf",
      format: "amf",
      sourceSha256: sourceHash,
    });

    expect(prepared.totalBytes).toBe(amfXml.length);
    expect(prepared.models[0]).toMatchObject({
      originalName: "part.amf",
      format: "amf",
      derived: false,
      fileHash: sourceHash,
      sizeBytes: amfXml.length,
    });
    expect(prepared.models[0]!.contents).toBe(amfXml);
  });

  it("preserves per-plate defaults and support locks while accounting canonical bytes", () => {
    const twoObjectModel = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
      <model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
        <resources>
          <object id="1" type="model"><mesh>
            <vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices>
            <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
          </mesh></object>
          <object id="2" type="model"><mesh>
            <vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="0" y="20" z="0"/></vertices>
            <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
          </mesh></object>
        </resources>
        <build><item objectid="1"/><item objectid="2"/></build>
      </model>`);
    const plateSettings = Buffer.from(`<?xml version="1.0"?><config>
      <object id="1"><metadata key="extruder" value="1"/></object>
      <object id="2"><metadata key="extruder" value="1"/><metadata key="enable_support" value="1"/></object>
      <plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/></model_instance></plate>
      <plate><metadata key="plater_id" value="2"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate>
    </config>`);
    const projectSettings = Buffer.from(
      JSON.stringify({ filament_type: ["PLA"], layer_height: "0.20", sparse_infill_density: "15%" }),
    );
    const archive = zip([
      { localName: "3D/3dmodel.model", data: twoObjectModel },
      { localName: "Metadata/model_settings.config", data: plateSettings },
      { localName: "Metadata/project_settings.config", data: projectSettings },
    ]);

    const prepared = prepareUploadModels({
      contents: archive,
      originalName: "plates.3mf",
      format: "3mf",
      sourceSha256: digest(archive),
    });

    expect(prepared.models.map((model) => model.originalName)).toEqual([
      "plates - plate 01.stl",
      "plates - plate 02.stl",
    ]);
    expect(prepared.models.map((model) => model.defaultConfig)).toEqual([
      { material: "PLA", layerHeightUm: 200, infillPct: 15, supports: "off" },
      { material: "PLA", layerHeightUm: 200, infillPct: 15, supports: "auto" },
    ]);
    expect(prepared.models.map((model) => model.sourceConfig)).toEqual(
      prepared.models.map((model) => model.defaultConfig),
    );
    expect(prepared.models.map((model) => model.lockedConfig)).toEqual([
      { supports: true },
      { supports: true },
    ]);
    expect(prepared.models.every((model) => model.format === "stl" && model.derived)).toBe(true);
    expect(prepared.totalBytes).toBe(
      prepared.models.reduce((sum, model) => sum + model.contents.length, 0),
    );
  });
});
