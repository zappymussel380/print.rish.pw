import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// killIdentityProcesses walks /proc and reads each task's status file. Processes
// are free to exit mid-walk, and Linux surfaces that as either ENOENT (the entry
// is already gone) or ESRCH (the task died during the read). Both mean the same
// thing — that pid is no longer running — which is precisely the state the reap
// is trying to reach. Treating either as fatal takes down the orchestrator over
// an unrelated process exiting at the wrong moment.
const fsMocks = vi.hoisted(() => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: fsMocks.readdir, readFile: fsMocks.readFile };
});

const errno = (code: string, syscall: string) =>
  Object.assign(new Error(`${code}: no such process, ${syscall}`), { code });

let killIdentityProcesses: typeof import("./orca.js").killIdentityProcesses;
let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.resetModules();
  fsMocks.readdir.mockReset();
  fsMocks.readFile.mockReset();
  ({ killIdentityProcesses } = await import("./orca.js"));
  killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(() => {
  killSpy.mockRestore();
});

describe("killIdentityProcesses status-read races", () => {
  it("treats ESRCH from the status read as an already-dead process", async () => {
    fsMocks.readdir.mockResolvedValue(["4242", "not-a-pid"]);
    fsMocks.readFile.mockRejectedValue(errno("ESRCH", "read"));

    await expect(killIdentityProcesses(1001)).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("treats ENOENT from the status read the same way", async () => {
    fsMocks.readdir.mockResolvedValue(["4242"]);
    fsMocks.readFile.mockRejectedValue(errno("ENOENT", "open"));

    await expect(killIdentityProcesses(1001)).resolves.toBeUndefined();
  });

  it("still surfaces genuinely unexpected status-read failures", async () => {
    fsMocks.readdir.mockResolvedValue(["4242"]);
    fsMocks.readFile.mockRejectedValue(errno("EACCES", "read"));

    await expect(killIdentityProcesses(1001)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("still kills a live process owned by the sandbox uid", async () => {
    fsMocks.readdir
      .mockResolvedValueOnce(["4242"])
      .mockResolvedValue([]);
    fsMocks.readFile.mockResolvedValue("Name:\torca\nUid:\t1001\t1001\t1001\t1001\n");

    await expect(killIdentityProcesses(1001)).resolves.toBeUndefined();
    expect(killSpy).toHaveBeenCalledWith(4242, "SIGKILL");
  });
});
