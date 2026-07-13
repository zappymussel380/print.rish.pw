import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INGEST_ADMISSION_KEY,
  INGEST_ADMISSION_TTL_SECONDS,
  INGEST_MAX_WAITING,
} from "@print/shared";

const mocks = vi.hoisted(() => ({ eval: vi.fn(), zrem: vi.fn(), getRanges: vi.fn() }));

vi.mock("@/lib/redis", () => ({
  redis: { eval: mocks.eval, zrem: mocks.zrem },
}));

const { getIngestCountAhead, releaseIngestAdmission, reserveIngestAdmission } =
  await import("@/lib/ingest-queue");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  mocks.eval.mockResolvedValue(4);
  mocks.zrem.mockResolvedValue(1);
});

describe("ingest admission", () => {
  const queue = {
    toKey: (name: string) => `bull:ingest:${name}`,
  };

  it("uses one atomic bounded two-hour reservation", async () => {
    const ticket = "11111111-1111-4111-8111-111111111111";

    await expect(reserveIngestAdmission(queue as never, ticket)).resolves.toEqual({ position: 4 });

    expect(mocks.eval).toHaveBeenCalledOnce();
    const args = mocks.eval.mock.calls[0]!;
    expect(args.slice(1)).toEqual([
      4,
      INGEST_ADMISSION_KEY,
      "bull:ingest:wait",
      "bull:ingest:paused",
      "bull:ingest:active",
      1_700_000_000_000,
      ticket,
      INGEST_MAX_WAITING,
      1_700_000_000_000 + INGEST_ADMISSION_TTL_SECONDS * 1000,
      INGEST_ADMISSION_TTL_SECONDS + 60,
    ]);
    expect(String(args[0])).toContain("ZREMRANGEBYSCORE");
    expect(String(args[0])).toContain("ZCARD");
    expect(String(args[0]).match(/LLEN/g)).toHaveLength(3);
    expect(String(args[0])).toContain("ZADD");
  });

  it("returns null at the hard bound and rejects invalid Redis results", async () => {
    mocks.eval.mockResolvedValueOnce(-1);
    await expect(
      reserveIngestAdmission(queue as never, "11111111-1111-4111-8111-111111111111"),
    ).resolves.toBeNull();

    mocks.eval.mockResolvedValueOnce(-2);
    await expect(
      reserveIngestAdmission(queue as never, "22222222-2222-4222-8222-222222222222"),
    ).rejects.toThrow("invalid result");
  });

  it("releases only the ticket member", async () => {
    const ticket = "11111111-1111-4111-8111-111111111111";
    await releaseIngestAdmission(ticket);
    expect(mocks.zrem).toHaveBeenCalledWith(INGEST_ADMISSION_KEY, ticket);
  });
});

describe("ingest FIFO position", () => {
  it("counts active and older waiting jobs ahead from one BullMQ snapshot", async () => {
    mocks.getRanges.mockResolvedValue([
      "active-ticket",
      "older-ticket",
      "target-ticket",
      "newer-ticket",
    ]);
    const queue = { getRanges: mocks.getRanges };

    await expect(getIngestCountAhead(queue as never, "target-ticket")).resolves.toBe(2);
    expect(mocks.getRanges).toHaveBeenCalledWith(
      ["active", "waiting", "paused"],
      0,
      INGEST_MAX_WAITING,
      true,
    );
  });

  it("returns null when the job transitioned out of the snapshot", async () => {
    mocks.getRanges.mockResolvedValue(["another-ticket"]);
    await expect(
      getIngestCountAhead({ getRanges: mocks.getRanges } as never, "target-ticket"),
    ).resolves.toBeNull();
  });
});
