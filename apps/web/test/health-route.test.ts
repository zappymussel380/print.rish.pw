import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  ping: vi.fn(),
  exists: vi.fn(),
  observe: vi.fn(),
  sendOperatorAlert: vi.fn(),
}));

vi.mock("@print/db", () => ({
  prisma: { $queryRaw: mocks.queryRaw },
}));

vi.mock("@/lib/redis", () => ({
  redis: { ping: mocks.ping, exists: mocks.exists },
}));

vi.mock("@/lib/telegram", () => ({
  sendOperatorAlert: mocks.sendOperatorAlert,
}));

vi.mock("@/lib/worker-heartbeat-alert", () => ({
  createWorkerHeartbeatAlertMonitor: () => ({ observe: mocks.observe }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.queryRaw.mockResolvedValue([{ ok: 1 }]);
  mocks.ping.mockResolvedValue("PONG");
  mocks.exists.mockResolvedValue(1);
});

async function getHealth() {
  const { GET } = await import("@/app/api/health/route");
  return GET();
}

describe("health route worker heartbeat observation", () => {
  it("records a healthy worker without changing the existing response", async () => {
    const response = await getHealth();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, db: true, redis: true });
    expect(mocks.observe).toHaveBeenCalledWith(true);
  });

  it("observes a missing heartbeat without making Redis health fail", async () => {
    mocks.exists.mockResolvedValue(0);

    const response = await getHealth();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, db: true, redis: true });
    expect(mocks.observe).toHaveBeenCalledWith(false);
  });

  it("observes Redis unavailability while retaining its existing 503 semantics", async () => {
    mocks.ping.mockRejectedValue(new Error("redis unavailable"));
    mocks.exists.mockRejectedValue(new Error("redis unavailable"));

    const response = await getHealth();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, db: true, redis: false });
    expect(mocks.observe).toHaveBeenCalledWith(false);
  });
});
