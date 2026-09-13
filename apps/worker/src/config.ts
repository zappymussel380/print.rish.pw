import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PRINTER_SPEC, parsePrinterSpec, type MaterialId, type PrinterProfileSpec } from "@print/shared";

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function stubSlicerEnabled(
  value = process.env.STUB_SLICER,
  nodeEnv = process.env.NODE_ENV,
): boolean {
  if (value === undefined || value === "" || value === "false") return false;
  if (value !== "true") throw new Error("STUB_SLICER must be either true or false");
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    throw new Error(
      "STUB_SLICER=true is restricted to NODE_ENV=development or test and is refused otherwise",
    );
  }
  return true;
}

const MAX_QUOTATION_RETENTION_DAYS = 90;

/** The hand-tuned Bambu Lab A1 set committed with the worker. Distinct from
 *  `profilesDir` once a self-hosted shop points PROFILES_DIR at its generated
 *  set — and the installer's own profile-gen run sees that (still empty) dir. */
export const COMMITTED_PROFILES_DIR = fileURLToPath(new URL("../profiles", import.meta.url));

export const config = {
  redisUrl: str("REDIS_URL", "redis://localhost:6379"),
  /** OrcaSlicer AppRun entrypoint inside the worker image. */
  orcaBin: str("ORCA_BIN", "/opt/orca/AppRun"),
  /** Committed, inheritance-flattened Bambu A1 profiles. */
  profilesDir: str("PROFILES_DIR", COMMITTED_PROFILES_DIR),
  /** Shared uploads volume — same path the web container mounts. */
  uploadDir: str("UPLOAD_DIR", "./data/uploads"),
  pdfDir: str("PDF_DIR", "./data/pdfs"),
  /** Per-job scratch root (fast local disk / tmpfs in production). */
  workRoot: str("SLICE_WORK_DIR", "/tmp/slice-jobs"),
  sliceTimeoutMs: Math.min(int("SLICE_TIMEOUT_SECONDS", 600), 900) * 1000,
  /** Sequential by default: concurrent Orca jobs contend for the container's
   * shared CPU/memory quota, turning heavy sculpt slices into timeouts. */
  concurrency: Math.min(int("WORKER_CONCURRENCY", 1), 8),
  /** Base numeric uid/gid for untrusted Orca subprocesses. Each concurrent
   * job gets a distinct offset identity and a private staged model copy. */
  slicerUid: int("SLICER_UID", 1002),
  slicerGid: int("SLICER_GID", 3000),
  /** Identity for the isolated upload-parse child. The gid sits outside the
   * slicer range (3000 + concurrency offsets) so a parse child can never read
   * another job's staged 0o440 root:gid model copy. */
  parserUid: int("PARSER_UID", 1003),
  parserGid: int("PARSER_GID", 3100),
  parseWorkRoot: str("PARSE_WORK_DIR", "/tmp/parse-jobs"),
  parseTimeoutMs: Math.min(int("PARSE_TIMEOUT_SECONDS", 600), 900) * 1000,
  /** OpenCASCADE DRAW harness used for STEP→STL tessellation in the child. */
  stepConvertBin: str("STEP_CONVERT_BIN", "/usr/bin/occt-draw"),
  stepConvertTimeoutMs: Math.min(int("STEP_CONVERT_TIMEOUT_SECONDS", 120), 600) * 1000,
  storageUid: int("STORAGE_UID", 1001),
  storageGid: int("STORAGE_GID", 1001),
  maxUploadBytes: Math.min(int("MAX_UPLOAD_MB", 300), 300) * 1024 * 1024,
  maxSessionUploadBytes: int("MAX_SESSION_UPLOAD_MB", 900) * 1024 * 1024,
  maxModelsPerSession: int("MAX_MODELS_PER_SESSION", 20),
  storageReserveBytes: int("STORAGE_RESERVE_MB", 2048) * 1024 * 1024,
  slicerVersion: str("ORCA_VERSION", "2.4.1"),
  /** OrcaSlicer's bundled presets — what an uploaded preset's `inherits` names. */
  orcaProfilesRoot: str("ORCA_PROFILES_ROOT", "/opt/orca/resources/profiles"),
  /** Advanced mode (self-host installer): the owner uploads their own presets
   *  in the admin dashboard, and slices use them once a test slice passes. */
  advancedProfiles: process.env.ADVANCED_PROFILES === "1",
  thumbSize: Math.min(int("THUMB_SIZE", 512), 1024),
  /** Hours to keep uploads never attached to a submitted quotation. */
  uploadRetentionHours: int("UPLOAD_RETENTION_HOURS", 48),
  /** Days to keep model files of terminal-state quotations before row retention ends. */
  fileRetentionDays: int("FILE_RETENTION_DAYS", 30),
  /** Deletion threshold after an order reaches a terminal state. Policy permits
   * configuration to shorten, but never extend, the 90-day threshold. */
  quotationRetentionDays: Math.min(
    int("QUOTATION_RETENTION_DAYS", MAX_QUOTATION_RETENTION_DAYS),
    MAX_QUOTATION_RETENTION_DAYS,
  ),
  /** Local-only escape hatch. Production must run the orchestrator as root so
   * it can drop Orca to a distinct credential-free UID. */
  allowInsecureSlicer:
    process.env.NODE_ENV !== "production" && process.env.ALLOW_INSECURE_SLICER === "true",
  /** Synthetic slice measurements for the HTTP full-flow test. This is
   * deliberately refused unless NODE_ENV explicitly names development/test. */
  stubSlicer: stubSlicerEnabled(),
} as const;

