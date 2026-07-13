import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TICKET = "22222222-2222-4222-8222-222222222222";
const MODEL_ID = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  getQuoteSessionId: vi.fn(),
  queueGetJob: vi.fn(),
  getIngestCountAhead: vi.fn(),
  rateLimit: vi.fn(),
  clientIp: vi.fn(),
  redisExists: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getQuoteSessionId: mocks.getQuoteSessionId }));
vi.mock("@/lib/queue", () => ({
  getIngestQueue: vi.fn(() => ({ getJob: mocks.queueGetJob })),
}));
vi.mock("@/lib/ingest-queue", () => ({ getIngestCountAhead: mocks.getIngestCountAhead }));
vi.mock("@/lib/redis", () => ({ redis: { exists: mocks.redisExists } }));
vi.mock("@/lib/security", () => ({
  RATE_LIMITS: { uploadPoll: { max: 10_000, windowSeconds: 600 } },
  clientIp: mocks.clientIp,
  rateLimit: mocks.rateLimit,
}));

const { GET } = await import("@/app/api/uploads/status/[ticket]/route");

const validData = {
  tmpName: "44444444-4444-4444-8444-444444444444",
  sessionId: SESSION_ID,
  originalName: "cube.stl",
  format: "stl",
  sizeBytes: 84,
  sha256: "a".repeat(64),
  reservationMember: "1000:55555555-5555-4555-8555-555555555555",
};

const validResult = {
  model: {
    id: MODEL_ID,
    originalName: "cube.stl",
    format: "stl",
    sizeBytes: 84,
    bboxMm: { x: 20, y: 20, z: 20 },
    volumeCm3: 8,
    triangleCount: 12,
    fitsBed: true,
  },
  models: [
    {
      id: MODEL_ID,
      originalName: "cube.stl",
      format: "stl",
      sizeBytes: 84,
      bboxMm: { x: 20, y: 20, z: 20 },
      volumeCm3: 8,
      triangleCount: 12,
      fitsBed: true,
    },
  ],
};

function request(ticket = TICKET) {
  return new Request(`http://localhost/api/uploads/status/${ticket}`, {
    headers: { "x-real-ip": "127.0.0.1" },
  });
}

function context(ticket = TICKET) {
  return { params: Promise.resolve({ ticket }) };
}

function job(state: string, overrides: Record<string, unknown> = {}) {
  return {
    data: validData,
    returnvalue: null,
    failedReason: "sensitive /data/internal/path",
    getState: vi.fn(async () => state),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getQuoteSessionId.mockResolvedValue(SESSION_ID);
  mocks.rateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.clientIp.mockReturnValue("127.0.0.1");
  mocks.redisExists.mockResolvedValue(1);
  mocks.getIngestCountAhead.mockResolvedValue(2);
});

describe("GET /api/uploads/status/[ticket]", () => {
  it("uses the same 404 for malformed, missing, and foreign tickets", async () => {
    const malformed = await GET(request("not-a-ticket") as never, context("not-a-ticket"));
    expect(malformed.status).toBe(404);
    const expectedBody = await malformed.json();
    expect(mocks.queueGetJob).not.toHaveBeenCalled();

    mocks.queueGetJob.mockResolvedValueOnce(undefined);
    const missing = await GET(request() as never, context());
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual(expectedBody);

    mocks.queueGetJob.mockResolvedValueOnce(
      job("waiting", { data: { ...validData, sessionId: "66666666-6666-4666-8666-666666666666" } }),
    );
    const foreign = await GET(request() as never, context());
    expect(foreign.status).toBe(404);
    await expect(foreign.json()).resolves.toEqual(expectedBody);
  });

  it("reports a real count-ahead position and processor heartbeat", async () => {
    mocks.queueGetJob.mockResolvedValue(job("waiting"));

    const response = await GET(request() as never, context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "queued",
      position: 2,
      processorOnline: true,
    });
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      "uploadPoll",
      `127.0.0.1:${SESSION_ID}`,
      10_000,
      600,
    );
    expect(mocks.redisExists).toHaveBeenCalledWith("worker:heartbeat");
  });

  it("rechecks a waiting ticket that moves active during its position snapshot", async () => {
    const getState = vi
      .fn()
      .mockResolvedValueOnce("waiting")
      .mockResolvedValueOnce("active");
    mocks.queueGetJob.mockResolvedValue(job("waiting", { getState }));
    mocks.getIngestCountAhead.mockResolvedValue(null);

    const response = await GET(request() as never, context());

    await expect(response.json()).resolves.toEqual({ status: "processing" });
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it("returns only a validated completed result", async () => {
    mocks.queueGetJob.mockResolvedValue(job("completed", { returnvalue: validResult }));
    const done = await GET(request() as never, context());
    await expect(done.json()).resolves.toEqual({ status: "done", ...validResult });

    mocks.queueGetJob.mockResolvedValue(
      job("completed", { returnvalue: { ...validResult, internalPath: "/data/private" } }),
    );
    const corrupt = await GET(request() as never, context());
    await expect(corrupt.json()).resolves.toEqual({
      status: "failed",
      error: {
        code: "INGEST_FAILED",
        message: "The model could not be processed. Please upload it again.",
      },
    });
  });

  it("returns a worker-classified failure but never raw BullMQ reasons", async () => {
    mocks.queueGetJob.mockResolvedValue(
      job("failed", {
        data: {
          ...validData,
          publicFailure: { code: "INVALID_MODEL_MALFORMED", message: "Not a valid STL file" },
        },
      }),
    );
    const expected = await GET(request() as never, context());
    await expect(expected.json()).resolves.toEqual({
      status: "failed",
      error: { code: "INVALID_MODEL_MALFORMED", message: "Not a valid STL file" },
    });

    mocks.queueGetJob.mockResolvedValue(job("failed"));
    const unexpected = await GET(request() as never, context());
    const body = await unexpected.json();
    expect(body).toEqual({
      status: "failed",
      error: {
        code: "INGEST_FAILED",
        message: "The model could not be processed. Please upload it again.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("/data/internal/path");
  });

  it("rate-limits an owned ticket and supplies Retry-After", async () => {
    mocks.queueGetJob.mockResolvedValue(job("active"));
    mocks.rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });

    const response = await GET(request() as never, context());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("17");
    expect(mocks.queueGetJob).not.toHaveBeenCalled();
  });

  it("fails closed with a friendly 503 when Redis is unavailable", async () => {
    mocks.queueGetJob.mockRejectedValue(new Error("redis://secret@internal unavailable"));

    const response = await GET(request() as never, context());

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "INGEST_UNAVAILABLE" } });
    expect(JSON.stringify(body)).not.toContain("redis://");
  });
});
