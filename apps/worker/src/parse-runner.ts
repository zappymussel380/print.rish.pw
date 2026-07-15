import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { constants } from "node:fs";
import { chmod, chown, mkdir, open, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  UUID_RE,
  parseChildOutputSchema,
  sanitizeOriginalName,
  type IngestPublicFailure,
  type ModelFormat,
  type ParseChildParams,
  type ParseChildSuccess,
} from "@print/shared";
import { config } from "./config.js";
import { killIdentityProcesses } from "./orca.js";

/** Trusted half of upload parsing: stages a verified private copy of the
 * upload, runs the parse child under a throwaway uid (see parse-child.ts), and
 * treats everything the child reports as untrusted until validated here. */

const MAX_CHILD_STDOUT_BYTES = 512 * 1024;
const MAX_THUMB_BYTES = 8 * 1024 * 1024;

export class ParseRunnerPublicError extends Error {
  constructor(readonly failure: IngestPublicFailure) {
    super(failure.code);
    this.name = "ParseRunnerPublicError";
  }
}

export interface ParseRunnerOptions {
  /** Command vector to launch the child; the params JSON is appended. */
  childCommand?: string[];
  workRoot?: string;
  timeoutMs?: number;
  /** Tests only: skip the setpriv/choom identity drop (source trees under a
   * 0o700 home are unreadable to the parser uid). Production defaults to a
   * full sandbox whenever the orchestrator runs as root. */
  sandbox?: boolean;
}

export interface ParseSourceInput {
  /** Names the private work directory; BullMQ ticket or model id. */
  jobId: string;
  sourcePath: string;
  sizeBytes: number;
  sha256: string;
  format: ModelFormat;
}

export interface PreparedParseInput extends ParseSourceInput {
  originalName: string;
}

export interface PreparedParse {
  workDir: string;
  outDir: string;
  result: ParseChildSuccess;
}

function runningAsRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/** The bundled image ships dist/parse-child.js beside this module; the tsx dev
 * server runs straight from src, where the TS entry needs the tsx binary. */
function defaultChildCommand(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const bundled = join(moduleDir, "parse-child.js");
  if (existsSync(bundled)) return [process.execPath, bundled];
  return [join(moduleDir, "../node_modules/.bin/tsx"), join(moduleDir, "parse-child.ts")];
}

async function stageParseInput(
  input: ParseSourceInput,
  workDir: string,
  sandbox: boolean,
): Promise<string> {
  if (!UUID_RE.test(input.jobId)) throw new Error("Parse job has an invalid work identity");
  const asRoot = sandbox && runningAsRoot();
  await rm(workDir, { recursive: true, force: true });
  await mkdir(dirname(workDir), { recursive: true, mode: 0o711 });
  await chmod(dirname(workDir), 0o711);
  await mkdir(workDir, { mode: 0o711 });
  const inputDir = join(workDir, "input");
  const outDir = join(workDir, "out");
  await mkdir(inputDir, { mode: 0o700 });
  await mkdir(outDir, { mode: 0o700 });
  if (asRoot) {
    await chown(outDir, config.parserUid, config.parserGid);
  }

  const staged = join(inputDir, `model.${input.format}`);
  const source = await open(input.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let copiedBytes = 0;
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size !== input.sizeBytes || info.size > config.maxUploadBytes) {
      throw new Error("Queued upload failed its file-size integrity check");
    }
    const reader = source.createReadStream({ autoClose: false });
    reader.on("data", (chunk: string | Buffer) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      copiedBytes += data.length;
      hash.update(data);
    });
    const writer = createWriteStream(staged, { flags: "wx", mode: 0o440 });
    await pipeline(reader, writer);
  } finally {
    await source.close().catch(() => {});
  }
  if (copiedBytes !== input.sizeBytes || hash.digest("hex") !== input.sha256) {
    throw new Error("Queued upload failed its hash integrity check");
  }
  if (asRoot) {
    await chown(staged, 0, config.parserGid);
    await chmod(inputDir, 0o550);
    await chown(inputDir, 0, config.parserGid);
  }
  return staged;
}

interface ChildRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderrTail: string;
}

async function runChild(
  params: ParseChildParams,
  cwd: string,
  options: ParseRunnerOptions,
): Promise<ChildRun> {
  const asRoot = (options.sandbox ?? true) && runningAsRoot();
  const base = options.childCommand ?? defaultChildCommand();
  const [command, ...args] = asRoot
    ? [
        "setpriv",
        `--reuid=${config.parserUid}`,
        `--regid=${config.parserGid}`,
        "--clear-groups",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--no-new-privs",
        "choom",
        "-n",
        "1000",
        "--",
        ...base,
      ]
    : base;
  const timeoutMs = options.timeoutMs ?? config.parseTimeoutMs;

  return await new Promise<ChildRun>((resolvePromise, rejectPromise) => {
    const child = spawn(command!, [...args, JSON.stringify(params)], {
      cwd,
      detached: true,
      // Minimal, explicit environment — never process.env: the orchestrator
      // holds DB/Redis credentials and the child parses untrusted uploads.
      env: {
        PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: process.env.LANG ?? "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "en_US.UTF-8",
        // Not sensitive, and Next's ProcessEnv augmentation marks it required
        // wherever the web tsconfig typechecks these worker sources.
        NODE_ENV: process.env.NODE_ENV,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      if (stdout.length < MAX_CHILD_STDOUT_BYTES) stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    let finished = false;
    let timedOut = false;
    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      if (asRoot) {
        try {
          await killIdentityProcesses(config.parserUid);
        } catch (err) {
          rejectPromise(err);
          setImmediate(() => process.exit(1));
          return;
        }
      }
      resolvePromise({ code, signal, timedOut, stdout, stderrTail: stderr.slice(-1200) });
    };
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      void finish(child.exitCode, null);
    }, timeoutMs);

    child.on("error", () => void finish(-1, null));
    child.on("exit", (code, signal) => void finish(code, signal));
  });
}

