import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guardMutation: vi.fn(),
  reserveRateLimit: vi.fn(),
  releaseRateLimitReservation: vi.fn(),
  withRedisLock: vi.fn(),
  compare: vi.fn(),
  createAdminSession: vi.fn(),
}));

vi.mock("bcryptjs", () => ({ default: { compare: mocks.compare } }));
vi.mock("@/lib/env", () => ({ env: { adminPasswordHash: "$2b$12$test" } }));
vi.mock("@/lib/api-util", () => ({
  guardMutation: mocks.guardMutation,
  readJsonBody: async (request: Request) => ({ ok: true, value: await request.json() }),
  jsonError: (status: number, code: string, message: string, extra?: object) =>
    Response.json({ error: { code, message, ...extra } }, { status }),
}));
vi.mock("@/lib/security", () => ({
  RATE_LIMITS: {
    adminLogin: { max: 5, windowSeconds: 900 },
    adminLoginGlobal: { max: 25, windowSeconds: 900 },
  },
  reserveRateLimit: mocks.reserveRateLimit,
  releaseRateLimitReservation: mocks.releaseRateLimitReservation,
  withRedisLock: mocks.withRedisLock,
}));
vi.mock("@/lib/session", () => ({ createAdminSession: mocks.createAdminSession }));

const { POST } = await import("@/app/api/admin/login/route");

function loginRequest(password = "correct horse battery staple") {
  return new Request("http://localhost/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guardMutation.mockResolvedValue(null);
  mocks.reserveRateLimit.mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
    member: "reservation",
  });
  mocks.releaseRateLimitReservation.mockResolvedValue(undefined);
  mocks.compare.mockResolvedValue(false);
  mocks.withRedisLock.mockImplementation(async (_name, action: () => Promise<boolean>) =>
    action(),
  );
});

describe("POST /api/admin/login", () => {
  it("uses one IP-independent account bucket", async () => {
    await POST(loginRequest());

    expect(mocks.reserveRateLimit).toHaveBeenCalledWith("adminLoginGlobal", "all", 25, 900);
    expect(mocks.releaseRateLimitReservation).not.toHaveBeenCalled();
  });

  it("rejects before bcrypt when the global failure budget is exhausted", async () => {
    mocks.reserveRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 123 });

    const response = await POST(loginRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("123");
    expect(mocks.withRedisLock).not.toHaveBeenCalled();
  });

  it("refunds successful password checks", async () => {
    mocks.compare.mockResolvedValue(true);

    const response = await POST(loginRequest());

    expect(response.status).toBe(200);
    expect(mocks.releaseRateLimitReservation).toHaveBeenCalledWith(
      "adminLoginGlobal",
      "all",
      "reservation",
    );
    expect(mocks.createAdminSession).toHaveBeenCalledOnce();
  });

  it("refunds an attempt when the bcrypt lock is busy", async () => {
    mocks.withRedisLock.mockResolvedValue(null);

    const response = await POST(loginRequest());

    expect(response.status).toBe(503);
    expect(mocks.releaseRateLimitReservation).toHaveBeenCalledOnce();
    expect(mocks.compare).not.toHaveBeenCalled();
  });
});
