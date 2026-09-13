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

describe("APP_ORIGIN in production", () => {
  it("allows plain HTTP only on loopback (the installer's local test mode)", async () => {
    expect((await originIn("http://localhost:8000"))()).toBe("http://localhost:8000");
    expect((await originIn("http://127.0.0.1:8000"))()).toBe("http://127.0.0.1:8000");
    expect((await originIn("https://print.example.com"))()).toBe("https://print.example.com");
    for (const bad of ["http://print.example.com", "http://192.168.1.7:8080", "http://localhost.evil.com"]) {
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

  it("agrees with the app: loopback HTTP passes, public HTTP is refused", () => {
    expect(run("http://localhost:8000").stderr).not.toMatch(/APP_ORIGIN/);
    expect(run("https://print.example.com").stderr).not.toMatch(/APP_ORIGIN/);
    expect(run("http://print.example.com").stderr).toMatch(/APP_ORIGIN must use HTTPS/);
  });
});
