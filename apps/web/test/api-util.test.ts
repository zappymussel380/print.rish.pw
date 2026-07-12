import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/security", () => ({
  assertSameOrigin: () => true,
  clientIp: () => "127.0.0.1",
  rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/session", () => ({ isAdmin: async () => false }));

const { readJsonBody } = await import("@/lib/api-util");

describe("bounded JSON bodies", () => {
  it("parses a valid body", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });
    const result = await readJsonBody(request as never, 1024);
    expect(result).toEqual({ ok: true, value: { ok: true } });
  });

  it("rejects an oversized chunked body without Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"value\":\""));
        controller.enqueue(new TextEncoder().encode("x".repeat(100)));
        controller.enqueue(new TextEncoder().encode("\"}"));
        controller.close();
      },
    });
    const request = new Request("http://localhost/test", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = await readJsonBody(request as never, 32);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });
});
