import type { Document, Element } from "@xmldom/xmldom";
import { finalizeModel } from "./math";
import { serializeBinaryStl } from "./stl";
import { MAX_TRIANGLES, MAX_VERTICES, ModelParseError, type ParsedModel } from "./types";
import { MAX_XML_BYTES, parseXmlBuffer } from "./xml";
import { extractZipEntries, isZip } from "./zip";

export const PREARRANGED_PLATE_STL_HEADER = "print.rish.pw prearranged plate";

const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

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
  sourceConfig: ThreeMfSourceConfig;
}

interface ThreeMfProject {
  main: ModelDocument;
  entries: ModelDocument[];
  entriesByName: Map<string, ModelDocument>;
  meshCount: number;
  modelSettings: Buffer | null;
  projectSettings: Record<string, unknown> | null;
}

interface GeometryBudget {
  triangles: number;
  vertices: number;
}

interface ResolveBudget extends GeometryBudget {
  references: number;
}

const MAX_COMPONENT_REFERENCES = 50_000;
const MAX_COMPONENT_DEPTH = 128;
export const MAX_3MF_PLATES = 20;

/** Printable volume assumed when the caller does not name one. The worker
 *  passes the real machine's bed; the default only keeps standalone parsing
 *  (thumbnails, tests) honest. */
export const DEFAULT_BED_MM: readonly [number, number, number] = [256, 256, 256];
/** Clearance left between packed parts and around the plate edge, so the
 *  skirt/brim Orca draws around each object still lands inside the bed. */
const PACK_GAP_MM = 4;

export interface ThreeMfParseOptions {
  /** Printable volume in mm. Build items a slicer parked off the plate are
   *  packed back onto plates of this size rather than dropped. */
  bedMm?: readonly [number, number, number];
}

export interface Extracted3mfPlate {
  index: number;
  name: string;
  configuredSupports: boolean;
  sourceConfig: ThreeMfSourceConfig;
  model: ParsedModel;
  stl: Buffer;
  /** Build items merged into this plate. */
  partCount: number;
  /** True when we packed this plate ourselves out of loose build items rather
   *  than reading a slicer-authored plate. The source file says nothing about
   *  supports for these, so the caller must not lock that setting. */
  computed: boolean;
}

export interface ThreeMfSourceConfig {
  material?: string;
  layerHeightUm?: number;
  infillPct?: number;
  supports?: "auto" | "off";
}

export interface ThreeMfUploadInspection {
  model: ParsedModel | null;
  plates: Extracted3mfPlate[];
  sourceConfig: ThreeMfSourceConfig | null;
  /** Build items that ended up in `model`. Greater than one means we packed
   *  loose parts together, and the caller must serialize `model` as a
   *  prearranged plate so the slicer keeps our layout. */
  partCount: number;
  /** Build items that referenced geometry we could not resolve. Never silently
   *  zero-filled: a non-zero count means the quote is missing something. */
  droppedParts: number;
}

/**
 * 3MF parser: unzips model XML parts and reads mesh vertices/triangles.
 * Handles Bambu/Orca-style split 3MF projects where 3D/3dmodel.model contains
 * build items and cross-file component references into 3D/Objects/*.model.
 */
export function parse3mf(buf: Buffer, options: ThreeMfParseOptions = {}): ParsedModel {
  const project = load3mfProject(buf);
  if (project.meshCount === 0) throw new ModelParseError("3MF contains no mesh geometry", "EMPTY");
  if (project.main.buildItems.length <= 1) return finalizeModel(soleItemPositions(project));

  // Several build items and only one model to return: lay them out in bed-wide
  // rows and let the caller's build-volume check judge the result. Merging them
  // at their authored positions instead would inherit the source slicer's
  // plate coordinates, including any part parked off the plate.
  const { items } = resolveLooseItems(project, freshBudget());
  const plates = packOntoPlates(items, bedOf(options), { unboundedDepth: true });
  return finalizeModel(mergeParts(plates[0] ?? [], "3MF contains no buildable mesh geometry"));
}

