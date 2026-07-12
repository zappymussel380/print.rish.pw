import { jwtVerify } from "jose";
import { NextResponse, type NextRequest } from "next/server";

/** Edge middleware: applies the Content-Security-Policy + security headers to
 *  every response, and gates the admin area. Self-contained (no next/headers
 *  import) so it stays edge-compatible; it re-verifies the same HS256 admin
 *  cookie that lib/session.ts issues. */

const TOKEN_ISSUER = "print.rish.pw";
const ADMIN_AUDIENCE = "admin-session";

function adminCookieName(): string {
  return process.env.APP_ORIGIN?.startsWith("https://")
    ? "__Host-admin_session"
    : "admin_session";
}

async function isAdminToken(token: string | undefined): Promise<boolean> {
  if (!token || !process.env.SESSION_SECRET) return false;
  try {
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET);
    if (secret.byteLength < 32) return false;
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: ADMIN_AUDIENCE,
    });
    return (payload as { role?: string }).role === "admin";
  } catch {
    return false;
  }
}

function contentSecurityPolicy(nonce: string): string {
  // Google Maps (optional) is the only permitted external frame.
  const mapsConfigured = !!process.env.GOOGLE_MAPS_EMBED_URL;
  const frameSrc = mapsConfigured ? "https://www.google.com" : "'none'";
  return [
    "default-src 'self'",
    // blob: for the Three.js WebGL viewer + thumbnails; data: for inline icons.
    "img-src 'self' blob: data:",
    "worker-src 'self' blob:",
    // Next.js injects an inline bootstrap + the theme-init script; Tailwind
    // emits a static stylesheet but Next also inlines critical CSS.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${
      process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""
    }`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${frameSrc}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(process.env.APP_ORIGIN?.startsWith("https://") ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

function withSecurityHeaders(
  response: NextResponse,
  nonce: string,
  pathname: string,
): NextResponse {
  response.headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (process.env.APP_ORIGIN?.startsWith("https://")) {
    response.headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  if (
    pathname.startsWith("/admin") ||
    pathname.startsWith("/api/admin") ||
    pathname.startsWith("/quotation/") ||
    pathname.startsWith("/api/quotations/")
  ) {
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const nonce = crypto.randomUUID().replace(/-/g, "");

  // --- admin gate ---
  const isAdminPath = pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
  const isLogin = pathname === "/admin/login" || pathname === "/api/admin/login";

  if (isAdminPath && !isLogin) {
    const authed = await isAdminToken(request.cookies.get(adminCookieName())?.value);
    if (!authed) {
      if (pathname.startsWith("/api/admin")) {
        return withSecurityHeaders(
          NextResponse.json(
            { error: { code: "UNAUTHENTICATED", message: "Admin login required" } },
            { status: 401 },
          ),
          nonce,
          pathname,
        );
      }
      const url = request.nextUrl.clone();
      url.pathname = "/admin/login";
      url.search = pathname !== "/admin" ? `?next=${encodeURIComponent(pathname)}` : "";
      return withSecurityHeaders(NextResponse.redirect(url), nonce, pathname);
    }
  }

  const requestHeaders = new Headers(request.headers);
  const csp = contentSecurityPolicy(nonce);
  // Next extracts the nonce from the request CSP and applies it to framework
  // scripts. x-nonce is for the explicit theme bootstrap in the root layout.
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set("x-nonce", nonce);
  return withSecurityHeaders(
    NextResponse.next({ request: { headers: requestHeaders } }),
    nonce,
    pathname,
  );
}

export const config = {
  // Everything except Next's static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/).*)"],
};
