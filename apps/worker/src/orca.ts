import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, chown, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { extractZipEntry, PREARRANGED_PLATE_STL_HEADER } from "@print/geometry";
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

export interface OrcaProgress {
  percent: number;
  message: string;
}

export interface SlicerIdentity {
  uid: number;
  gid: number;
}

export interface SlicerInput {
  storedPath: string;
  fileHash: string;
  sizeBytes: number;
  format: string;
}

const MAX_SLICER_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_SLICER_RESULT_BYTES = 64 * 1024;
const MAX_SLICE_INFO_BYTES = 512 * 1024;
const MAX_FILAMENT_GRAMS = 50_000;
const MAX_FILAMENT_METRES = 100_000;
const MAX_PRINT_SECONDS = 365 * 24 * 60 * 60;

export function parseOrcaProgressLine(line: string): OrcaProgress | null {
  try {
    const value = JSON.parse(line) as { total_percent?: unknown; message?: unknown };
    if (typeof value.total_percent !== "number" || !Number.isFinite(value.total_percent)) return null;
    const message =
      typeof value.message === "string"
        // eslint-disable-next-line no-control-regex
        ? value.message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120)
        : "Slicing model";
    return {
      percent: Math.min(95, Math.max(1, Math.round(value.total_percent))),
      message: message || "Slicing model",
    };
  } catch {
    return null;
  }
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
  // The flattened profiles do not carry a bed selection, and Orca defaults to
  // Cool Plate. PETG is invalid on Cool Plate, so pin the actual A1 build plate.
  base.curr_bed_type = "Textured PEI Plate";

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
  stdoutTail: string;
  stderrTail: string;
}

async function createProgressPipe(path: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("mkfifo", ["-m", "600", path], { stdio: "ignore" });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`mkfifo exited with status ${code}`));
    });
  });
}

async function runOrca(
  args: string[],
  cwd: string,
  identity: SlicerIdentity,
  onProgress?: (progress: OrcaProgress) => void,
): Promise<RunResult> {
  const pipePath = join(cwd, "orca-progress.pipe");
  await createProgressPipe(pipePath);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    await chown(pipePath, identity.uid, identity.gid);
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let progressBuffer = "";
    const progressStream = createReadStream(pipePath, { encoding: "utf8" });
    progressStream.on("data", (chunk: string | Buffer) => {
      progressBuffer += chunk.toString();
      if (progressBuffer.length > 8192) progressBuffer = progressBuffer.slice(-8192);
      let newline = progressBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = progressBuffer.slice(0, newline).trim();
        progressBuffer = progressBuffer.slice(newline + 1);
        const progress = line ? parseOrcaProgressLine(line) : null;
        if (progress) onProgress?.(progress);
        newline = progressBuffer.indexOf("\n");
      }
    });
    progressStream.on("error", () => {});

    const orcaArgs = [...args.slice(0, -1), "--pipe", pipePath, args.at(-1)!];
    const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
    const command = runningAsRoot ? "setpriv" : "xvfb-run";
    const commandArgs = runningAsRoot
      ? [
          `--reuid=${identity.uid}`,
          `--regid=${identity.gid}`,
          "--clear-groups",
          "--bounding-set=-all",
          "--inh-caps=-all",
          "--ambient-caps=-all",
          "--no-new-privs",
          "xvfb-run",
          "-a",
          config.orcaBin,
          ...orcaArgs,
        ]
      : ["-a", config.orcaBin, ...orcaArgs];
    const child = spawn(command, commandArgs, {
      cwd,
      // New process group so the timeout can kill Orca and any children.
      detached: true,
      // Minimal, explicit environment — never `...process.env`: the worker's
      // own env holds DB/Redis credentials, and Orca parses untrusted uploads,
      // so a slicer exploit must find nothing to exfiltrate. Everything Orca
      // needs beyond this (datadir, profiles, output dir) travels as CLI args.
      env: {
        PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: join(cwd, "home"),
        LANG: process.env.LANG ?? "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "en_US.UTF-8",
        XDG_RUNTIME_DIR: join(cwd, "xdg"),
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
      if (stdout.length > 8000) stdout = stdout.slice(-8000);
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    let finished = false;
    let timedOut = false;
    // Declared before `finish` because that callback can run before the timer
    // is armed (for example, on an immediate child-process error).
    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = async (code: number | null) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      progressStream.destroy();
      // Do not wait for `close`: an escaped descendant can inherit these pipe
      // descriptors and keep Node waiting forever after the original process
      // exits. Closing our readers plus UID reaping makes completion independent
      // of attacker-controlled descriptor lifetimes.
      child.stdout.destroy();
      child.stderr.destroy();
      await rm(pipePath, { force: true }).catch(() => {});
      // A compromised native child can call setsid() and escape its original
      // process group. Unique per-job UIDs let the trusted orchestrator reap
      // any such descendants before that identity is reused.
      if (runningAsRoot) {
        try {
          await killIdentityProcesses(identity.uid);
        } catch (err) {
          // Reusing this UID would restore cross-job/credential exposure. Reject
          // the job and terminate the orchestrator so Compose gives us a clean
          // process namespace before any more untrusted work starts.
          rejectPromise(err);
          setImmediate(() => process.exit(1));
          return;
        }
      }
      resolvePromise({
        code,
        timedOut,
        stdoutTail: stdout.slice(-1200),
        stderrTail: stderr.slice(-1200),
      });
    };
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone or escaped its original process group */
      }
      void finish(child.exitCode);
    }, config.sliceTimeoutMs);

    child.on("error", () => void finish(-1));
    // `exit` is independent of inherited stdio handles; `close` is not.
    child.on("exit", (code) => void finish(code));
  });
}