function parseChildOutput(run: ChildRun): ParseChildSuccess {
  if (run.timedOut) throw new Error("Parse child timed out");
  const lines = run.stdout.split("\n").filter((line) => line.trim().length > 0);
  const lastLine = lines.at(-1);
  let output: unknown;
  try {
    output = JSON.parse(lastLine ?? "");
  } catch {
    output = null;
  }
  const parsed = output === null ? null : parseChildOutputSchema.safeParse(output);

  if (run.code === 64 && parsed?.success && parsed.data.ok === false && parsed.data.publicCode) {
    throw new ParseRunnerPublicError({
      code: parsed.data.publicCode,
      message: parsed.data.message,
    });
  }
  if (run.code === 0 && parsed?.success && parsed.data.ok === true) {
    return parsed.data;
  }
  if (run.signal === "SIGKILL") {
    // Uncommanded SIGKILL is the cgroup OOM killer; choom makes the child the
    // preferred victim, so the orchestrator survives to report this.
    throw new Error("Parse child was killed, most likely out of memory");
  }
  if (run.code === 0 || run.code === 64) {
    throw new Error("Parse child broke the output contract");
  }
  throw new Error(
    `Parse child failed (code ${run.code}, signal ${run.signal}): ${run.stderrTail || "no detail"}`,
  );
}

async function verifyOutputFile(outDir: string, name: string, expectedBytes: number, maxBytes: number): Promise<void> {
  const handle = await open(join(outDir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== expectedBytes || info.size > maxBytes) {
      throw new Error("Parse child output failed its integrity check");
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function runPreparedParse(
  input: PreparedParseInput,
  options: ParseRunnerOptions = {},
): Promise<PreparedParse> {
  const workDir = join(options.workRoot ?? config.parseWorkRoot, input.jobId);
  const outDir = join(workDir, "out");
  try {
    const staged = await stageParseInput(input, workDir, options.sandbox ?? true);
    const run = await runChild(
      {
        mode: "prepare",
        inputPath: staged,
        originalName: input.originalName,
        format: input.format,
        sourceSha256: input.sha256,
        outDir,
        thumbSize: config.thumbSize,
        maxUploadBytes: config.maxUploadBytes,
      },
      workDir,
      options,
    );
    const result = parseChildOutput(run);
    if (result.models.length === 0) throw new Error("Parse child produced no models");

    const seen = new Set<string>();
    for (const model of result.models) {
      if (
        seen.has(model.fileName) ||
        (model.thumbFile && seen.has(model.thumbFile)) ||
        sanitizeOriginalName(model.originalName) !== model.originalName
      ) {
        throw new Error("Parse child metadata failed its integrity check");
      }
      seen.add(model.fileName);
      if (model.thumbFile) seen.add(model.thumbFile);
      await verifyOutputFile(outDir, model.fileName, model.sizeBytes, config.maxUploadBytes);
      if (model.thumbFile) {
        const handle = await open(
          join(outDir, model.thumbFile),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size <= 0 || info.size > MAX_THUMB_BYTES) {
            throw new Error("Parse child thumbnail failed its integrity check");
          }
        } finally {
          await handle.close().catch(() => {});
        }
      }
    }
    return { workDir, outDir, result };
  } catch (error) {
    await removeParseWorkDir(workDir).catch(() => {});
    throw error;
  }
}

export async function renderThumbnailIsolated(
  input: ParseSourceInput,
  options: ParseRunnerOptions = {},
): Promise<Buffer> {
  const workDir = join(options.workRoot ?? config.parseWorkRoot, input.jobId);
  try {
    const staged = await stageParseInput(input, workDir, options.sandbox ?? true);
    const outPath = join(workDir, "out", "thumb.png");
    const run = await runChild(
      {
        mode: "thumbnail",
        inputPath: staged,
        format: input.format,
        outPath,
        thumbSize: config.thumbSize,
        maxUploadBytes: config.maxUploadBytes,
      },
      workDir,
      options,
    );
    parseChildOutput(run);
    const handle = await open(outPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size <= 0 || info.size > MAX_THUMB_BYTES) {
        throw new Error("Parse child thumbnail failed its integrity check");
      }
      return await handle.readFile();
    } finally {
      await handle.close().catch(() => {});
    }
  } finally {
    await removeParseWorkDir(workDir).catch(() => {});
  }
}

/** Best-effort recursive removal of a runner work directory. The path shape is
 * asserted so a corrupted caller can never aim this at customer storage. */
export async function removeParseWorkDir(workDir: string): Promise<void> {
  if (!UUID_RE.test(basename(workDir))) {
    throw new Error("Refusing to remove a non-runner work directory");
  }
  await rm(workDir, { recursive: true, force: true });
}
