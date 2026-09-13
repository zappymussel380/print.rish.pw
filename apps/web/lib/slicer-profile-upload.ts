import { unzipSync } from "fflate";
import { presetKind, slotKind, type OrcaProfile, type ProfileKind, type ProfileSlot } from "@print/shared";

/**
 * Reading what an owner uploads in advanced mode: one OrcaSlicer preset
 * (.json, for the slot they chose) or a bundle OrcaSlicer exports — a printer
 * bundle (.orca_printer: the printer plus its process presets, maybe
 * filaments) or a filament bundle (.orca_filament). Only unpacking and sorting
 * happen here; the worker resolves each preset's parents, checks it fits its
 * slot and test-slices it before anything goes live.
 */

export const MAX_PROFILE_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_ENTRIES = 64;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

/** A problem with the file, shown to the owner as-is. */
export class ProfileUploadRejected extends Error {}

export interface ParsedPreset {
  /** Null for a bundle's process presets: the worker places them by layer height. */
  slot: ProfileSlot | null;
  name: string;
  raw: OrcaProfile;
}

export interface ParsedUpload {
  presets: ParsedPreset[];
  /** Presets in a bundle that this upload doesn't use, by name. */
  ignored: string[];
}

const KIND_LABEL: Record<ProfileKind, string> = { machine: "printer", process: "process", filament: "filament" };

function readPreset(text: string, label: string): OrcaProfile {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new ProfileUploadRejected(`${label} isn't valid JSON — export the preset from OrcaSlicer again.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProfileUploadRejected(`${label} isn't an OrcaSlicer preset.`);
  }
  return value as OrcaProfile;
}

function nameOf(preset: OrcaProfile, fallback: string): string {
  const name = typeof preset.name === "string" ? preset.name.trim() : "";
  return (name || fallback).slice(0, 200);
}

/** Bundles keep each kind in its own folder; used when a preset doesn't say. */
function folderKind(path: string): ProfileKind | null {
  const top = path.split("/")[0]?.toLowerCase() ?? "";
  if (top === "printer" || top === "machine") return "machine";
  if (top === "process" || top === "print") return "process";
  if (top === "filament") return "filament";
  return null;
}

const isZip = (bytes: Uint8Array) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);

export function parseProfileUpload(bytes: Uint8Array, fileName: string, slot: ProfileSlot | null): ParsedUpload {
  if (isZip(bytes)) return parseBundle(bytes, slot);
  if (!slot) throw new ProfileUploadRejected("Upload a single preset on the row it's for.");
  const raw = readPreset(decode(bytes), fileName);
  const kind = presetKind(raw);
  const want = slotKind(slot);
  if (kind && kind !== want) {
    throw new ProfileUploadRejected(`That's a ${KIND_LABEL[kind]} preset; this row needs a ${KIND_LABEL[want]} preset.`);
  }
  return { presets: [{ slot, name: nameOf(raw, fileName), raw }], ignored: [] };
}

function parseBundle(bytes: Uint8Array, slot: ProfileSlot | null): ParsedUpload {
  let entries: Record<string, Uint8Array>;
  let seen = 0;
  let total = 0;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        if (++seen > MAX_BUNDLE_ENTRIES) throw new ProfileUploadRejected("That bundle holds too many files.");
        const name = file.name.toLowerCase();
        if (!name.endsWith(".json") || name.startsWith("__macosx/") || name.endsWith("bundle_structure.json")) return false;
        total += file.originalSize;
        if (file.originalSize > MAX_ENTRY_BYTES || total > MAX_BUNDLE_BYTES) {
          throw new ProfileUploadRejected("That bundle is too large once unpacked.");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ProfileUploadRejected) throw error;
    throw new ProfileUploadRejected("That file isn't a readable OrcaSlicer bundle (.orca_printer or .orca_filament).");
  }

  const found = Object.entries(entries).map(([path, data]) => {
    const raw = readPreset(decode(data), path);
    return { path, raw, name: nameOf(raw, path), kind: presetKind(raw) ?? folderKind(path) };
  });
  const machines = found.filter((p) => p.kind === "machine");
  const processes = found.filter((p) => p.kind === "process");
  const filaments = found.filter((p) => p.kind === "filament");

  if (machines.length > 1) {
    throw new ProfileUploadRejected("That bundle holds more than one printer preset — export one printer at a time.");
  }
  if (machines.length === 1) {
    if (slot && slot !== "machine") throw new ProfileUploadRejected("That's a printer bundle — upload it on the Printer row.");
    return {
      presets: [
        { slot: "machine", name: machines[0]!.name, raw: machines[0]!.raw },
        ...processes.map((p) => ({ slot: null, name: p.name, raw: p.raw })),
      ],
      ignored: filaments.map((p) => p.name),
    };
  }
  if (filaments.length > 0) {
    if (!slot || slotKind(slot) !== "filament") {
      throw new ProfileUploadRejected("That's a filament bundle — upload it on the row of the material it's for.");
    }
    if (filaments.length > 1) {
      throw new ProfileUploadRejected(
        `That bundle holds ${filaments.length} filament presets (${filaments.map((p) => p.name).join(", ")}). ` +
          "Export just the one for this printer, or upload its .json.",
      );
    }
    return { presets: [{ slot, name: filaments[0]!.name, raw: filaments[0]!.raw }], ignored: processes.map((p) => p.name) };
  }
  throw new ProfileUploadRejected("There's no printer or filament preset in that bundle.");
}
