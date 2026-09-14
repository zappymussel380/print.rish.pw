import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const SECRET = "test-secret-please-ignore-0123456789abcdef";
process.env.SESSION_SECRET = SECRET;

const db = vi.hoisted(() => ({ row: null as { value: unknown } | null, upsert: vi.fn() }));
const apiUtil = vi.hoisted(() => ({
  requireAdminApi: vi.fn(async (): Promise<Response | null> => null),
  jsonError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
  readJsonBody: vi.fn(),
}));
const redis = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn() }));

vi.mock("@print/db", () => ({
  prisma: {
    appSetting: {
      findUnique: vi.fn(async () => db.row),
      upsert: db.upsert.mockImplementation(async ({ update }: { update: { value: unknown } }) => {
        db.row = { value: update.value };
        return {};
      }),
    },
  },
  Prisma: {},
}));
vi.mock("@/lib/api-util", () => apiUtil);
vi.mock("@/lib/security", () => ({ assertSameOrigin: () => true }));
vi.mock("@/lib/redis", () => ({ redis }));

const route = await import("@/app/api/admin/shipping/route");
const { getShippingConfig } = await import("@/lib/shipping-settings");
const { openSecret, sealSecret } = await import("@/lib/secret-box");

const req = () => ({}) as unknown as NextRequest;
const body = (value: unknown) => apiUtil.readJsonBody.mockResolvedValueOnce({ ok: true, value });
const fetchMock = vi.fn();
const loginAnswers = (status: number, json: object = { token: "tok" }) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } }));
const saved = () => db.row?.value as { enabled: boolean; email: string; passwordSealed: string; pickupPincode: string };
const on = { enabled: true, email: "api@shop.test", password: "s3cret", pickupPincode: "411001" };

