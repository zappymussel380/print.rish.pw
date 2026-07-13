import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getQuoteSessionId: vi.fn(),
  isAdmin: vi.fn(),
  rateLimitBytes: vi.fn(),
  openPrivateFile: vi.fn(),
}));

vi.mock("@print/db", () => ({
  prisma: { uploadedModel: { findUnique: mocks.findUnique } },
}));

vi.mock("@/lib/api-util", () => ({
  jsonError: (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status }),
}));

vi.mock("@/lib/env", () => ({
  env: { downloadWindowBytes: 1024, maxUploadBytes: 1024 },
}));

vi.mock("@/lib/security", () => ({
  clientIp: () => "127.0.0.1",
  rateLimitBytes: mocks.rateLimitBytes,
  RATE_LIMITS: { upload: { windowSeconds: 600 } },
}));

vi.mock("@/lib/session", () => ({
  getQuoteSessionId: mocks.getQuoteSessionId,
  isAdmin: mocks.isAdmin,
}));

vi.mock("@/lib/storage", () => ({
  modelPath: vi.fn(),
  openPrivateFile: mocks.openPrivateFile,
}));

const { GET } = await import("@/app/api/models/[id]/file/route");

const id = "11111111-1111-4111-8111-111111111111";
const retainedModel = {
  id,
  sessionId: "22222222-2222-4222-8222-222222222222",
  storedPath: "",
  format: "stl",
  sizeBytes: 128,
  originalName: "part.stl",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(retainedModel);
  mocks.isAdmin.mockResolvedValue(false);
});

describe("retained model downloads", () => {
  it("returns 410 to the owning session after file retention", async () => {
    mocks.getQuoteSessionId.mockResolvedValue(retainedModel.sessionId);

    const response = await GET(new Request(`http://localhost/api/models/${id}/file`) as never, {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: {
        code: "FILE_EXPIRED",
        message: "The file has been removed by the retention policy",
      },
    });
    expect(mocks.rateLimitBytes).not.toHaveBeenCalled();
    expect(mocks.openPrivateFile).not.toHaveBeenCalled();
  });

  it("does not reveal retained rows to another session", async () => {
    mocks.getQuoteSessionId.mockResolvedValue("33333333-3333-4333-8333-333333333333");

    const response = await GET(new Request(`http://localhost/api/models/${id}/file`) as never, {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(404);
    expect(mocks.isAdmin).toHaveBeenCalledOnce();
  });
});