async function killIdentityProcesses(uid: number): Promise<void> {
  for (let pass = 0; pass < 8; pass++) {
    let found = false;
    const entries = await readdir("/proc");
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      let status: string;
      try {
        status = await readFile(`/proc/${entry}/status`, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      const processUid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
      if (processUid !== uid) continue;
      found = true;
      try {
        process.kill(pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    }
    if (!found) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Could not reap every process for isolated slicer uid ${uid}`);
}

/** Slice one model at the given settings. The original upload is never exposed
 * to Orca; a verified private copy is staged into this job's scratch directory. */
export async function runSlice(
  input: SlicerInput,
  settings: SliceSettings,
  workDir: string,
  identity: SlicerIdentity,
  onProgress?: (progress: OrcaProgress) => void,
): Promise<SliceOutcome> {
  onProgress?.({ percent: 1, message: "Preparing model" });
  await mkdir(config.workRoot, { recursive: true, mode: 0o711 });
  await chmod(config.workRoot, 0o711);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { mode: 0o700 });
  const runtimeDirs = [join(workDir, "home"), join(workDir, "xdg"), join(workDir, "orca-data")];
  for (const dir of runtimeDirs) await mkdir(dir, { recursive: true, mode: 0o700 });
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    await chown(workDir, identity.uid, identity.gid);
    for (const dir of runtimeDirs) await chown(dir, identity.uid, identity.gid);
  }

  const inputDir = join(workDir, "input");
  await mkdir(inputDir, { mode: 0o550 });
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    await chown(inputDir, 0, identity.gid);
  }
  await chmod(inputDir, 0o550);
  const stagedPath = join(inputDir, `model.${input.format}`);
  await stageModel(input, stagedPath, identity);

  const jobProcess = await writeJobProcess(workDir, settings);
  const machine = join(config.profilesDir, MACHINE_PROFILE);
  const filament = join(config.profilesDir, filamentProfile(settings.material));
  const prearrangedPlate = await isPrearrangedPlateStl(stagedPath);

  const args = [
    "--datadir",
    join(workDir, "orca-data"),
    "--load-settings",
    `${machine};${jobProcess}`,
    "--load-filaments",
    filament,
    "--orient",
    prearrangedPlate ? "0" : "1",
    "--arrange",
    prearrangedPlate ? "0" : "1",
    "--slice",
    "0",
    "--export-3mf",
    "out.3mf",
    "--outputdir",
    workDir,
    "--debug",
    "1",
    "--logfile",
    join(workDir, "orca.log"),
  ];
  if (prearrangedPlate) args.push("--ensure-on-bed");
  args.push(stagedPath);

  const run = await runOrca(args, workDir, identity, onProgress);

  if (run.timedOut) {
    return fail("TIMEOUT", `Slicing exceeded ${Math.round(config.sliceTimeoutMs / 1000)}s`, run);
  }

  let archive: Uint8Array;
  try {
    onProgress?.({ percent: 97, message: "Reading slice results" });
    archive = await readRegularFile(
      join(workDir, "out.3mf"),
      MAX_SLICER_ARCHIVE_BYTES,
      "Slicer output archive",
    );
  } catch {
    const detail = await describeMissingOutput(workDir, run);
    return fail(detail.code, detail.message, run, detail.rawMeta);
  }

  return parseSliceInfo(archive, run);
}

async function stageModel(
  input: SlicerInput,
  destination: string,
  identity: SlicerIdentity,
): Promise<void> {
  const source = await open(input.storedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let copiedBytes = 0;
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size !== input.sizeBytes || info.size > config.maxUploadBytes) {
      throw new Error("Stored model failed the worker input integrity check");
    }
    const reader = source.createReadStream({ autoClose: false });
    reader.on("data", (chunk: string | Buffer) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      copiedBytes += data.length;
      hash.update(data);
    });
    const writer = createWriteStream(destination, { flags: "wx", mode: 0o440 });
    await pipeline(reader, writer);
  } finally {
    await source.close().catch(() => {});
  }

  if (copiedBytes !== input.sizeBytes || hash.digest("hex") !== input.fileHash) {
    await rm(destination, { force: true });
    throw new Error("Stored model hash changed before slicing");
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    await chown(destination, 0, identity.gid);
  }
  await chmod(destination, 0o440);
}

async function readRegularFile(path: string, maxBytes: number, label: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) {
      throw new Error(`${label} has an invalid size or type`);
    }
    const data = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} changed while being read`);
      offset += bytesRead;
    }
    return data;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function isPrearrangedPlateStl(storedPath: string): Promise<boolean> {
  if (!storedPath.toLowerCase().endsWith(".stl")) return false;
  const header = Buffer.alloc(80);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(storedPath, "r");
    await handle.read(header, 0, header.length, 0);
    return header.toString("ascii").startsWith(PREARRANGED_PLATE_STL_HEADER);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function fail(
  code: string,
  message: string,
  run: RunResult,
  rawMeta: Record<string, unknown> = {},
): SliceOutcome {
  return {
    ok: false,
    slicerVersion: config.slicerVersion,
    errorCode: code,
    errorMessage: message,
    rawMeta: {
      returnCode: run.code,
      stdoutTail: run.stdoutTail,
      stderrTail: run.stderrTail,
      ...rawMeta,
    },
  };
}

async function describeMissingOutput(
  workDir: string,
  run: RunResult,
): Promise<{ code: string; message: string; rawMeta?: Record<string, unknown> }> {
  const result = await readOrcaResult(workDir);
  const errorString =
    result && typeof result.error_string === "string"
      ? cleanChildMessage(result.error_string, 500)
      : "";
  const stdoutDetail = usefulStdoutDetail(run.stdoutTail);

  if (errorString) {
    return {
      code: "SLICER_REJECTED_MODEL",
      message: stdoutDetail ? `${sentence(errorString)} ${stdoutDetail}` : sentence(errorString),
      rawMeta: { orcaError: errorString },
    };
  }
  if (stdoutDetail) {
    return {
      code: "SLICER_NO_OUTPUT",
      message: `Slicer produced no output. ${stdoutDetail}`,
      rawMeta: errorString ? { orcaError: errorString } : undefined,
    };
  }
  return {
    code: "NO_OUTPUT",
    message: "Slicer produced no output",
    rawMeta: errorString ? { orcaError: errorString } : undefined,
  };
}

async function readOrcaResult(workDir: string): Promise<Record<string, unknown> | null> {
  try {
    const data = await readRegularFile(
      join(workDir, "result.json"),
      MAX_SLICER_RESULT_BYTES,
      "Slicer result",
    );
    return JSON.parse(data.toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function cleanChildMessage(value: string, maxLength: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function usefulStdoutDetail(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const paramHeader = lines.findIndex((line) => line.includes("Param values"));
  if (paramHeader >= 0 && lines[paramHeader + 1]) return lines[paramHeader + 1]!;
  return "";
}

function sentence(message: string): string {
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

const attr = (xml: string, re: RegExp, maxLength = 128): string | undefined => {
  const value = xml.match(re)?.[1];
  return value === undefined ? undefined : cleanChildMessage(value, maxLength);
};

function parseSliceInfo(archive: Uint8Array, run: RunResult): SliceOutcome {
  let xml: string;
  try {
    const entry = extractZipEntry(
      Buffer.from(archive),
      (name) => name === "Metadata/slice_info.config",
      { maxEntryBytes: MAX_SLICE_INFO_BYTES, maxExtractedBytes: MAX_SLICE_INFO_BYTES },
    );
    if (!entry) return fail("NO_SLICE_INFO", "Slice metadata missing from output", run);
    xml = entry.toString("utf8");
  } catch {
    return fail("BAD_OUTPUT", "Could not read slicer output archive", run);
  }

  const prediction = attr(xml, /key="prediction"\s+value="([^"]*)"/);
  const weight = attr(xml, /key="weight"\s+value="([^"]*)"/);
  const usedG = attr(xml, /used_g="([^"]*)"/);
  const usedM = attr(xml, /used_m="([^"]*)"/);
  const supportUsed = attr(xml, /key="support_used"\s+value="([^"]*)"/);
  const version = attr(xml, /OrcaSlicer-Version"\s+value="([^"]*)"/, 64) ?? config.slicerVersion;

  const grams = num(weight) ?? num(usedG);
  const seconds = num(prediction);

  if (
    grams == null ||
    grams <= 0 ||
    grams > MAX_FILAMENT_GRAMS ||
    seconds == null ||
    seconds <= 0 ||
    seconds > MAX_PRINT_SECONDS
  ) {
    return fail("EMPTY_RESULT", "Slicer returned no filament/time data", run);
  }

  const metres = num(usedM) ?? 0;
  if (metres < 0 || metres > MAX_FILAMENT_METRES) {
    return fail("INVALID_RESULT", "Slicer returned implausible filament data", run);
  }
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
