import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** STEP → STL tessellation via OpenCASCADE's DRAW harness (`occt-draw`).
 *
 * Runs inside the parse child, so it inherits the full upload sandbox:
 * throwaway uid, `choom -n 1000`, and the orchestrator's overall parse
 * timeout. DRAW always exits 0, even when it abandons the script, so success
 * is detected by the stdout sentinel AND the output file existing — never by
 * the exit code. */

export const DEFAULT_STEP_CONVERT_BIN = "/usr/bin/occt-draw-7.6";
const DEFAULT_TIMEOUT_MS = 120_000;
/** Tessellation of a CAD solid can legitimately outgrow its STEP source. */
const DEFAULT_MAX_STL_BYTES = 512 * 1024 * 1024;
/** Print-resolution tessellation: 0.05 mm max deviation from the true surface. */
const LINEAR_DEFLECTION_MM = 0.05;
const HEADER_PROBE_BYTES = 1024;
const SENTINEL = "STEP_CONVERT_OK";

export class StepConvertError extends Error {
  constructor(
    readonly publicCode: string,
    message: string,
  ) {
    super(message);
    this.name = "StepConvertError";
  }
}

export interface StepConvertOptions {
  bin?: string;
  timeoutMs?: number;
  maxStlBytes?: number;
}

async function assertStepHeader(inputPath: string): Promise<void> {
  const handle = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const probe = Buffer.alloc(HEADER_PROBE_BYTES);
    const { bytesRead } = await handle.read(probe, 0, HEADER_PROBE_BYTES, 0);
    if (!probe.subarray(0, bytesRead).toString("latin1").includes("ISO-10303-21")) {
      throw new StepConvertError(
        "STEP_INVALID",
        "This does not look like a STEP file — export STL or 3MF from your CAD tool",
      );
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

function runConverter(
  bin: string,
  scriptPath: string,
  scratchDir: string,
  timeoutMs: number,
): Promise<{ stdout: string; timedOut: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, ["-b", "-f", scriptPath], {
      cwd: scratchDir,
      // DRAW insists on writing caches under HOME; keep everything in scratch.
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratchDir, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (b: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += b.toString();
    });
    child.stderr.on("data", () => {});

    let finished = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    // `exit`, not `close`: a killed DRAW can leave grandchildren holding the
    // stdio pipes open, and the sandbox's overall cleanup reaps those.
    child.on("exit", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolvePromise({ stdout, timedOut });
    });
  });
}

/** Convert a STEP file to a binary STL and return its bytes. `scratchDir`
 * must be writable by the current (sandboxed) identity; the Tcl script and
 * the intermediate STL live there and are removed with the work directory. */
export async function convertStepToStl(
  inputPath: string,
  scratchDir: string,
  options: StepConvertOptions = {},
): Promise<Buffer> {
  const bin = options.bin ?? DEFAULT_STEP_CONVERT_BIN;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStlBytes = options.maxStlBytes ?? DEFAULT_MAX_STL_BYTES;

  await assertStepHeader(inputPath);

  const outPath = join(scratchDir, "step-converted.stl");
  const scriptPath = join(scratchDir, "step-convert.tcl");
  // Both paths are orchestrator-controlled (work dir + staged upload name);
  // no customer-supplied text reaches the script.
  const script = [
    "pload ALL",
    `ReadStep D ${inputPath}`,
    "XGetOneShape shape D",
    `incmesh shape ${LINEAR_DEFLECTION_MM}`,
    `writestl shape ${outPath} 1`,
    `puts ${SENTINEL}`,
    "exit",
    "",
  ].join("\n");
  await writeFile(scriptPath, script, { flag: "wx", mode: 0o600 });

  let run: { stdout: string; timedOut: boolean };
  try {
    run = await runConverter(bin, scriptPath, scratchDir, timeoutMs);
  } catch {
    throw new StepConvertError(
      "STEP_CONVERT_FAILED",
      "This STEP file could not be converted — export STL or 3MF from your CAD tool",
    );
  }
  if (run.timedOut) {
    throw new StepConvertError(
      "STEP_CONVERT_TIMEOUT",
      "This STEP file took too long to convert — export STL or 3MF from your CAD tool",
    );
  }

  let size: number;
  try {
    size = (await stat(outPath)).size;
  } catch {
    size = 0;
  }
  if (!run.stdout.includes(SENTINEL) || size <= 0) {
    throw new StepConvertError(
      "STEP_CONVERT_FAILED",
      "This STEP file could not be converted — export STL or 3MF from your CAD tool",
    );
  }
  if (size > maxStlBytes) {
    throw new StepConvertError(
      "STEP_MESH_TOO_LARGE",
      "This STEP file produces too large a mesh — export a decimated STL from your CAD tool",
    );
  }
  return await readFile(outPath);
}
