import type { NextRequest } from "next/server";
import { isIP } from "node:net";
import { env } from "./env";
import { redis } from "./redis";

/**
 * CSRF guard for mutating route handlers.
 *
 * The app is same-origin only (no cross-site API consumers), so the modern,
 * token-free approach applies: require `Sec-Fetch-Site: same-origin` where the
 * browser sends it, otherwise require an exact Origin match. Session cookies
 * are additionally SameSite=Strict and host-prefixed in production.
 */
export function assertSameOrigin(request: NextRequest): boolean {
  const secFetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (secFetchSite) {
    if (secFetchSite !== "same-origin") return false;
    // Modern browsers sometimes omit Origin when Fetch Metadata already proves
    // same-origin. If both exist, require both signals to agree.
    return origin === null || origin === env.appOrigin;
  }
  // Legacy browsers/clients must provide an exact origin. Production never
  // whitelists localhost; development already has localhost as APP_ORIGIN.
  return origin === env.appOrigin;
}

/**
 * Client IP for rate limiting. The compose proxy always overwrites X-Real-IP;
 * X-Forwarded-For is deliberately ignored because it is a multi-hop audit
 * field, not an authenticated identity. Validation/canonicalization keeps
 * malformed and equivalent textual addresses from creating arbitrary Redis
 * keys. It is hygiene only: proxy trust and firewall configuration establish
 * provenance.
 */
export function clientIp(request: NextRequest): string {
  const value = request.headers.get("x-real-ip")?.trim();
  if (!value || value.length > 64 || value.includes("%")) return "unknown";

  const version = isIP(value);
  if (version === 4) return value;
  if (version === 6) {
    // WHATWG URL serialization gives one compressed, lower-case IPv6 form.
    // Zone identifiers are rejected above because they are local interface
    // annotations, not meaningful public-client identities.
    try {
      return new URL(`http://[${value}]/`).hostname.slice(1, -1);
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimitReservation extends RateLimitResult {
  member?: string;
}

/** Serialize a short critical section across web replicas. Returns null when
 * the lock stays busy past waitMs. The token-checked Lua release cannot delete
 * a newer owner's lease after this one expires. */
export async function withRedisLock<T>(
  name: string,
  action: () => Promise<T>,
  options: { leaseMs?: number; waitMs?: number } = {},
): Promise<T | null> {
  const leaseMs = options.leaseMs ?? 360_000;
  const waitMs = options.waitMs ?? 30_000;
  const key = `lock:${name}`;
  const token = crypto.randomUUID();
  const deadline = Date.now() + waitMs;

  while ((await redis.set(key, token, "PX", leaseMs, "NX")) !== "OK") {
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 75 + Math.floor(Math.random() * 75)));
  }

  try {
    return await action();
  } finally {
    await redis
      .eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        token,
      )
      .catch(() => {});
  }
}

/** Fixed-window byte budget for expensive request bodies. Request-count limits
 * alone allow a handful of legal 300 MiB uploads to consume gigabytes of disk
 * and bandwidth. Over-budget requests remain charged so retries cannot reduce
 * the accounting total. */
export async function rateLimitBytes(
  bucket: string,
  subject: string,
  costBytes: number,
  maxBytes: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const slot = Math.floor(now / windowMs);
  const key = `rlb:${bucket}:${slot}:${subject}`;
  const results = await redis.multi().incrby(key, costBytes).expire(key, windowSeconds + 5).exec();
  if (!results) throw new Error("Byte rate limit transaction failed");
  const total = Number(results[0]?.[1] ?? maxBytes + 1);
  return {
    allowed: total <= maxBytes,
    retryAfterSeconds: total <= maxBytes ? 0 : Math.max(1, Math.ceil((slot + 1) * windowMs / 1000 - now / 1000)),
  };
}

/** Reserve shared upload capacity across web replicas before accepting a large
 * body. ZSET members encode their byte cost and expire automatically, so a
 * crashed request cannot leak a permanent counter. */