/** Flattened process profile filename for a given layer height (µm). */
export function processProfile(layerHeightUm: number): string {
  switch (layerHeightUm) {
    case 120:
      return "process.0.12.json";
    case 160:
      return "process.0.16.json";
    case 200:
      return "process.0.20.json";
    default:
      throw new Error(`No process profile for layer height ${layerHeightUm}µm`);
  }
}

/** Slicer preset per material tier (scripts/overlay-numakers-profiles.py):
 *  Numakers' own for the PLA/PETG tiers, Orca's generic A1 preset for ABS/ASA.
 *  A Record, not a fallback branch, so a new material can never silently slice
 *  with another tier's temperatures and density. */
const FILAMENT_PROFILES: Record<MaterialId, string> = {
  PLA: "filament.pla.json",
  PLA_AESTHETIC: "filament.pla-aesthetic.json",
  PLA_CF: "filament.pla-cf.json",
  PETG: "filament.petg.json",
  PETG_PREMIUM: "filament.petg-premium.json",
  ABS: "filament.abs.json",
  ASA: "filament.asa.json",
};

export function filamentProfile(material: MaterialId): string {
  return FILAMENT_PROFILES[material];
}

/** A generated set (profile-gen.ts) names its machine plainly; the committed A1
 *  set keeps its historical name. */
export const MACHINE_PROFILE = existsSync(join(config.profilesDir, "machine.json"))
  ? "machine.json"
  : "machine.bbl-a1-04.json";

/** The printer this worker slices for: `printer.json` beside a generated set,
 *  the Bambu Lab A1 otherwise (the committed profiles carry none). */
export const printerSpec: PrinterProfileSpec = (() => {
  try {
    return parsePrinterSpec(JSON.parse(readFileSync(join(config.profilesDir, "printer.json"), "utf8")));
  } catch {
    return DEFAULT_PRINTER_SPEC;
  }
})();

/** One complete set of slicer profiles: the directory holding them, the
 *  machine file's name in it, and the printer they describe. */
export interface ProfileSet {
  dir: string;
  machineFile: string;
  spec: PrinterProfileSpec;
}

/** The installer-generated (or committed A1) set, with no uploads applied —
 *  what every slice uses unless advanced mode has live uploads. */
export const BASE_PROFILE_SET: ProfileSet = {
  dir: config.profilesDir,
  machineFile: MACHINE_PROFILE,
  spec: printerSpec,
};
