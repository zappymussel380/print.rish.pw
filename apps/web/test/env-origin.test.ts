import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const originIn = async (origin: string) => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_ORIGIN", origin);
  const { env } = await import("@/lib/env");
  return () => env.appOrigin;
};

afterEach(() => vi.unstubAllEnvs());

/** Reachable from the internet (or not an address at all): must be HTTPS. */
const PUBLIC_HTTP = [
  "http://print.example.com",
  "http://localhost.evil.com",
  "http://192.168.1.7.nip.io",
  "http://172.32.0.1:8000",
  "http://172.15.0.1:8000",
  "http://8.8.8.8:8000",
  "http://100.64.0.1:8000",
  "http://11.0.0.1:8000",
];

describe("APP_ORIGIN in production", () => {
  it("allows plain HTTP only on loopback or a home-network address (the installer's local test mode)", async () => {
    for (const ok of [
      "http://localhost:8000",
      "http://127.0.0.1:8000",
      "http://192.168.1.7:8080",
      "http://10.0.0.5:8000",
      "http://172.16.0.9:8000",
      "http://172.31.255.1:8000",
      "https://print.example.com",
    ]) {
      expect((await originIn(ok))(), ok).toBe(ok);
    }
    // URL normalises other IPv4 spellings before the check.
    expect((await originIn("http://0xC0A80107:8000"))()).toBe("http://192.168.1.7:8000");
    for (const bad of PUBLIC_HTTP) {
      expect(await originIn(bad), bad).toThrow(/HTTPS/);
    }
  });
});

describe("validate-env.mjs (container startup gate)", () => {
  const script = fileURLToPath(new URL("../scripts/validate-env.mjs", import.meta.url));
  const run = (origin: string) =>
    spawnSync(process.execPath, [script], {
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH ?? "",
        APP_ORIGIN: origin,
        SESSION_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
        ADMIN_PASSWORD_HASH: `$2b$12$${"a".repeat(53)}`,
        DATABASE_URL: "postgresql://u:p@db:5432/x",
        REDIS_URL: `redis://:${"r".repeat(40)}@redis:6379`,
      },
      encoding: "utf8",
    });

  it("agrees with the app: loopback and home-network HTTP pass, public HTTP is refused", () => {
    for (const ok of ["http://localhost:8000", "http://192.168.1.7:8000", "http://10.0.0.5:8000", "https://print.example.com"]) {
      expect(run(ok).stderr, ok).not.toMatch(/APP_ORIGIN/);
    }
    for (const bad of PUBLIC_HTTP) {
      expect(run(bad).stderr, bad).toMatch(/APP_ORIGIN must use HTTPS/);
    }
  });
});
