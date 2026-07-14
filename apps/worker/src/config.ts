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

export const config = {
  redisUrl: str("REDIS_URL", "redis://localhost:6379"),
  /** OrcaSlicer AppRun entrypoint inside the worker image. */
  orcaBin: str("ORCA_BIN", "/opt/orca/AppRun"),
  /** Committed, inheritance-flattened Bambu A1 profiles. */
  profilesDir: str("PROFILES_DIR", fileURLToPath(new URL("../profiles", import.meta.url))),
  /** Shared uploads volume — same path the web container mounts. */
  uploadDir: str("UPLOAD_DIR", "./data/uploads"),
  pdfDir: str("PDF_DIR", "./data/pdfs"),
  /** Per-job scratch root (fast local disk / tmpfs in production). */
  workRoot: str("SLICE_WORK_DIR", "/tmp/slice-jobs"),
  sliceTimeoutMs: Math.min(int("SLICE_TIMEOUT_SECONDS", 600), 900) * 1000,
  concurrency: Math.min(int("WORKER_CONCURRENCY", 2), 8),
  /** Base numeric uid/gid for untrusted Orca subprocesses. Each concurrent
   * job gets a distinct offset identity and a private staged model copy. */
  slicerUid: int("SLICER_UID", 1002),
  slicerGid: int("SLICER_GID", 3000),
  storageUid: int("STORAGE_UID", 1001),
  storageGid: int("STORAGE_GID", 1001),
  maxUploadBytes: Math.min(int("MAX_UPLOAD_MB", 300), 300) * 1024 * 1024,
  maxSessionUploadBytes: int("MAX_SESSION_UPLOAD_MB", 900) * 1024 * 1024,
  maxModelsPerSession: int("MAX_MODELS_PER_SESSION", 20),
  storageReserveBytes: int("STORAGE_RESERVE_MB", 2048) * 1024 * 1024,
  slicerVersion: str("ORCA_VERSION", "2.4.1"),
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

export function filamentProfile(material: "PLA" | "PETG"): string {
  return material === "PETG" ? "filament.petg.json" : "filament.pla.json";
}

export const MACHINE_PROFILE = "machine.bbl-a1-04.json";