/** Extract Bambu/Orca multi-plate projects into clean, per-plate STL payloads. */
export function extract3mfPlates(buf: Buffer, options: ThreeMfParseOptions = {}): Extracted3mfPlate[] {
  const project = load3mfProject(buf);
  const authored = authoredPlates(project);
  if (authored.length > 0) return authored;
  const packed = packLooseItems(project, options);
  return packed && packed.plates.length > 1 ? packed.plates : [];
}

/** Extract source print settings from Bambu/Orca-style 3MF project metadata. */
export function extract3mfSourceConfig(buf: Buffer): ThreeMfSourceConfig | null {
  return sourceConfigFromProject(load3mfProject(buf));
}

function sourceConfigFromProject(project: ThreeMfProject): ThreeMfSourceConfig | null {
  const source = projectSourceConfig(project.projectSettings);

  if (project.modelSettings) {
    const plateSettings = parsePlateSettings(project.modelSettings, project.projectSettings);
    const materials = uniqueDefined(plateSettings.map((plate) => plate.sourceConfig.material));
    if (materials.length === 1) source.material = materials[0]!;
    source.supports = plateSettings.some((plate) => plate.configuredSupports) ? "auto" : "off";
  }

  return Object.keys(source).length > 0 ? source : null;
}

/** Upload-specific inspection that parses a 3MF archive once. The previous
 * upload path independently loaded the same zip up to three times (plate scan,
 * geometry, source settings), multiplying CPU and memory on the request path. */
export function inspect3mfUpload(
  buf: Buffer,
  options: ThreeMfParseOptions = {},
): ThreeMfUploadInspection {
  const project = load3mfProject(buf);
  if (project.meshCount === 0) throw new ModelParseError("3MF contains no mesh geometry", "EMPTY");
  const sourceConfig = sourceConfigFromProject(project);

  // A slicer-authored multi-plate project already says where every part goes.
  const authored = authoredPlates(project);
  if (authored.length > 0) {
    return { plates: authored, model: null, sourceConfig, partCount: 0, droppedParts: 0 };
  }

  const packed = packLooseItems(project, options);
  if (packed) {
    // More parts than one bed holds: hand back real plates, which the caller
    // turns into separate models so every part is sliced and priced.
    if (packed.plates.length > 1) {
      return {
        plates: packed.plates,
        model: null,
        sourceConfig,
        partCount: 0,
        droppedParts: packed.droppedParts,
      };
    }
    const plate = packed.plates[0]!;
    return {
      plates: [],
      model: plate.model,
      sourceConfig,
      partCount: plate.partCount,
      droppedParts: packed.droppedParts,
    };
  }

  return {
    plates: [],
    model: finalizeModel(soleItemPositions(project)),
    sourceConfig,
    partCount: 1,
    droppedParts: 0,
  };
}

/** The single-build-item (or item-less) case, kept exactly as it always was:
 *  authored coordinates, no packing. This is the overwhelmingly common 3MF and
 *  there is nothing to arrange, so its sliced result must not move. */
function soleItemPositions(project: ThreeMfProject): Float32Array {
  const item = project.main.buildItems[0];
  const parts = item
    ? resolveBuildItem(project, item, freshBudget())
    : allMeshParts(project);
  return mergeParts(parts, "3MF contains no buildable mesh geometry");
}

interface PackedPlates {
  plates: Extracted3mfPlate[];
  droppedParts: number;
}

/** Pack a project's loose build items onto bed-sized plates.
 *
 * Returns null when there is nothing to pack (fewer than two build items), so
 * callers can fall through to the untouched single-item path.
 *
 * This is what stops multi-part files being under-quoted. A source slicer is
 * free to park a part off the plate or flag it unprintable; merging the
 * survivors at their authored coordinates yields one rigid mesh spanning the
 * whole plate, which the slicer can translate but never separate — so the
 * parked parts simply never get sliced, and the customer is charged for a
 * fraction of the file. Splitting the items apart and arranging them ourselves
 * is the only way the toolpath can cover all of them.
 */