export async function reserveStorageBytes(
  costBytes: number,
  capacityBytes: number,
  ttlSeconds = 15 * 60,
): Promise<string | null> {
  if (costBytes <= 0 || capacityBytes < costBytes) return null;
  const now = Date.now();
  const member = `${Math.ceil(costBytes)}:${crypto.randomUUID()}`;
  const result = await redis.eval(
    `
      redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
      local entries = redis.call('ZRANGE', KEYS[1], 0, -1)
      local total = 0
      for _, entry in ipairs(entries) do
        local separator = string.find(entry, ':', 1, true)
        if separator then total = total + (tonumber(string.sub(entry, 1, separator - 1)) or 0) end
      end
      if total + tonumber(ARGV[2]) > tonumber(ARGV[3]) then return nil end
      redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
      redis.call('EXPIRE', KEYS[1], ARGV[6])
      return ARGV[5]
    `,
    1,
    "storage:upload-reservations",
    now,
    Math.ceil(costBytes),
    Math.floor(capacityBytes),
    now + ttlSeconds * 1000,
    member,
    ttlSeconds + 60,
  );
  return typeof result === "string" ? result : null;
}

export async function releaseStorageReservation(member: string): Promise<void> {
  await redis.zrem("storage:upload-reservations", member);
}

/**
 * Sliding-window rate limiter on Redis sorted sets: one set per (bucket, ip),
 * members are request timestamps; requests older than the window are pruned
 * on each call.
 */
export async function reserveRateLimit(
  bucket: string,
  ip: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitReservation> {
  const key = `rl:${bucket}:${ip}`;
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const member = `${now}:${crypto.randomUUID()}`;
  // Prune, check and (only when admitted) add atomically. The previous MULTI
  // inserted rejected attempts too, so a flood from one subject grew its sorted
  // set without bound for the entire window and turned the limiter into a Redis
  // memory/CPU amplification target.
  const result = (await redis.eval(
    `
      redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
      local count = redis.call('ZCARD', KEYS[1])
      if count >= tonumber(ARGV[4]) then
        local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
        redis.call('EXPIRE', KEYS[1], ARGV[5])
        return {0, oldest[2] or ARGV[2], ''}
      end
      redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
      redis.call('EXPIRE', KEYS[1], ARGV[5])
      return {1, ARGV[2], ARGV[3]}
    `,
    1,
    key,
    windowStart,
    now,
    member,
    maxRequests,
    windowSeconds,
  )) as [number | string, number | string, string];

  if (Number(result[0]) !== 1) {
    const oldestTs = Number(result[1]) || now;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldestTs + windowSeconds * 1000 - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSeconds: 0, member: String(result[2] || member) };
}

/** Refund a reserved admission when the protected operation fails before it
 * creates durable state. Callers never receive arbitrary Redis keys; the
 * bucket/subject pair is reconstructed here. */
export async function releaseRateLimitReservation(
  bucket: string,
  subject: string,
  member: string,
): Promise<void> {
  await redis.zrem(`rl:${bucket}:${subject}`, member);
}

export async function rateLimit(
  bucket: string,
  ip: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const { allowed, retryAfterSeconds } = await reserveRateLimit(
    bucket,
    ip,
    maxRequests,
    windowSeconds,
  );
  return { allowed, retryAfterSeconds };
}

export const RATE_LIMITS = {
  upload: { max: 20, windowSeconds: 600 },
  modelMutation: { max: 60, windowSeconds: 600 },
  slice: { max: 60, windowSeconds: 600 },
  slicePoll: { max: 3000, windowSeconds: 600 },
  checkout: { max: 5, windowSeconds: 600 },
  // Cross-IP circuit breaker for permanent PII rows, PDFs, and external
  // notifications. It bounds botnet/storage amplification; upstream bot
  // controls remain necessary because exhausting it can deny service.
  checkoutGlobal: { max: 200, windowSeconds: 86_400 },
  adminLogin: { max: 5, windowSeconds: 900 },
  // IP-independent backstop for the single administrator account. Successful
  // and lock-busy attempts are refunded; failed password guesses retain their
  // reservation. This remains effective if client-IP attribution is broken or
  // an attacker rotates addresses, at the cost of a bounded login-DoS lever.
  adminLoginGlobal: { max: 25, windowSeconds: 900 },
  pdf: { max: 30, windowSeconds: 600 },
  quotationAccess: { max: 10, windowSeconds: 900 },
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
