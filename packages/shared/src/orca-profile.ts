import { z } from "zod";
import { LAYER_HEIGHTS_UM, MATERIAL_IDS, type LayerHeightUm, type MaterialId } from "./quote-types";
import type { PrinterProfileSpec } from "./printer";

/**
 * OrcaSlicer presets as this shop handles them: generated from Orca's bundled
 * presets for the printer the installer picked (apps/worker/src/profile-gen.ts)
 * and, in advanced mode, uploaded by the owner from their own OrcaSlicer
 * (the admin Slicer profiles section). Both paths end in the same flattened,
 * CLI-safe files, so both share the cleaning and the spec derivation here.
 */
export type OrcaProfile = Record<string, unknown>;
export type ProfileKind = "machine" | "process" | "filament";

/** Where an uploaded preset goes: the printer, one of the three layer heights
 *  we quote, or one material tier's filament. */
export type ProfileSlot = "machine" | `process:${LayerHeightUm}` | `filament:${MaterialId}`;

export const PROFILE_SLOTS: readonly ProfileSlot[] = [
  "machine",
  ...LAYER_HEIGHTS_UM.map((um) => `process:${um}` as const),
  ...MATERIAL_IDS.map((m) => `filament:${m}` as const),
];

export function isProfileSlot(value: unknown): value is ProfileSlot {
  return typeof value === "string" && (PROFILE_SLOTS as readonly string[]).includes(value);
}

export function slotKind(slot: ProfileSlot): ProfileKind {
  return slot === "machine" ? "machine" : slot.startsWith("process:") ? "process" : "filament";
}

export function slotLayerUm(slot: ProfileSlot): LayerHeightUm | null {
  return slot.startsWith("process:") ? (Number(slot.slice(8)) as LayerHeightUm) : null;
}

export function slotMaterial(slot: ProfileSlot): MaterialId | null {
  return slot.startsWith("filament:") ? (slot.slice(9) as MaterialId) : null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The file a slot's preset lives in inside a profile set. The machine file's
 *  name differs between the committed A1 set and generated ones. */
export function slotFileName(slot: ProfileSlot, machineFile: string): string {
  const um = slotLayerUm(slot);
  if (um) return `process.${(um / 1000).toFixed(2)}.json`;
  const material = slotMaterial(slot);
  if (material) return `filament.${slug(material)}.json`;
  return machineFile;
}

/** Orca stores most values as strings, per-extruder ones as string arrays. */
export function firstValue(v: unknown): string {
  return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
}

/** Build volume [width, depth, height] in mm from a machine preset. */
export function bedOf(machine: OrcaProfile): [number, number, number] {
  const pts = (Array.isArray(machine.printable_area) ? machine.printable_area : []).map((p) =>
    String(p).split("x").map(Number),
  );
  const xs = pts.map((p) => p[0] ?? 0);
  const ys = pts.map((p) => p[1] ?? 0);
  const width = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  const depth = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
  return [Math.round(width), Math.round(depth), Math.round(Number(firstValue(machine.printable_height)) || 0)];
}

// Plates in the order we'd rather print on, with the filament key giving its bed
// temperature; a filament that leaves a plate at 0 can't be printed on it.
const PLATES: [string, string][] = [
  ["Textured PEI Plate", "textured_plate_temp"],
  ["High Temp Plate", "hot_plate_temp"],
  ["Cool Plate", "cool_plate_temp"],
  ["Engineering Plate", "eng_plate_temp"],
];

export function plateFor(filament: OrcaProfile): string {
  for (const [plate, key] of PLATES) if (Number(firstValue(filament[key])) > 0) return plate;
  return "Textured PEI Plate";
}

/** What a preset is, from its explicit `type` or the keys only that kind has.
 *  A user preset exported from OrcaSlicer carries its `*_settings_id`. */
export function presetKind(p: OrcaProfile): ProfileKind | null {
  const type = typeof p.type === "string" ? p.type.toLowerCase() : "";
  if (type === "machine" || type === "printer") return "machine";
  if (type === "filament") return "filament";
  if (type === "process" || type === "print") return "process";
  if ("printer_settings_id" in p || "printable_area" in p || "machine_start_gcode" in p) return "machine";
  if ("filament_settings_id" in p || "filament_type" in p) return "filament";
  if ("print_settings_id" in p || "layer_height" in p) return "process";
  return null;
}

// Keys that must never reach the CLI. Export-side bookkeeping (see
// overlay-numakers-profiles.py: `filament_notes` as a bare "" aborts Orca 2.4.1
// before slicing), plus everything that would make Orca act beyond slicing:
// `post_process` runs scripts on the output, the print-host keys upload it
// somewhere, and `filename_format` names output files.
const DROP_KEYS = new Set([
  "inherits",
  "setting_id",
  "filament_notes",
  "__vendor",
  "post_process",
  "filename_format",
]);
const DROP_KEY_RE = /^(print_?host|printhost|bbl_use_printhost)/;

export function isDroppedKey(key: string): boolean {
  return DROP_KEYS.has(key) || DROP_KEY_RE.test(key);
}

/** A flattened preset turned into one the CLI loads as-is: a named system
 *  preset of its kind, and for process/filament one bound to our machine. */
export function cleanProfile(profile: OrcaProfile, kind: ProfileKind, name: string, machineName: string): OrcaProfile {
  const out: OrcaProfile = {};
  for (const [key, value] of Object.entries(profile)) if (!isDroppedKey(key)) out[key] = value;
  out.type = kind;
  out.name = name;
  out.from = "system";
  out.instantiation = "true";
  if (kind !== "machine") {
    out.compatible_printers = [machineName];
    delete out.compatible_printers_condition;
  }
  return out;
}

/** The material family a tier's filament must belong to (Orca `filament_type`). */
const FILAMENT_FAMILY: Record<MaterialId, { re: RegExp; label: string }> = {
  PLA: { re: /^PLA/i, label: "PLA" },
  PLA_AESTHETIC: { re: /^PLA/i, label: "PLA" },
  PLA_CF: { re: /^PLA/i, label: "PLA" },
  PETG: { re: /^(PETG|PET|PCTG)/i, label: "PETG" },
  PETG_PREMIUM: { re: /^(PETG|PET|PCTG)/i, label: "PETG" },
  ABS: { re: /^ABS/i, label: "ABS" },
  ASA: { re: /^ASA/i, label: "ASA" },
  // The shop's own materials are whatever the shop says they are.
  OTHER_1: { re: /./, label: "filament" },
  OTHER_2: { re: /./, label: "filament" },
  OTHER_3: { re: /./, label: "filament" },
  OTHER_4: { re: /./, label: "filament" },
};

const KIND_LABEL: Record<ProfileKind, string> = { machine: "printer", process: "process", filament: "filament" };

/** Why a flattened preset can't fill a slot, or null when it can. */
export function slotMismatch(flat: OrcaProfile, slot: ProfileSlot): string | null {
  const want = slotKind(slot);
  const kind = presetKind(flat);
  if (kind && kind !== want) {
    return `This is a ${KIND_LABEL[kind]} preset; this slot needs a ${KIND_LABEL[want]} preset.`;
  }
  if (want === "machine") {
    const nozzles = Array.isArray(flat.nozzle_diameter) ? flat.nozzle_diameter : [flat.nozzle_diameter];
    if (nozzles.length !== 1) return "Only single-extruder printers are supported (this preset has several nozzles).";
    const nozzle = Number(firstValue(nozzles));
    if (!(nozzle >= 0.2 && nozzle <= 1.2)) return "The printer preset has no usable nozzle diameter.";
    if (String(flat.printer_technology ?? "FFF") !== "FFF") return "Only filament (FFF) printers are supported.";
    if (bedOf(flat).some((d) => d <= 0)) return "The printer preset has no build volume (printable_area / printable_height).";
    return null;
  }
  const um = slotLayerUm(slot);
  if (um) {
    const mm = Number(firstValue(flat.layer_height));
    if (Math.abs(mm - um / 1000) > 1e-6) {
      return `This process preset has a ${mm || "?"} mm layer height; this slot is ${(um / 1000).toFixed(2)} mm.`;
    }
    return null;
  }
  const material = slotMaterial(slot)!;
  const type = firstValue(flat.filament_type);
  const family = FILAMENT_FAMILY[material];
  if (!family.re.test(type)) {
    return `This preset is ${type || "an unknown filament type"}; this slot needs a ${family.label} preset.`;
  }
  if (!(Number(firstValue(flat.filament_density)) > 0)) return "The filament preset has no density, so grams can't be worked out.";
  return null;
}

/** What the rest of the app needs to know about an active upload, stored with
 *  it so the web never has to read the (large) preset itself. */
export const profileUploadMetaSchema = z.object({
  presetName: z.string().max(300),
  bedMm: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).optional(),
  nozzleMm: z.number().positive().optional(),
  plate: z.string().max(80).optional(),
});
export type ProfileUploadMeta = z.infer<typeof profileUploadMetaSchema>;