function packLooseItems(project: ThreeMfProject, options: ThreeMfParseOptions): PackedPlates | null {
  if (project.main.buildItems.length <= 1) return null;

  const { items, droppedParts } = resolveLooseItems(project, freshBudget());
  const sourceConfig = sourceConfigFromProject(project) ?? {};
  const packed = packOntoPlates(items, bedOf(options));

  const plates = packed.map((parts, i) => {
    const index = i + 1;
    const model = finalizeModel(mergeParts(parts, `Plate ${index} contains no mesh`));
    return {
      index,
      name: `Plate ${index}`,
      // Nothing in a loose-item file tells us supports were configured for it,
      // so the caller must leave that setting open to the customer.
      configuredSupports: false,
      sourceConfig,
      model,
      stl: serializeBinaryStl(model.positions, `${PREARRANGED_PLATE_STL_HEADER} ${index}`),
      partCount: parts.length,
      computed: true,
    } satisfies Extracted3mfPlate;
  });

  return { plates, droppedParts };
}

/** Slicer-authored plates from Bambu/Orca `model_settings.config`. Empty when
 *  the project does not describe more than one plate. */
function authoredPlates(project: ThreeMfProject): Extracted3mfPlate[] {
  if (!project.modelSettings) return [];

  const plates = parsePlateSettings(project.modelSettings, project.projectSettings);
  if (plates.length <= 1) return [];

  const buildByObjectId = new Map<string, BuildItem[]>();
  for (const item of project.main.buildItems) {
    const existing = buildByObjectId.get(item.objectId) ?? [];
    existing.push(item);
    buildByObjectId.set(item.objectId, existing);
  }

  const extracted: Extracted3mfPlate[] = [];
  // One shared budget is critical: otherwise many plate records can each
  // reference the same legal-size mesh and multiply it into unbounded output.
  const budget: ResolveBudget = freshBudget();
  for (const plate of plates) {
    const parts: Float32Array[] = [];
    for (const objectId of plate.objectIds) {
      const items = buildByObjectId.get(objectId);
      if (items?.length) {
        for (const item of items) parts.push(...resolveBuildItem(project, item, budget));
      } else {
        parts.push(...resolveObject(project, project.main, objectId, null, new Set(), budget));
      }
    }
    if (parts.length === 0) continue;

    const positions = normalizeToOrigin(mergeParts(parts, `Plate ${plate.index} contains no mesh`));
    const model = finalizeModel(positions);
    extracted.push({
      index: plate.index,
      name: plate.name,
      configuredSupports: plate.configuredSupports,
      sourceConfig: plate.sourceConfig,
      model,
      stl: serializeBinaryStl(
        model.positions,
        `${PREARRANGED_PLATE_STL_HEADER} ${plate.index}`,
      ),
      partCount: plate.objectIds.length,
      computed: false,
    });
  }

  return extracted;
}

interface LooseItem {
  /** Origin-normalized triangle soup for one build item. */
  positions: Float32Array;
  width: number;
  depth: number;
}

/** Resolve every build item into its own origin-normalized soup.
 *
 * `printable="0"` is deliberately not honoured here. A source slicer uses it
 * for parts the customer excluded from *their* plate, but we are quoting the
 * file as delivered, and dropping geometry on that flag is invisible in the
 * price. Items that resolve to no geometry at all are counted, never ignored.
 */
function resolveLooseItems(
  project: ThreeMfProject,
  budget: ResolveBudget,
): { items: LooseItem[]; droppedParts: number } {
  const items: LooseItem[] = [];
  let droppedParts = 0;

  for (const item of project.main.buildItems) {
    const parts = resolveBuildItem(project, item, budget);
    if (parts.every((part) => part.length === 0)) {
      droppedParts += 1;
      continue;
    }
    const positions = normalizeToOrigin(
      mergeParts(parts, "3MF build item contains no mesh"),
    );
    let width = 0;
    let depth = 0;
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i]! > width) width = positions[i]!;
      if (positions[i + 1]! > depth) depth = positions[i + 1]!;
    }
    items.push({ positions, width, depth });
  }

  if (items.length === 0) {
    throw new ModelParseError("3MF contains no buildable mesh geometry", "EMPTY");
  }
  return { items, droppedParts };
}

