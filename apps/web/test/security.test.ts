import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({ redis: {} }));

const { clientIp } = await import("@/lib/security");

function request(headers: Record<string, string> = {}) {
  return new Request("http://localhost", { headers }) as never;
}

describe("clientIp", () => {
  it("accepts canonical IPv4 and trims proxy framing whitespace", () => {
    expect(clientIp(request({ "x-real-ip": " 203.0.113.8 " }))).toBe("203.0.113.8");
  });

  it("canonicalizes equivalent IPv6 spellings to one rate-limit key", () => {
    expect(clientIp(request({ "x-real-ip": "2001:0DB8:0:0:0:0:0:1" }))).toBe(
      "2001:db8::1",
    );
  });

  it.each(["garbage", "203.0.113.8, 198.51.100.2", "203.0.113.8:443", "fe80::1%eth0"])(
    "rejects malformed proxy identity %s",
    (value) => {
      expect(clientIp(request({ "x-real-ip": value }))).toBe("unknown");
    },
  );

  it("does not fall back to attacker-controlled forwarding chains", () => {
    expect(clientIp(request({ "x-forwarded-for": "203.0.113.99" }))).toBe("unknown");
    expect(
      clientIp(
        request({ "x-real-ip": "invalid", "x-forwarded-for": "203.0.113.99" }),
      ),
    ).toBe("unknown");
  });
});
