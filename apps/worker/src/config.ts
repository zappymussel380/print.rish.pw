import { fileURLToPath } from "node:url";

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  redisUrl: str("REDIS_URL", "redis://localhost:6379"),
  /** OrcaSlicer AppRun entrypoint inside the worker image. */
  orcaBin: str("ORCA_BIN", "/opt/orca/AppRun"),
  /** Committed, inheritance-flattened Bambu A1 profiles. */
  profilesDir: str("PROFILES_DIR", fileURLToPath(new URL("../profiles", import.meta.url))),
  /** Shared uploads volume — same path the web container mounts. */
  uploadDir: str("UPLOAD_DIR", "./data/uploads"),
  /** Per-job scratch root (fast local disk / tmpfs in production). */
  workRoot: str("SLICE_WORK_DIR", "/tmp/slice-jobs"),
  /** Writable XDG runtime dir Orca needs for its 3MF export path. */
  xdgRuntimeDir: str("XDG_RUNTIME_DIR", "/tmp/xdg"),
  orcaDataDir: str("ORCA_DATADIR", "/tmp/orca-data"),
  sliceTimeoutMs: int("SLICE_TIMEOUT_SECONDS", 180) * 1000,
  concurrency: int("WORKER_CONCURRENCY", 2),
  slicerVersion: str("ORCA_VERSION", "2.4.1"),
  thumbSize: int("THUMB_SIZE", 512),
  /** Hours to keep uploads never attached to a submitted quotation. */
  uploadRetentionHours: int("UPLOAD_RETENTION_HOURS", 48),
  /** Days to keep model files of terminal-state quotations (rows/PDFs kept). */
  fileRetentionDays: int("FILE_RETENTION_DAYS", 30),
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

export function filamentProfile(material: "PLA" | "PETG"): string {
  return material === "PETG" ? "filament.petg.json" : "filament.pla.json";
}

export const MACHINE_PROFILE = "machine.bbl-a1-04.json";