/** Shelf-pack footprints onto plates, deepest first.
 *
 * Next-fit-decreasing-height: parts fill a row left to right, a full row opens
 * the next shelf, and a full plate opens the next plate. Not optimal packing,
 * but stable, cheap, and close to how a person lays parts out by hand. */
function packOntoPlates(
  items: LooseItem[],
  bedMm: readonly [number, number, number],
  options: { unboundedDepth?: boolean } = {},
): Float32Array[][] {
  const usableWidth = Math.max(bedMm[0] - PACK_GAP_MM * 2, 1);
  const usableDepth = options.unboundedDepth
    ? Number.POSITIVE_INFINITY
    : Math.max(bedMm[1] - PACK_GAP_MM * 2, 1);

  const plates: Float32Array[][] = [];
  let plate: Float32Array[] = [];
  let cursorX = 0;
  let shelfY = 0;
  let shelfDepth = 0;

  const closePlate = () => {
    if (plate.length > 0) plates.push(plate);
    plate = [];
    cursorX = 0;
    shelfY = 0;
    shelfDepth = 0;
  };

  for (const item of [...items].sort((a, b) => b.depth - a.depth)) {
    // Too big for the bed on its own. Give it a plate to itself rather than
    // failing the upload: the caller's build-volume warning already tells the
    // customer this part will not print as-is.
    if (item.width > usableWidth || item.depth > usableDepth) {
      closePlate();
      plates.push([translateXY(item.positions, PACK_GAP_MM, PACK_GAP_MM)]);
      continue;
    }
    if (cursorX > 0 && cursorX + item.width > usableWidth) {
      shelfY += shelfDepth + PACK_GAP_MM;
      cursorX = 0;
      shelfDepth = 0;
    }
    if (shelfY + item.depth > usableDepth) closePlate();

    plate.push(translateXY(item.positions, PACK_GAP_MM + cursorX, PACK_GAP_MM + shelfY));
    cursorX += item.width + PACK_GAP_MM;
    shelfDepth = Math.max(shelfDepth, item.depth);
  }
  closePlate();

  if (plates.length > MAX_3MF_PLATES) {
    throw new ModelParseError(`3MF exceeds ${MAX_3MF_PLATES} printable plates`, "TOO_COMPLEX");
  }
  return plates;
}

function translateXY(positions: Float32Array, dx: number, dy: number): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i]! + dx;
    out[i + 1] = positions[i + 1]! + dy;
    out[i + 2] = positions[i + 2]!;
  }
  return out;
}

function bedOf(options: ThreeMfParseOptions): readonly [number, number, number] {
  return options.bedMm ?? DEFAULT_BED_MM;
}

function freshBudget(): ResolveBudget {
  return { triangles: 0, vertices: 0, references: 0 };
}

