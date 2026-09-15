import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const SECRET = "test-secret-please-ignore-0123456789abcdef";
process.env.SESSION_SECRET = SECRET;

const db = vi.hoisted(() => ({ rows: new Map<string, unknown>(), upsert: vi.fn() }));
const apiUtil = vi.hoisted(() => ({
  requireAdminApi: vi.fn(async (): Promise<Response | null> => null),
  jsonError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
  readJsonBody: vi.fn(),
  guardMutation: vi.fn(async (): Promise<Response | null> => null),
}));
const smtp = vi.hoisted(() => ({ sendMail: vi.fn(), createTransport: vi.fn() }));

vi.mock("@print/db", () => ({
  prisma: {
    appSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (db.rows.has(where.key) ? { value: db.rows.get(where.key) } : null)),
      upsert: db.upsert.mockImplementation(async ({ where, update }: { where: { key: string }; update: { value: unknown } }) => {
        db.rows.set(where.key, update.value);
        return {};
      }),
    },
  },
  Prisma: {},
}));
vi.mock("@/lib/api-util", () => apiUtil);
vi.mock("@/lib/security", () => ({
  assertSameOrigin: () => true,
  rateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  RATE_LIMITS: { contact: { max: 5, windowSeconds: 600 } },
}));
vi.mock("nodemailer", () => ({ createTransport: smtp.createTransport }));

const route = await import("@/app/api/admin/mail/route");
const testRoute = await import("@/app/api/admin/mail/test/route");
const contact = await import("@/app/api/contact/route");
const { getMailConfig } = await import("@/lib/mail-settings");
const { openSecret, sealSecret } = await import("@/lib/secret-box");

const req = () => ({}) as unknown as NextRequest;
const body = (value: unknown) => apiUtil.readJsonBody.mockResolvedValueOnce({ ok: true, value });
const fetchMock = vi.fn();
const stored = () => db.rows.get("mail") as { resendKeySealed: string; smtp: { passSealed: string } };
const smtpOn = { enabled: true, provider: "smtp", to: "owner@shop.in", from: "Shop <hello@shop.in>", smtp: { host: "smtp.zoho.in", port: 465, secure: true, user: "hello@shop.in", pass: "app-pass" } };
const contactMsg = { name: "Asha", email: "asha@example.com", subject: "Quote question", message: "Hi" };

beforeEach(() => {
  db.rows.clear();
  db.upsert.mockClear();
  fetchMock.mockReset();
  smtp.sendMail.mockReset().mockResolvedValue({ messageId: "x" });
  smtp.createTransport.mockReset().mockReturnValue({ sendMail: smtp.sendMail });
  apiUtil.guardMutation.mockClear();
  apiUtil.readJsonBody.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("MAIL_TO", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("which mail settings are used", () => {
  it("none, then the environment's Resend, then what admin saved", async () => {
    expect(await getMailConfig()).toMatchObject({ source: "none", live: false });
    vi.stubEnv("RESEND_API_KEY", "re_env");
    vi.stubEnv("MAIL_TO", "env@shop.in");
    expect(await getMailConfig()).toMatchObject({ source: "env", live: true, provider: "resend", resendKey: "re_env", to: "env@shop.in" });
    db.rows.set("mail", { enabled: false, provider: "resend", to: "owner@shop.in", from: "hello@shop.in", resendKeySealed: "", smtp: {} });
    expect(await getMailConfig()).toMatchObject({ source: "saved", live: false });
  });
});

describe("/api/admin/mail", () => {
  it("saves SMTP with the password sealed, and never hands secrets back", async () => {
    body(smtpOn);
    const res = await route.PUT(req());
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view).toMatchObject({ source: "saved", live: true, provider: "smtp", hasSmtpPass: true, smtp: { host: "smtp.zoho.in", port: 465, secure: true } });
    expect(JSON.stringify(view)).not.toContain("app-pass");
    expect(JSON.stringify(db.rows.get("mail"))).not.toContain("app-pass");
    expect(openSecret(stored().smtp.passSealed, "mail-smtp-pass")).toBe("app-pass");
    expect(JSON.stringify(await (await route.GET()).json())).not.toMatch(/app-pass|Sealed/);
  });

  it("needs a recipient, sender and the provider's credentials to switch on", async () => {
    body({ enabled: true, provider: "resend", to: "", from: "" });
    let res = await route.PUT(req());
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe("To send email, check a send-to address, a sender, a Resend API key.");
    body({ ...smtpOn, from: "Shop <nope>" });
    res = await route.PUT(req());
    expect((await res.json()).error.message).toMatch(/the sender/);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("keeps secrets left blank, and a first save keeps the environment's key", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_env");
    vi.stubEnv("MAIL_TO", "env@shop.in");
    body({ enabled: true, provider: "resend", to: "owner@shop.in", from: "hello@shop.in" });
    expect((await route.PUT(req())).status).toBe(200);
    expect(openSecret(stored().resendKeySealed, "mail-resend-key")).toBe("re_env");
    // Switching to SMTP and back loses nothing.
    body({ ...smtpOn });
    expect((await route.PUT(req())).status).toBe(200);
    expect(openSecret(stored().resendKeySealed, "mail-resend-key")).toBe("re_env");
  });

  it("test email: refused until live, then sent with what's saved, the provider's error shown", async () => {
    let res = await testRoute.POST(req());
    expect(res.status).toBe(409);
    db.rows.set("mail", { enabled: true, provider: "resend", to: "owner@shop.in", from: "hello@shop.in", resendKeySealed: sealSecret("re_saved", "mail-resend-key"), smtp: {} });
    fetchMock.mockResolvedValueOnce(new Response('{"message":"The shop.in domain is not verified"}', { status: 403 }));
    res = await testRoute.POST(req());
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/403.*not verified/);
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe("Bearer re_saved");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    res = await testRoute.POST(req());
    expect(await res.json()).toEqual({ status: "sent", to: "owner@shop.in" });
  });
});

describe("the contact form", () => {
  it("answers 503 when mail isn't set up, before rate limits or the body", async () => {
    const res = await contact.POST(req());
    expect(res.status).toBe(503);
    expect(apiUtil.guardMutation).not.toHaveBeenCalled();
    expect(apiUtil.readJsonBody).not.toHaveBeenCalled();
  });

  it("sends through SMTP with the customer as reply-to", async () => {
    body(smtpOn);
    await route.PUT(req());
    body(contactMsg);
    const res = await contact.POST(req());
    expect(res.status).toBe(200);
    expect(smtp.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: "smtp.zoho.in", port: 465, secure: true, auth: { user: "hello@shop.in", pass: "app-pass" } }));
    expect(smtp.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@shop.in", from: "Shop <hello@shop.in>", replyTo: "asha@example.com" }));
  });

  it("reports a failed send without leaking the provider's error to the customer", async () => {
    body(smtpOn);
    await route.PUT(req());
    smtp.sendMail.mockRejectedValueOnce(new Error("535 Authentication failed"));
    body(contactMsg);
    const res = await contact.POST(req());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("535");
  });
});