beforeEach(() => {
  db.row = null;
  db.upsert.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SHIPROCKET_EMAIL", "");
  vi.stubEnv("SHIPROCKET_PASSWORD", "");
  vi.stubEnv("SHIPROCKET_PICKUP_PINCODE", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.env.SESSION_SECRET = SECRET;
});

describe("secret box", () => {
  it("opens what it sealed, for the same purpose only", () => {
    const sealed = sealSecret("s3cret", "shiprocket-password");
    expect(sealed).not.toContain("s3cret");
    expect(openSecret(sealed, "shiprocket-password")).toBe("s3cret");
    expect(openSecret(sealed, "something-else")).toBeNull();
    // A different nonce every time.
    expect(sealSecret("s3cret", "shiprocket-password")).not.toBe(sealed);
  });

  it("refuses tampering, junk, and a changed server secret", () => {
    const sealed = sealSecret("s3cret", "p");
    const [v, iv, b] = sealed.split(".");
    const flipped = `${v}.${iv}.${b!.slice(0, -2)}${b!.at(-2) === "A" ? "B" : "A"}${b!.at(-1)}`;
    expect(openSecret(flipped, "p")).toBeNull();
    expect(openSecret("v1.x.y", "p")).toBeNull();
    expect(openSecret("nonsense", "p")).toBeNull();
    process.env.SESSION_SECRET = "another-secret-entirely-0123456789abcdef";
    expect(openSecret(sealed, "p")).toBeNull();
  });
});

describe("which settings the estimator uses", () => {
  it("is off with nothing anywhere, and the server's environment when admin hasn't saved", async () => {
    vi.stubEnv("SHIPROCKET_PICKUP_PINCODE", "781001");
    expect(await getShippingConfig()).toMatchObject({ source: "none", live: false });
    // docker-compose's default pincode isn't offered as the shop's choice.
    expect(await (await route.GET()).json()).toMatchObject({ source: "none", pickupPincode: "" });
    vi.stubEnv("SHIPROCKET_EMAIL", "env@shop.test");
    vi.stubEnv("SHIPROCKET_PASSWORD", "envpw");
    vi.stubEnv("SHIPROCKET_PICKUP_PINCODE", "781001");
    expect(await getShippingConfig()).toMatchObject({ source: "env", live: true, email: "env@shop.test", password: "envpw", pickupPincode: "781001" });
  });

  it("saved settings win over the environment, and a switched-off one stays off", async () => {
    vi.stubEnv("SHIPROCKET_EMAIL", "env@shop.test");
    vi.stubEnv("SHIPROCKET_PASSWORD", "envpw");
    db.row = { value: { enabled: false, email: "api@shop.test", passwordSealed: sealSecret("pw", "shiprocket-password"), pickupPincode: "411001" } };
    expect(await getShippingConfig()).toMatchObject({ source: "saved", live: false, email: "api@shop.test", password: "pw" });
  });
});

describe("/api/admin/shipping", () => {
  it("never hands the password back", async () => {
    db.row = { value: { enabled: true, email: "api@shop.test", passwordSealed: sealSecret("pw", "shiprocket-password"), pickupPincode: "411001" } };
    const text = await (await route.GET()).text();
    expect(JSON.parse(text)).toEqual({
      source: "saved",
      enabled: true,
      email: "api@shop.test",
      pickupPincode: "411001",
      hasPassword: true,
      passwordUnreadable: false,
      live: true,
    });
    expect(text).not.toMatch(/pw|sealed/i);
  });

  it("checks a new login with Shiprocket, then stores the password sealed", async () => {
    loginAnswers(200);
    body(on);
    const res = await route.PUT(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: "saved", live: true, hasPassword: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ email: "api@shop.test", password: "s3cret" });
    expect(saved()).toMatchObject({ enabled: true, email: "api@shop.test", pickupPincode: "411001" });
    expect(JSON.stringify(saved())).not.toContain("s3cret");
    expect(openSecret(saved().passwordSealed, "shiprocket-password")).toBe("s3cret");
    // The login's token is kept for the estimates that follow.
    expect(redis.set).toHaveBeenCalledWith(expect.stringMatching(/^sr:token:/), "tok", "EX", expect.any(Number));
  });

  it("saves nothing when Shiprocket rejects the login, or can't be asked", async () => {
    loginAnswers(401, { message: "Invalid email and password combination" });
    body(on);
    let res = await route.PUT(req());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "LOGIN_REJECTED" } });

    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    body(on);
    res = await route.PUT(req());
    expect(res.status).toBe(502);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("needs email, password and pincode to switch estimates on", async () => {
    body({ enabled: true, email: "", pickupPincode: "" });
    let res = await route.PUT(req());
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe("To show estimates, check an email, a password, a pickup pincode.");

    body({ ...on, pickupPincode: "012345" });
    res = await route.PUT(req());
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/pickup pincode \(6 digits\)/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("keeps the password in use when the field is left blank, without asking Shiprocket again", async () => {
    db.row = { value: { enabled: true, email: "api@shop.test", passwordSealed: sealSecret("old", "shiprocket-password"), pickupPincode: "411001" } };
    body({ enabled: false, email: "api@shop.test", password: "", pickupPincode: "411002" });
    const res = await route.PUT(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, live: false, hasPassword: true, pickupPincode: "411002" });
    expect(openSecret(saved().passwordSealed, "shiprocket-password")).toBe("old");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a first save takes over the server environment's password", async () => {
    vi.stubEnv("SHIPROCKET_EMAIL", "api@shop.test");
    vi.stubEnv("SHIPROCKET_PASSWORD", "envpw");
    body({ enabled: true, email: "api@shop.test", pickupPincode: "411001" });
    expect((await route.PUT(req())).status).toBe(200);
    expect(openSecret(saved().passwordSealed, "shiprocket-password")).toBe("envpw");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for the password again when the saved one can't be read", async () => {
    db.row = { value: { enabled: true, email: "api@shop.test", passwordSealed: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAA", pickupPincode: "411001" } };
    expect(await (await route.GET()).json()).toMatchObject({ live: false, hasPassword: false, passwordUnreadable: true });
    body({ enabled: true, email: "api@shop.test", pickupPincode: "411001" });
    expect((await route.PUT(req())).status).toBe(422);
  });
});
