import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  guardMutation: vi.fn(),
  getQuoteSessionId: vi.fn(),
  queueAdd: vi.fn(),
  queueRemove: vi.fn(),
  queueGetJob: vi.fn(),
  modelCount: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@print/db", () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  prisma: {
    uploadedModel: {
      findFirst: mocks.findFirst,
      count: mocks.modelCount,
    },
    sliceResult: {
      findUnique: mocks.findUnique,
      update: mocks.update,
      create: mocks.create,
    },
  },
}));

vi.mock("@/lib/api-util", () => ({
  guardMutation: mocks.guardMutation,
  readJsonBody: async (request: Request) => {
    try {
      return { ok: true, value: await request.json() };
    } catch {
      return {
        ok: false,
        response: Response.json(
          { error: { code: "BAD_JSON", message: "Request body must be JSON" } },
          { status: 400 },
        ),
      };
    }
  },
  jsonError: (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status }),
}));

vi.mock("@/lib/security", () => ({
  RATE_LIMITS: {
    slice: { max: 1, windowSeconds: 1 },
    slicePoll: { max: 3000, windowSeconds: 600 },
  },
  clientIp: () => "127.0.0.1",
  rateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/session", () => ({
  getQuoteSessionId: mocks.getQuoteSessionId,
}));

vi.mock("@/lib/queue", () => ({
  getSliceQueue: () => ({
    add: mocks.queueAdd,
    remove: mocks.queueRemove,
    getJob: mocks.queueGetJob,
  }),
}));

const { GET } = await import("@/app/api/slices/[id]/route");
const { POST } = await import("@/app/api/slices/route");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guardMutation.mockResolvedValue(null);
  mocks.getQuoteSessionId.mockResolvedValue("22222222-2222-4222-8222-222222222222");
  mocks.queueAdd.mockResolvedValue(undefined);
  mocks.queueRemove.mockResolvedValue(undefined);
  mocks.modelCount.mockResolvedValue(1);
  mocks.rateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

describe("GET /api/slices/:id", () => {
  it("rejects malformed ids before Prisma sees them", async () => {
    const res = await GET({} as never, { params: Promise.resolve({ id: "not-a-uuid" }) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Unknown slice" },
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns a clean 404 for unknown UUIDs", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);

    const res = await GET({} as never, {
      params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Unknown slice" },
    });
  });
});

describe("POST /api/slices", () => {
  it("returns reset progress when explicitly retrying a failed slice", async () => {
    const modelId = "33333333-3333-4333-8333-333333333333";
    const failed = {
      id: "44444444-4444-4444-8444-444444444444",
      fileHash: "a".repeat(64),
      settingsKey: "orca-2.4.1-a1-v1:stl:PLA:200:15:auto",
      settingsJson: {},
      status: "FAILED",
      progressPct: 97,
      progressStage: "failed",
      progressMessage: "Slicing failed",
      progressUpdatedAt: new Date(),
      filamentGrams: null,
      filamentMm: null,
      printSeconds: null,
      supportGrams: null,
      slicerVersion: "2.4.1",
      rawMeta: null,
      errorCode: "NO_OUTPUT",
      errorMessage: "Slicer did not produce output",
      createdAt: new Date(),
      completedAt: new Date(),
    };
    mocks.findFirst.mockResolvedValueOnce({
      id: modelId,
      fileHash: failed.fileHash,
      storedPath: `/data/uploads/${modelId}.stl`,
      format: "stl",
      defaultConfig: null,
      lockedConfig: null,
    });
    mocks.findUnique.mockResolvedValueOnce(failed);
    mocks.update.mockResolvedValueOnce(undefined);

    const request = new Request("http://localhost/api/slices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId,
        settings: { material: "PLA", layerHeightUm: 200, infillPct: 15, supports: "auto" },
      }),
    });
    const res = await POST(request as never);

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      sliceId: failed.id,
      status: "queued",
      progress: { percent: 0, stage: "queued", message: "Waiting for a slicer" },
      error: null,
    });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: failed.id },
        data: expect.objectContaining({ status: "QUEUED", progressPct: 0, errorCode: null }),
      }),
    );
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "slice",
      expect.not.objectContaining({ storedPath: expect.anything() }),
      expect.any(Object),
    );
  });
});
