import { jwtVerify } from "jose";
import { NextResponse, type NextRequest } from "next/server";

/** Edge middleware: applies the Content-Security-Policy + security headers to
 *  every response, and gates the admin area. Self-contained (no next/headers
 *  import) so it stays edge-compatible; it re-verifies the same HS256 admin
 *  cookie that lib/session.ts issues. */

const ADMIN_COOKIE = "admin_session";

async function isAdminToken(token: string | undefined): Promise<boolean> {
  if (!token || !process.env.SESSION_SECRET) return false;
  try {
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET);
    const { payload } = await jwtVerify(token, secret);
    return (payload as { role?: string }).role === "admin";
  } catch {
    return false;
  }
}

function contentSecurityPolicy(): string {
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
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${frameSrc}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

function withSecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set("Content-Security-Policy", contentSecurityPolicy());
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- admin gate ---
  const isAdminPath = pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
  const isLogin = pathname === "/admin/login" || pathname === "/api/admin/login";

  if (isAdminPath && !isLogin) {
    const authed = await isAdminToken(request.cookies.get(ADMIN_COOKIE)?.value);
    if (!authed) {
      if (pathname.startsWith("/api/admin")) {
        return withSecurityHeaders(
          NextResponse.json(
            { error: { code: "UNAUTHENTICATED", message: "Admin login required" } },
            { status: 401 },
          ),
        );
      }
      const url = request.nextUrl.clone();
      url.pathname = "/admin/login";
      url.search = pathname !== "/admin" ? `?next=${encodeURIComponent(pathname)}` : "";
      return withSecurityHeaders(NextResponse.redirect(url));
    }
  }

  return withSecurityHeaders(NextResponse.next());
}

export const config = {
  // Everything except Next's static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/).*)"],
};
