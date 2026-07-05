import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { env } from "./env";

/**
 * Two signed, httpOnly cookies:
 *  - "qsid": anonymous quote session (48 h) — owns uploaded models until checkout.
 *  - "admin": admin dashboard session (12 h).
 * Both are HS256 JWTs signed with SESSION_SECRET; nothing sensitive is stored
 * client-side beyond the identifier/role.
 */

const QUOTE_COOKIE = "qsid";
const ADMIN_COOKIE = "admin_session";
const QUOTE_TTL_SECONDS = 48 * 3600;
const ADMIN_TTL_SECONDS = 12 * 3600;

const secretKey = () => new TextEncoder().encode(env.sessionSecret);

// Mark cookies Secure only when the app is actually served over HTTPS (derived
// from APP_ORIGIN's scheme). This keeps sessions working when the app is reached
// over plain HTTP — e.g. a LAN IP for testing — while staying Secure in
// production behind the TLS-terminating proxy (APP_ORIGIN=https://…).
const cookieBase = {
  httpOnly: true,
  sameSite: "strict",
  secure: env.appOrigin.startsWith("https://"),
  path: "/",
} as const;

async function sign(payload: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secretKey());
}

async function verify<T>(token: string | undefined): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return payload as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Quote session
// ---------------------------------------------------------------------------

export async function getQuoteSessionId(): Promise<string | null> {
  const store = await cookies();
  const payload = await verify<{ sid?: string }>(store.get(QUOTE_COOKIE)?.value);
  return payload?.sid ?? null;
}

/** Returns the existing session id or creates one, setting the cookie.
 *  Call only from route handlers (cookie mutation). */
export async function getOrCreateQuoteSessionId(): Promise<string> {
  const existing = await getQuoteSessionId();
  if (existing) return existing;
  const sid = crypto.randomUUID();
  const token = await sign({ sid }, QUOTE_TTL_SECONDS);
  const store = await cookies();
  store.set(QUOTE_COOKIE, token, { ...cookieBase, maxAge: QUOTE_TTL_SECONDS });
  return sid;
}

// ---------------------------------------------------------------------------
// Admin session
// ---------------------------------------------------------------------------

export async function isAdmin(): Promise<boolean> {
  const store = await cookies();
  const payload = await verify<{ role?: string }>(store.get(ADMIN_COOKIE)?.value);
  return payload?.role === "admin";
}

export async function createAdminSession(): Promise<void> {
  const token = await sign({ role: "admin" }, ADMIN_TTL_SECONDS);
  const store = await cookies();
  store.set(ADMIN_COOKIE, token, { ...cookieBase, maxAge: ADMIN_TTL_SECONDS });
}

export async function destroyAdminSession(): Promise<void> {
  const store = await cookies();
  store.delete(ADMIN_COOKIE);
}

/** For middleware use (no next/headers cookies() there). */
export async function verifyAdminToken(token: string | undefined): Promise<boolean> {
  const payload = await verify<{ role?: string }>(token);
  return payload?.role === "admin";
}

export const ADMIN_COOKIE_NAME = ADMIN_COOKIE;