function load3mfProject(buf: Buffer): ThreeMfProject {
  if (!isZip(buf)) throw new ModelParseError("Not a 3MF file (missing zip signature)");
  const modelSettingsName = "metadata/model_settings.config";
  const projectSettingsName = "metadata/project_settings.config";
  const seen = new Set<string>();
  // One archive traversal and one aggregate budget for every entry we consume.
  // Repeated extraction previously reset the 64 MiB allowance three times.
  const packageEntries = extractZipEntries(
    buf,
    (name) => {
      const normalized = normalizePackagePath(name);
      const relevant =
        isModelEntry(normalized) ||
        normalized === modelSettingsName ||
        normalized === projectSettingsName;
      if (!relevant) return false;
      if (seen.has(normalized)) {
        throw new ModelParseError(`3MF contains duplicate entry ${normalized}`, "MALFORMED");
      }
      seen.add(normalized);
      return true;
    },
    {
      maxEntryBytes: (name) => {
        const normalized = normalizePackagePath(name);
        if (normalized === projectSettingsName) return 512 * 1024;
        if (normalized === modelSettingsName) return 2 * 1024 * 1024;
        return MAX_XML_BYTES;
      },
    },
  );
  const modelEntries = packageEntries.filter((entry) => isModelEntry(entry.name)).sort((a, b) => {
    const aMain = a.name.toLowerCase().endsWith("3dmodel.model");
    const bMain = b.name.toLowerCase().endsWith("3dmodel.model");
    return Number(bMain) - Number(aMain);
  });
  if (modelEntries.length === 0) throw new ModelParseError("3MF is missing model XML");

  const geometryBudget: GeometryBudget = { triangles: 0, vertices: 0 };
  const entries = modelEntries.map((entry) =>
    parseModelDocument(entry.name, entry.data, geometryBudget),
  );
  const main = entries.find((entry) => entry.name.toLowerCase().endsWith("3dmodel.model")) ?? entries[0]!;
  const entriesByName = new Map(entries.map((entry) => [normalizePackagePath(entry.name), entry]));
  const meshCount = entries.reduce((sum, entry) => {
    for (const object of entry.objects.values()) if (object.kind === "mesh") sum++;
    return sum;
  }, 0);
  const settings = packageEntries.find(
    (entry) => normalizePackagePath(entry.name) === modelSettingsName,
  )?.data;
  const projectSettings = packageEntries.find(
    (entry) => normalizePackagePath(entry.name) === projectSettingsName,
  )?.data;

  return {
    main,
    entries,
    entriesByName,
    meshCount,
    modelSettings: settings ?? null,
    projectSettings: projectSettings ? parseProjectSettings(projectSettings) : null,
  };
}

function isModelEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("3d/") && lower.endsWith(".model");
}

function parseModelDocument(name: string, xml: Buffer, budget: GeometryBudget): ModelDocument {
  const doc = parseXmlBuffer(xml, `3MF model ${name}`);
  const root = doc.documentElement;
  if (!root) throw new ModelParseError("3MF model has no root element");
  const declaredUnit = (root.getAttribute("unit") ?? "millimeter").toLowerCase();
  const unitScale = UNIT_TO_MM[declaredUnit];
  if (unitScale === undefined) {
    throw new ModelParseError(`3MF model uses unsupported unit ${declaredUnit}`, "MALFORMED");
  }

  const objects = new Map<string, ObjectDef>();
  for (const object of elements(root, "object")) {
    const id = object.getAttribute("id") ?? "";
    const mesh = firstElement(object, "mesh");
    if (mesh) {
      objects.set(id, { kind: "mesh", mesh: meshToTriangles(mesh, budget, unitScale) });
      continue;
    }

    const components = firstElement(object, "components");
    if (components) {
      objects.set(id, {
        kind: "components",
        components: childElements(components, "component").map((component) => ({
          id: component.getAttribute("objectid") ?? "",
          path: packagePathAttr(component),
          transform: parseTransform(component.getAttribute("transform"), unitScale),
        })),
      });
    }
  }

  const build = firstElement(root, "build");
  const buildItems = build
    ? childElements(build, "item").map((item) => ({
        objectId: item.getAttribute("objectid") ?? "",
        transform: parseTransform(item.getAttribute("transform"), unitScale),
        printable: item.getAttribute("printable") !== "0",
      }))
    : [];

  return { name, objects, buildItems };
}

