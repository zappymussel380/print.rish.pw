import type { Document, Element } from "@xmldom/xmldom";
import { finalizeModel } from "./math";
import { serializeBinaryStl } from "./stl";
import { MAX_TRIANGLES, ModelParseError, type ParsedModel } from "./types";
import { parseXml } from "./xml";
import { extractZipEntries, extractZipEntry, isZip } from "./zip";

export const PREARRANGED_PLATE_STL_HEADER = "print.rish.pw prearranged plate";

interface MeshObject {
  kind: "mesh";
  mesh: Float32Array;
}

interface ComponentObject {
  kind: "components";
  components: ComponentRef[];
}

type ObjectDef = MeshObject | ComponentObject;

interface ComponentRef {
  id: string;
  path: string | null;
  transform: number[] | null;
}

interface BuildItem {
  objectId: string;
  transform: number[] | null;
  printable: boolean;
}

interface ModelDocument {
  name: string;
  objects: Map<string, ObjectDef>;
  buildItems: BuildItem[];
}

interface PlateDef {
  index: number;
  name: string;
  objectIds: string[];
  configuredSupports: boolean;
}

interface ThreeMfProject {
  main: ModelDocument;
  entries: ModelDocument[];
  entriesByName: Map<string, ModelDocument>;
  meshCount: number;
  modelSettingsXml: string | null;
}

export interface Extracted3mfPlate {
  index: number;
  name: string;
  configuredSupports: boolean;
  model: ParsedModel;
  stl: Buffer;
}

/**
 * 3MF parser: unzips model XML parts and reads mesh vertices/triangles.
 * Handles Bambu/Orca-style split 3MF projects where 3D/3dmodel.model contains
 * build items and cross-file component references into 3D/Objects/*.model.
 */
export function parse3mf(buf: Buffer): ParsedModel {
  const project = load3mfProject(buf);
  const parts =
    project.main.buildItems.length > 0
      ? project.main.buildItems.flatMap((item) => resolveBuildItem(project, item))
      : allMeshParts(project);

  if (project.meshCount === 0) throw new ModelParseError("3MF contains no mesh geometry", "EMPTY");
  return finalizeModel(mergeParts(parts, "3MF contains no buildable mesh geometry"));
}

/** Extract Bambu/Orca multi-plate projects into clean, per-plate STL payloads. */
export function extract3mfPlates(buf: Buffer): Extracted3mfPlate[] {
  const project = load3mfProject(buf);
  if (!project.modelSettingsXml) return [];

  const plates = parsePlateSettings(project.modelSettingsXml);
  if (plates.length <= 1) return [];

  const buildByObjectId = new Map<string, BuildItem[]>();
  for (const item of project.main.buildItems) {
    const existing = buildByObjectId.get(item.objectId) ?? [];
    existing.push(item);
    buildByObjectId.set(item.objectId, existing);
  }

  const extracted: Extracted3mfPlate[] = [];
  for (const plate of plates) {
    const parts: Float32Array[] = [];
    for (const objectId of plate.objectIds) {
      const items = buildByObjectId.get(objectId);
      if (items?.length) {
        for (const item of items) parts.push(...resolveBuildItem(project, item));
      } else {
        parts.push(...resolveObject(project, project.main, objectId, null, new Set()));
      }
    }
    if (parts.length === 0) continue;

    const positions = normalizeToOrigin(mergeParts(parts, `Plate ${plate.index} contains no mesh`));
    const model = finalizeModel(positions);
    extracted.push({
      index: plate.index,
      name: plate.name,
      configuredSupports: plate.configuredSupports,
      model,
      stl: serializeBinaryStl(
        model.positions,
        `${PREARRANGED_PLATE_STL_HEADER} ${plate.index}`,
      ),
    });
  }

  return extracted;
}

function load3mfProject(buf: Buffer): ThreeMfProject {
  if (!isZip(buf)) throw new ModelParseError("Not a 3MF file (missing zip signature)");
  const modelEntries = extractZipEntries(buf, isModelEntry).sort((a, b) => {
    const aMain = a.name.toLowerCase().endsWith("3dmodel.model");
    const bMain = b.name.toLowerCase().endsWith("3dmodel.model");
    return Number(bMain) - Number(aMain);
  });
  if (modelEntries.length === 0) throw new ModelParseError("3MF is missing model XML");

  const entries = modelEntries.map((entry) =>
    parseModelDocument(entry.name, entry.data.toString("utf8")),
  );
  const main = entries.find((entry) => entry.name.toLowerCase().endsWith("3dmodel.model")) ?? entries[0]!;
  const entriesByName = new Map(entries.map((entry) => [normalizePackagePath(entry.name), entry]));
  const meshCount = entries.reduce((sum, entry) => {
    for (const object of entry.objects.values()) if (object.kind === "mesh") sum++;
    return sum;
  }, 0);
  const settings = extractZipEntry(
    buf,
    (name) => name.toLowerCase() === "metadata/model_settings.config",
  );

  return {
    main,
    entries,
    entriesByName,
    meshCount,
    modelSettingsXml: settings ? settings.toString("utf8") : null,
  };
}

function isModelEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("3d/") && lower.endsWith(".model");
}

function parseModelDocument(name: string, xml: string): ModelDocument {
  const doc = parseXml(xml, `3MF model ${name}`);
  const root = doc.documentElement;
  if (!root) throw new ModelParseError("3MF model has no root element");

  const objects = new Map<string, ObjectDef>();
  for (const object of elements(root, "object")) {
    const id = object.getAttribute("id") ?? "";
    const mesh = firstElement(object, "mesh");
    if (mesh) {
      objects.set(id, { kind: "mesh", mesh: meshToTriangles(mesh) });
      continue;
    }

    const components = firstElement(object, "components");
    if (components) {
      objects.set(id, {
        kind: "components",
        components: childElements(components, "component").map((component) => ({
          id: component.getAttribute("objectid") ?? "",
          path: packagePathAttr(component),
          transform: parseTransform(component.getAttribute("transform")),
        })),
      });
    }
  }

  const build = firstElement(root, "build");
  const buildItems = build
    ? childElements(build, "item").map((item) => ({
        objectId: item.getAttribute("objectid") ?? "",
        transform: parseTransform(item.getAttribute("transform")),
        printable: item.getAttribute("printable") !== "0",
      }))
    : [];

  return { name, objects, buildItems };
}

function parsePlateSettings(xml: string): PlateDef[] {
  const doc = parseXml(xml, "3MF model settings");
  const root = doc.documentElement;
  if (!root) return [];

  const supportedObjects = new Set(
    childElements(root, "object")
      .filter((object) => metadataValue(object, "enable_support") === "1")
      .map((object) => object.getAttribute("id") ?? "")
      .filter(Boolean),
  );

  return elements(root, "plate")
    .map((plate, i) => {
      const index = Number(metadataValue(plate, "plater_id")) || i + 1;
      const explicitName = metadataValue(plate, "plater_name")?.trim();
      const objectIds = childElements(plate, "model_instance")
        .map((instance) => metadataValue(instance, "object_id"))
        .filter((id): id is string => !!id);

      return {
        index,
        name: explicitName || `Plate ${index}`,
        objectIds,
        configuredSupports: objectIds.some((id) => supportedObjects.has(id)),
      };
    })
    .filter((plate) => plate.objectIds.length > 0);
}

function resolveBuildItem(project: ThreeMfProject, item: BuildItem): Float32Array[] {
  if (!item.printable) return [];
  return resolveObject(project, project.main, item.objectId, item.transform, new Set());
}

function resolveObject(
  project: ThreeMfProject,
  entry: ModelDocument,
  id: string,
  transform: number[] | null,
  seen: Set<string>,
): Float32Array[] {
  const targetEntry = entry.objects.has(id) ? entry : findUniqueEntryWithObject(project, id);
  if (!targetEntry) return [];

  const key = `${normalizePackagePath(targetEntry.name)}#${id}`;
  if (seen.has(key)) throw new ModelParseError("3MF contains recursive component references");
  const nextSeen = new Set(seen);
  nextSeen.add(key);

  const object = targetEntry.objects.get(id);
  if (!object) return [];
  if (object.kind === "mesh") return [applyTransform(object.mesh, transform)];

  const parts: Float32Array[] = [];
  for (const component of object.components) {
    const componentEntry = component.path
      ? project.entriesByName.get(normalizePackagePath(component.path))
      : targetEntry;
    if (!componentEntry) continue;
    parts.push(
      ...resolveObject(
        project,
        componentEntry,
        component.id,
        combine(component.transform, transform),
        nextSeen,
      ),
    );
  }
  return parts;
}

function findUniqueEntryWithObject(project: ThreeMfProject, id: string): ModelDocument | null {
  let found: ModelDocument | null = null;
  for (const entry of project.entries) {
    if (!entry.objects.has(id)) continue;
    if (found) return null;
    found = entry;
  }
  return found;
}

function allMeshParts(project: ThreeMfProject): Float32Array[] {
  const parts: Float32Array[] = [];
  for (const entry of project.entries) {
    for (const object of entry.objects.values()) {
      if (object.kind === "mesh") parts.push(object.mesh);
    }
  }
  return parts;
}

