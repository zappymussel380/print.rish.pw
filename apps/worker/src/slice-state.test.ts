import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updateMany: vi.fn() }));

vi.mock("@print/db", () => ({
  Prisma: {},
  prisma: { sliceResult: { updateMany: mocks.updateMany } },
}));

const { claimSliceAttempt, failLiveSliceAttempt, updateRunningSliceAttempt } =
  await import("./slice-state.js");

const identity = {
  id: "11111111-1111-4111-8111-111111111111",
  attemptId: "22222222-2222-4222-8222-222222222222",
  fileHash: "a".repeat(64),
  settingsKey: "pipeline:stl:PLA:200:15:auto",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("slice attempt state fences", () => {
  it("claims only a live matching generation", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(claimSliceAttempt(identity, { status: "RUNNING" })).resolves.toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { ...identity, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "RUNNING" },
    });
  });

  it("reports a stale claim without reopening the row", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(claimSliceAttempt(identity, { status: "RUNNING" })).resolves.toBe(false);
  });

  it("gates progress and terminal writes on RUNNING", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(updateRunningSliceAttempt(identity, { status: "DONE" })).resolves.toBe(false);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { ...identity, status: "RUNNING" },
      data: { status: "DONE" },
    });
  });

  it("prevents a late failed event from overwriting terminal or newer work", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(failLiveSliceAttempt(identity, { status: "FAILED" })).resolves.toBe(false);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { ...identity, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "FAILED" },
    });
  });
});