export interface ActiveProfileUpload {
  id: string;
  slot: string;
  meta: unknown;
}

/** Short, stable fingerprint of a set of uploads (not security relevant — it
 *  only keeps slices cached under one set of presets from being reused). */
export function profileRevision(ids: readonly string[]): string {
  const text = [...ids].sort().join(",");
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, "0");
}

/** The printer spec with the owner's active uploads applied: their printer's
 *  build volume and nozzle, the plate each uploaded filament prints on, and an
 *  id carrying the upload revision — it's part of every slice cache key, so a
 *  changed preset never reuses slices made with the old one. Web and worker
 *  both derive it from the same rows, so their keys agree. */
export function applyActiveProfiles(base: PrinterProfileSpec, uploads: readonly ActiveProfileUpload[]): PrinterProfileSpec {
  const active = uploads.filter((u) => isProfileSlot(u.slot));
  if (active.length === 0) return base;
  const spec: PrinterProfileSpec = {
    ...base,
    plates: { ...base.plates },
    filamentPresets: { ...base.filamentPresets },
    id: `${base.id}-r${profileRevision(active.map((u) => u.id))}`,
  };
  for (const upload of active) {
    const meta = profileUploadMetaSchema.safeParse(upload.meta);
    if (!meta.success) continue;
    const slot = upload.slot as ProfileSlot;
    if (slot === "machine") {
      if (meta.data.bedMm) spec.bedMm = meta.data.bedMm;
      if (meta.data.nozzleMm) spec.nozzleMm = meta.data.nozzleMm;
      spec.machine = meta.data.presetName;
    }
    const material = slotMaterial(slot);
    if (material) {
      if (meta.data.plate) spec.plates[material] = meta.data.plate;
      spec.filamentPresets![material] = meta.data.presetName;
    }
  }
  return spec;
}

/** BullMQ queue for testing uploaded presets before they go live. */
export const SLICER_PROFILE_QUEUE = "slicer-profile";

export interface SlicerProfileJobData {
  batchId: string;
}

/** Colon-free (BullMQ uses `:` as its key separator). */
export function slicerProfileJobId(batchId: string): string {
  return `profile_${batchId}`;
}
