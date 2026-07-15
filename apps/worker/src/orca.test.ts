import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeMissingOutput, orcaCommand, parseOrcaProgressLine } from "./orca";

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
