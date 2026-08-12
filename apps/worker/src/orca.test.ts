import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeMissingOutput, orcaChildEnv, orcaCommand, parseOrcaProgressLine } from "./orca";

describe("parseOrcaProgressLine", () => {
  it("reads Orca's total percentage and operation message", () => {
    expect(
      parseOrcaProgressLine(
        JSON.stringify({ total_percent: 47, plate_percent: 49, message: "Generating infill" }),
      ),
    ).toEqual({ percent: 47, message: "Generating infill" });
  });

  it("caps slicer progress until application finalization is complete", () => {
    expect(parseOrcaProgressLine('{"total_percent":100,"message":"Finished"}')).toEqual({
      percent: 95,
      message: "Finished",
    });
  });

  it("rejects malformed and non-numeric progress records", () => {
    expect(parseOrcaProgressLine("not-json")).toBeNull();
    expect(parseOrcaProgressLine('{"total_percent":"50"}')).toBeNull();
  });
});

describe("describeMissingOutput", () => {
  let workDir = "";
  afterEach(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
    workDir = "";
  });

  const run = { code: null, signal: null, timedOut: false, stdoutTail: "", stderrTail: "" };

  it("reports an out-of-memory kill distinctly from generic missing output", async () => {
    workDir = await mkdtemp(join(tmpdir(), "orca-test-"));
    const detail = await describeMissingOutput(workDir, { ...run, signal: "SIGKILL" });
    expect(detail.code).toBe("OUT_OF_MEMORY");
    expect(detail.message).toMatch(/out of memory/i);
  });

  it("keeps the generic code when the slicer exited without a signal", async () => {
    workDir = await mkdtemp(join(tmpdir(), "orca-test-"));
    const detail = await describeMissingOutput(workDir, { ...run, code: 1 });
    expect(detail.code).toBe("NO_OUTPUT");
  });
});

describe("orcaCommand", () => {
  const identity = { uid: 1002, gid: 3000 };

  it("shields the orchestrator by making Orca the preferred OOM victim when root", () => {
    const { command, args } = orcaCommand(true, ["--slice", "0"], identity);
    expect(command).toBe("setpriv");
    const choomAt = args.indexOf("choom");
    expect(choomAt).toBeGreaterThan(-1);
    expect(args.slice(choomAt, choomAt + 4)).toEqual(["choom", "-n", "1000", "--"]);
    expect(args.indexOf("xvfb-run")).toBeGreaterThan(choomAt);
    expect(args.slice(-2)).toEqual(["--slice", "0"]);
  });

  it("runs plainly under xvfb-run when unprivileged", () => {
    const { command, args } = orcaCommand(false, ["--slice", "0"], identity);
    expect(command).toBe("xvfb-run");
    expect(args).not.toContain("choom");
    expect(args).not.toContain("setpriv");
  });
});

describe("orcaChildEnv", () => {
  const run = "/tmp/slice-jobs/job-1";

  // Regression: Orca stages 3MF project exports through
  // `$TMPDIR/orcaslicer_model`. Without TMPDIR that is the shared
  // /tmp/orcaslicer_model, owned by whichever uid ran Orca first; a later run
  // under the slicer uid then fails at 97% with "Failed to create backup path".
  it("keeps every writable directory inside the run's own work directory", () => {
    const env = orcaChildEnv(run);
    expect(env.HOME).toBe(`${run}/home`);
    expect(env.XDG_RUNTIME_DIR).toBe(`${run}/xdg`);
    expect(env.TMPDIR).toBe(`${run}/tmp`);
    for (const key of ["HOME", "XDG_RUNTIME_DIR", "TMPDIR"] as const) {
      expect(env[key]?.startsWith(`${run}/`)).toBe(true);
    }
  });

  it("passes nothing from the orchestrator's own environment beyond the safe allowlist", () => {
    process.env.SESSION_SECRET = "must-not-leak";
    process.env.DATABASE_URL = "postgres://must-not-leak";
    try {
      const env = orcaChildEnv(run);
      expect(Object.keys(env).sort()).toEqual(
        ["HOME", "LANG", "LC_ALL", "NODE_ENV", "PATH", "TMPDIR", "XDG_RUNTIME_DIR"].sort(),
      );
      expect(JSON.stringify(env)).not.toContain("must-not-leak");
    } finally {
      delete process.env.SESSION_SECRET;
      delete process.env.DATABASE_URL;
    }
  });
});