function parsePlateSettings(
  xml: Buffer,
  projectSettings: Record<string, unknown> | null,
): PlateDef[] {
  const doc = parseXmlBuffer(xml, "3MF model settings");
  const root = doc.documentElement;
  if (!root) return [];

  const objectSettings = new Map<string, { extruder?: string; supports: boolean }>();
  for (const object of childElements(root, "object")) {
    const id = object.getAttribute("id") ?? "";
    if (!id) continue;
    objectSettings.set(id, {
      extruder: metadataValue(object, "extruder") ?? undefined,
      supports: metadataValue(object, "enable_support") === "1",
    });
  }

  const projectSource = projectSourceConfig(projectSettings);
  const globalSupports = projectSupports(projectSettings);

  const plateElements = elements(root, "plate");
  if (plateElements.length > MAX_3MF_PLATES) {
    throw new ModelParseError(`3MF exceeds ${MAX_3MF_PLATES} printable plates`, "TOO_COMPLEX");
  }

  return plateElements
    .map((plate, i) => {
      const index = Number(metadataValue(plate, "plater_id")) || i + 1;
      const explicitName = metadataValue(plate, "plater_name")?.trim();
      const objectIds = childElements(plate, "model_instance")
        .map((instance) => metadataValue(instance, "object_id"))
        .filter((id): id is string => !!id);

      const configuredSupports =
        globalSupports === "auto" || objectIds.some((id) => objectSettings.get(id)?.supports);
      const supportMode: ThreeMfSourceConfig["supports"] = configuredSupports ? "auto" : "off";
      return {
        index,
        name: explicitName || `Plate ${index}`,
        objectIds,
        configuredSupports,
        sourceConfig: {
          ...projectSource,
          material: plateMaterial(objectIds, objectSettings, projectSettings) ?? projectSource.material,
          supports: supportMode,
        },
      };
    })
    .filter((plate) => plate.objectIds.length > 0);
}

function parseProjectSettings(buffer: Buffer): Record<string, unknown> | null {
  try {
    const json = buffer.toString("utf8");
    preflightJson(json);
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function preflightJson(json: string): void {
  let depth = 0;
  let structures = 0;
  let inString = false;
  let escaped = false;
  for (const char of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
      structures += 1;
      if (depth > 64 || structures > 50_000) {
        throw new ModelParseError("3MF project settings are too complex", "TOO_COMPLEX");
      }
    } else if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
    }
  }
}

function projectSourceConfig(settings: Record<string, unknown> | null): ThreeMfSourceConfig {
  if (!settings) return {};
  const source: ThreeMfSourceConfig = {};

  const material = projectMaterial(settings);
  if (material) source.material = material;

  const layerHeightUm = layerHeight(settings.layer_height);
  if (layerHeightUm != null) source.layerHeightUm = layerHeightUm;

  const infillPct = percent(settings.sparse_infill_density);
  if (infillPct != null) source.infillPct = infillPct;

  const supports = projectSupports(settings);
  if (supports) source.supports = supports;

  return source;
}

function projectSupports(settings: Record<string, unknown> | null): "auto" | "off" | undefined {
  const value = settings?.enable_support;
  if (value === "1" || value === 1 || value === true) return "auto";
  if (value === "0" || value === 0 || value === false) return "off";
  return undefined;
}

function projectMaterial(settings: Record<string, unknown>): string | undefined {
  const filamentTypes = stringArray(settings.filament_type)
    .map(normalizeMaterial)
    .filter((value): value is string => !!value);
  const unique = uniqueDefined(filamentTypes);
  return unique.length === 1 ? unique[0] : undefined;
}

function plateMaterial(
  objectIds: string[],
  objectSettings: Map<string, { extruder?: string }>,
  projectSettings: Record<string, unknown> | null,
): string | undefined {
  if (!projectSettings) return undefined;

  const materials = objectIds
    .map((id) => materialForExtruder(objectSettings.get(id)?.extruder, projectSettings))
    .filter((value): value is string => !!value);
  const unique = uniqueDefined(materials);
  return unique.length === 1 ? unique[0] : undefined;
}

function materialForExtruder(
  extruder: string | undefined,
  settings: Record<string, unknown>,
): string | undefined {
  const filamentTypes = stringArray(settings.filament_type);
  const index = Number(extruder) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= filamentTypes.length) return undefined;
  return normalizeMaterial(filamentTypes[index]);
}

function normalizeMaterial(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const upper = value.trim().toUpperCase();
  if (upper.includes("PETG")) return "PETG";
  if (upper.includes("PLA")) return "PLA";
  return undefined;
}

function layerHeight(value: unknown): number | undefined {
  const mm = numberValue(value);
  if (mm == null || mm <= 0) return undefined;
  return Math.round(mm * 1000);
}

