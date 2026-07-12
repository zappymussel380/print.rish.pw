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

const QUOTE_TTL_SECONDS = 48 * 3600;
const ADMIN_TTL_SECONDS = 12 * 3600;
const TOKEN_ISSUER = "print.rish.pw";
const QUOTE_AUDIENCE = "quote-session";
const ADMIN_AUDIENCE = "admin-session";

const secretKey = () => new TextEncoder().encode(env.sessionSecret);

// Mark cookies Secure only when the app is actually served over HTTPS (derived
// from APP_ORIGIN's scheme). This keeps sessions working when the app is reached
// over plain HTTP — e.g. a LAN IP for testing — while staying Secure in
// production behind the TLS-terminating proxy (APP_ORIGIN=https://…).
function secureCookies(): boolean {
  return env.appOrigin.startsWith("https://");
}

function quoteCookieName(): string {
  return secureCookies() ? "__Host-qsid" : "qsid";
}

function adminCookieName(): string {
  return secureCookies() ? "__Host-admin_session" : "admin_session";
}

function cookieBase() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: secureCookies(),
    path: "/",
    priority: "high" as const,
  };
}

async function sign(
  payload: Record<string, unknown>,
  ttlSeconds: number,
  audience: string,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secretKey());
}

async function verify<T>(token: string | undefined, audience: string): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience,
    });
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
  const payload = await verify<{ sid?: string }>(store.get(quoteCookieName())?.value, QUOTE_AUDIENCE);
  return payload?.sid ?? null;
}

/** Returns the existing session id or creates one, setting the cookie.
 *  Call only from route handlers (cookie mutation). */
export async function getOrCreateQuoteSessionId(): Promise<string> {
  const existing = await getQuoteSessionId();
  if (existing) return existing;
  const sid = crypto.randomUUID();
  const token = await sign({ sid }, QUOTE_TTL_SECONDS, QUOTE_AUDIENCE);
  const store = await cookies();
  store.set(quoteCookieName(), token, { ...cookieBase(), maxAge: QUOTE_TTL_SECONDS });
  return sid;
}

// ---------------------------------------------------------------------------
// Admin session
// ---------------------------------------------------------------------------

export async function isAdmin(): Promise<boolean> {
  const store = await cookies();
  const payload = await verify<{ role?: string }>(store.get(adminCookieName())?.value, ADMIN_AUDIENCE);
  return payload?.role === "admin";
}

export async function createAdminSession(): Promise<void> {
  const token = await sign({ role: "admin" }, ADMIN_TTL_SECONDS, ADMIN_AUDIENCE);
  const store = await cookies();
  store.set(adminCookieName(), token, { ...cookieBase(), maxAge: ADMIN_TTL_SECONDS });
}

export async function destroyAdminSession(): Promise<void> {
  const store = await cookies();
  store.delete(adminCookieName());
}

/** For middleware use (no next/headers cookies() there). */
export async function verifyAdminToken(token: string | undefined): Promise<boolean> {
  const payload = await verify<{ role?: string }>(token, ADMIN_AUDIENCE);
  return payload?.role === "admin";
}
