/**
 * Session token and cookie naming, shared between lib/session.ts (issuing and
 * verifying via next/headers) and middleware.ts (edge-compatible re-verifier).
 * The middleware keeps its own verification logic; only these constants are
 * shared so the two cannot drift apart.
 */

export const TOKEN_ISSUER = "print.rish.pw";
export const QUOTE_AUDIENCE = "quote-session";
export const ADMIN_AUDIENCE = "admin-session";

/** Cookies carry the __Host- prefix only when served over HTTPS; plain-HTTP
 * access (e.g. a LAN IP while testing) cannot satisfy the prefix rules. */
export function quoteCookieName(secure: boolean): string {
  return secure ? "__Host-qsid" : "qsid";
}

export function adminCookieName(secure: boolean): string {
  return secure ? "__Host-admin_session" : "admin_session";
}
