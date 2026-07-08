import type { NextRequest } from "next/server";
import { env } from "./env";
import { redis } from "./redis";

/**
 * CSRF guard for mutating route handlers.
 *
 * The app is same-origin only (no cross-site API consumers), so the modern,
 * token-free approach applies: trust `Sec-Fetch-Site: same-origin` where the
 * browser sends it, otherwise require an exact Origin match. Session cookies
 * are additionally SameSite=Strict.
 */
export function assertSameOrigin(request: NextRequest): boolean {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite === "same-origin") return true;
  if (secFetchSite && secFetchSite !== "none") return false;

  const origin = request.headers.get("origin");
  if (!origin) {
    // Non-browser clients (curl) reach here; they can't ride a victim's
    // cookies, so this is not a CSRF vector.
    return true;
  }
  const allowed = new Set([env.appOrigin, "http://localhost:3000"]);
  return allowed.has(origin);
}

/**
 * Client IP for rate limiting. Mirrors contact_api.py's posture: prefer the
 * proxy-set X-Real-IP, else the last X-Forwarded-For hop (appended by our own
 * proxy and therefore trustworthy), else a fixed fallback.
 */
export function clientIp(request: NextRequest): string {
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",");
    return parts[parts.length - 1]!.trim();
  }
  return "unknown";
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Sliding-window rate limiter on Redis sorted sets: one set per (bucket, ip),
 * members are request timestamps; requests older than the window are pruned
 * on each call.
 */
export async function rateLimit(
  bucket: string,
  ip: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const key = `rl:${bucket}:${ip}`;
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;

  const [, added] = await redis
    .multi()
    .zremrangebyscore(key, 0, windowStart)
    .zadd(key, now, `${now}:${Math.random().toString(36).slice(2, 8)}`)
    .zcard(key)
    .expire(key, windowSeconds)
    .exec()
    .then((results) => {
      if (!results) throw new Error("Rate limit transaction failed");
      const count = results[2]?.[1] as number;
      return [null, count] as const;
    });

  if (added > maxRequests) {
    const oldest = await redis.zrange(key, 0, 0, "WITHSCORES");
    const oldestTs = oldest[1] ? Number(oldest[1]) : now;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldestTs + windowSeconds * 1000 - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export const RATE_LIMITS = {
  upload: { max: 20, windowSeconds: 600 },
  slice: { max: 60, windowSeconds: 600 },
  checkout: { max: 5, windowSeconds: 600 },
  adminLogin: { max: 5, windowSeconds: 900 },
  pdf: { max: 30, windowSeconds: 600 },
  contact: { max: 5, windowSeconds: 600 },
  // Shipping estimate hits the paid Shiprocket API. Defence is layered (see
  // app/api/shipping/route.ts): the request must come from a quote session that
  // has actually sliced a model, results are cached 24 h (cache hits cost
  // nothing and don't consume this budget), and a global daily cap backstops
  // the bill. This per-(IP + browser) window just stops one client hammering
  // distinct pincodes — a few genuine address checks, then a cool-off.
  shipping: { max: 4, windowSeconds: 900 },
  // Coarse frequency gate applied BEFORE the DB rebuild, so the endpoint can't
  // be used as a database-saturation target (each request otherwise runs a
  // per-item lookup). Generous enough for real use; cache hits stay free of the
  // `shipping` budget above.
  shippingRequest: { max: 20, windowSeconds: 300 },
} as const;