function mergeParts(parts: Float32Array[], emptyMessage: string): Float32Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  if (total / 9 > MAX_TRIANGLES) {
    throw new ModelParseError(`3MF exceeds ${MAX_TRIANGLES} triangles`, "TOO_MANY_TRIANGLES");
  }
  if (total === 0) throw new ModelParseError(emptyMessage, "EMPTY");

  const positions = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    positions.set(p, offset);
    offset += p.length;
  }
  return positions;
}

function normalizeToOrigin(positions: Float32Array): Float32Array {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!);
    minZ = Math.min(minZ, positions[i + 2]!);
  }
  if (![minX, minY, minZ].every(Number.isFinite)) {
    throw new ModelParseError("Model contains non-finite coordinates");
  }

  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i]! - minX;
    out[i + 1] = positions[i + 1]! - minY;
    out[i + 2] = positions[i + 2]! - minZ;
  }
  return out;
}

function meshToTriangles(mesh: Element): Float32Array {
  const verticesEl = firstElement(mesh, "vertices");
  const trianglesEl = firstElement(mesh, "triangles");
  if (!verticesEl || !trianglesEl) throw new ModelParseError("3MF mesh missing vertices/triangles");

  const verts: number[] = [];
  for (const v of elements(verticesEl, "vertex")) {
    verts.push(
      Number(v.getAttribute("x")),
      Number(v.getAttribute("y")),
      Number(v.getAttribute("z")),
    );
  }
  const tris = elements(trianglesEl, "triangle");
  if (tris.length > MAX_TRIANGLES) {
    throw new ModelParseError(`3MF exceeds ${MAX_TRIANGLES} triangles`, "TOO_MANY_TRIANGLES");
  }
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
}

/** 3MF transform: 12 space-separated numbers, row-major 4x3. */
function parseTransform(attr: string | null): number[] | null {
  if (!attr) return null;
  const nums = attr.trim().split(/\s+/).map(Number);
  if (nums.length === 12 && nums.every(Number.isFinite)) return nums;
  if (nums.length === 16 && nums.every(Number.isFinite)) {
    return [
      nums[0]!,
      nums[1]!,
      nums[2]!,
      nums[4]!,
      nums[5]!,
      nums[6]!,
      nums[8]!,
      nums[9]!,
      nums[10]!,
      nums[12]!,
      nums[13]!,
      nums[14]!,
    ];
  }
  return null;
}

function combine(a: number[] | null, b: number[] | null): number[] | null {
  if (!a) return b;
  if (!b) return a;
  // c = a then b (both 4x3 affine, row-vector convention).
  const c = new Array<number>(12);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      c[row * 3 + col] =
        a[row * 3]! * b[col]! +
        a[row * 3 + 1]! * b[3 + col]! +
        a[row * 3 + 2]! * b[6 + col]! +
        (row === 3 ? b[9 + col]! : 0);
    }
  }
  return c;
}

function applyTransform(positions: Float32Array, m: number[] | null): Float32Array {
  if (!m) return positions;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    out[i] = x * m[0]! + y * m[3]! + z * m[6]! + m[9]!;
    out[i + 1] = x * m[1]! + y * m[4]! + z * m[7]! + m[10]!;
    out[i + 2] = x * m[2]! + y * m[5]! + z * m[8]! + m[11]!;
  }
  return out;
}

function packagePathAttr(el: Element): string | null {
  return el.getAttribute("p:path") || el.getAttribute("path") || null;
}

function normalizePackagePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

function metadataValue(parent: Element, key: string): string | null {
  for (const el of childElements(parent, "metadata")) {
    if (el.getAttribute("key") === key) return el.getAttribute("value") ?? "";
  }
  return null;
}

// --- tiny DOM helpers (xmldom lacks querySelector) ---
function elements(parent: Element | Document, localName: string): Element[] {
  const result: Element[] = [];
  const all = ("getElementsByTagName" in parent ? parent : (parent as Document)).getElementsByTagName(
    "*",
  );
  for (let i = 0; i < all.length; i++) {
    const el = all[i]!;
    if (el.localName === localName) result.push(el as unknown as Element);
  }
  return result;
}

function childElements(parent: Element, localName: string): Element[] {
  const result: Element[] = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const node = parent.childNodes[i];
    if (node?.nodeType === 1 && (node as Element).localName === localName) {
      result.push(node as Element);
    }
  }
  return result;
}

function firstElement(parent: Element, localName: string): Element | null {
  return elements(parent, localName)[0] ?? null;
}