function percent(value: unknown): number | undefined {
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(/%$/, ""));
    return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
  }
  const parsed = numberValue(value);
  return parsed == null ? undefined : Math.round(parsed);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return typeof value === "string" ? [value] : [];
}

function uniqueDefined<T>(values: readonly (T | undefined)[]): T[] {
  return [...new Set(values.filter((value): value is T => value !== undefined))];
}

/** Resolve one build item's geometry.
 *
 * `item.printable` is read but deliberately not acted on. It used to short-
 * circuit to `[]` here, which meant a part the source slicer had flagged
 * unprintable vanished from the mesh, from the slice, and from the price —
 * with no warning anywhere. Callers decide what to do with these parts; this
 * function never loses them. */
function resolveBuildItem(
  project: ThreeMfProject,
  item: BuildItem,
  budget: ResolveBudget,
): Float32Array[] {
  return resolveObject(project, project.main, item.objectId, item.transform, new Set(), budget);
}

function resolveObject(
  project: ThreeMfProject,
  entry: ModelDocument,
  id: string,
  transform: number[] | null,
  seen: Set<string>,
  budget: ResolveBudget,
  depth = 0,
): Float32Array[] {
  if (depth > MAX_COMPONENT_DEPTH) {
    throw new ModelParseError("3MF component nesting is too deep", "TOO_COMPLEX");
  }
  budget.references += 1;
  if (budget.references > MAX_COMPONENT_REFERENCES) {
    throw new ModelParseError(
      `3MF exceeds ${MAX_COMPONENT_REFERENCES} component references`,
      "TOO_COMPLEX",
    );
  }
  const targetEntry = entry.objects.has(id) ? entry : findUniqueEntryWithObject(project, id);
  if (!targetEntry) return [];

  const key = `${normalizePackagePath(targetEntry.name)}#${id}`;
  if (seen.has(key)) throw new ModelParseError("3MF contains recursive component references");
  const nextSeen = new Set(seen);
  nextSeen.add(key);

  const object = targetEntry.objects.get(id);
  if (!object) return [];
  if (object.kind === "mesh") {
    budget.triangles += object.mesh.length / 9;
    if (budget.triangles > MAX_TRIANGLES) {
      throw new ModelParseError(`3MF exceeds ${MAX_TRIANGLES} triangles`, "TOO_MANY_TRIANGLES");
    }
    return [applyTransform(object.mesh, transform)];
  }

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
        budget,
        depth + 1,
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

function meshToTriangles(
  mesh: Element,
  budget: GeometryBudget,
  unitScale: number,
): Float32Array {
  const verticesEl = firstElement(mesh, "vertices");
  const trianglesEl = firstElement(mesh, "triangles");
  if (!verticesEl || !trianglesEl) throw new ModelParseError("3MF mesh missing vertices/triangles");

  const verts: number[] = [];
  for (const v of elements(verticesEl, "vertex")) {
    verts.push(
      Number(v.getAttribute("x")) * unitScale,
      Number(v.getAttribute("y")) * unitScale,
      Number(v.getAttribute("z")) * unitScale,
    );
    budget.vertices += 1;
    if (budget.vertices > MAX_VERTICES) {
      throw new ModelParseError(`3MF exceeds ${MAX_VERTICES} vertices`, "TOO_COMPLEX");
    }
  }
  const tris = elements(trianglesEl, "triangle");
  budget.triangles += tris.length;
  if (budget.triangles > MAX_TRIANGLES) {
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

/** 3MF transform: 12 space-separated numbers, row-major 4x3. Translation is
 * expressed in the containing model part's declared unit. */
function parseTransform(attr: string | null, unitScale: number): number[] | null {
  if (!attr) return null;
  const nums = attr.trim().split(/\s+/).map(Number);
  if (nums.length === 12 && nums.every(Number.isFinite)) {
    nums[9] = nums[9]! * unitScale;
    nums[10] = nums[10]! * unitScale;
    nums[11] = nums[11]! * unitScale;
    return nums;
  }
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
      nums[12]! * unitScale,
      nums[13]! * unitScale,
      nums[14]! * unitScale,
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
