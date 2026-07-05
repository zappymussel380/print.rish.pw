import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import type { SliceSettings } from "@print/shared";
import { MACHINE_PROFILE, config, filamentProfile, processProfile } from "./config.js";

export interface SliceOutcome {
  ok: boolean;
  filamentGrams?: number;
  filamentMm?: number;
  printSeconds?: number;
  supportGrams?: number | null;
  slicerVersion: string;
  rawMeta: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

/** Build the per-job process profile: the flattened base for the chosen layer
 *  height with the customer's infill/support overrides merged in. The Orca CLI
 *  does NOT resolve `inherits`, so we always hand it a complete profile. */
async function writeJobProcess(workDir: string, settings: SliceSettings): Promise<string> {
  const base = JSON.parse(
    await readFile(join(config.profilesDir, processProfile(settings.layerHeightUm)), "utf8"),
  ) as Record<string, unknown>;

  base.name = "job-process";
  base.sparse_infill_density = `${settings.infillPct}%`;

  if (settings.supports === "off") {
    base.enable_support = "0";
  } else {
    base.enable_support = "1";
    if (settings.supports === "always") base.support_threshold_angle = "80";
  }

  const path = join(workDir, "job-process.json");
  await writeFile(path, JSON.stringify(base));
  return path;
}

interface RunResult {
  code: number | null;
  timedOut: boolean;
  stderrTail: string;
}

function runOrca(args: string[]): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("xvfb-run", ["-a", config.orcaBin, ...args], {
      // New process group so the timeout can kill Orca and any children.
      detached: true,
      env: {
        ...process.env,
        HOME: process.env.HOME ?? "/tmp/orca-home",
        XDG_RUNTIME_DIR: config.xdgRuntimeDir,
      },
    });

    let stderr = "";
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.stdout.on("data", () => {});

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, config.sliceTimeoutMs);

    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolvePromise({ code, timedOut, stderrTail: stderr.slice(-1200) });
    };
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code));
  });
}

/** Slice one model at the given settings. workDir must be a fresh directory. */
export async function runSlice(
  storedPath: string,
  settings: SliceSettings,
  workDir: string,
): Promise<SliceOutcome> {
  await mkdir(workDir, { recursive: true });
  await mkdir(config.xdgRuntimeDir, { recursive: true, mode: 0o700 });
  await mkdir(config.orcaDataDir, { recursive: true });

  const jobProcess = await writeJobProcess(workDir, settings);
  const machine = join(config.profilesDir, MACHINE_PROFILE);
  const filament = join(config.profilesDir, filamentProfile(settings.material));

  const run = await runOrca([
    "--datadir",
    config.orcaDataDir,
    "--load-settings",
    `${machine};${jobProcess}`,
    "--load-filaments",
    filament,
    "--orient",
    "1",
    "--arrange",
    "1",
    "--slice",
    "0",
    "--export-3mf",
    "out.3mf",
    "--outputdir",
    workDir,
    "--debug",
    "1",
    storedPath,
  ]);

  if (run.timedOut) {
    return fail("TIMEOUT", `Slicing exceeded ${Math.round(config.sliceTimeoutMs / 1000)}s`, run);
  }

  let archive: Uint8Array;
  try {
    archive = await readFile(join(workDir, "out.3mf"));
  } catch {
    return fail("NO_OUTPUT", "Slicer produced no output", run);
  }

  return parseSliceInfo(archive, run);
}

function fail(code: string, message: string, run: RunResult): SliceOutcome {
  return {
    ok: false,
    slicerVersion: config.slicerVersion,
    errorCode: code,
    errorMessage: message,
    rawMeta: { returnCode: run.code, stderrTail: run.stderrTail },
  };
}

const attr = (xml: string, re: RegExp): string | undefined => xml.match(re)?.[1];

function parseSliceInfo(archive: Uint8Array, run: RunResult): SliceOutcome {
  let xml: string;
  try {
    const files = unzipSync(archive, {
      filter: (f: { name: string }) => f.name === "Metadata/slice_info.config",
    });
    const entry = files["Metadata/slice_info.config"];
    if (!entry) return fail("NO_SLICE_INFO", "Slice metadata missing from output", run);
    xml = Buffer.from(entry).toString("utf8");
  } catch {
    return fail("BAD_OUTPUT", "Could not read slicer output archive", run);
  }

  const prediction = attr(xml, /key="prediction"\s+value="([^"]*)"/);
  const weight = attr(xml, /key="weight"\s+value="([^"]*)"/);
  const usedG = attr(xml, /used_g="([^"]*)"/);
  const usedM = attr(xml, /used_m="([^"]*)"/);
  const supportUsed = attr(xml, /key="support_used"\s+value="([^"]*)"/);
  const version = attr(xml, /OrcaSlicer-Version"\s+value="([^"]*)"/) ?? config.slicerVersion;

  const grams = num(weight) ?? num(usedG);
  const seconds = num(prediction);

  if (grams == null || grams <= 0 || seconds == null) {
    return fail("EMPTY_RESULT", "Slicer returned no filament/time data", run);
  }

  const metres = num(usedM) ?? 0;
  return {
    ok: true,
    filamentGrams: grams,
    filamentMm: metres * 1000,
    printSeconds: Math.round(seconds),
    // Orca reports only a boolean for supports, not a separate gram figure.
    supportGrams: null,
    slicerVersion: version,
    rawMeta: {
      prediction,
      weight,
      usedG,
      usedM,
      supportUsed: supportUsed === "true",
      returnCode: run.code,
    },
  };
}

function num(v: string | undefined): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}
