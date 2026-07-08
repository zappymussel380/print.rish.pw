import { SignJWT, jwtVerify } from "jose";
import { env } from "./env";
import { logger } from "./logger";
import { redis } from "./redis";

/**
 * Shared Shiprocket rate estimator. Both the interactive estimate endpoint
 * (app/api/shipping) and quotation submission (app/api/quotations) use this so
 * the two agree exactly. Callers are responsible for authorising the request
 * and for supplying an authoritative (server-rebuilt) weight + declared value —
 * this module never sees client-supplied totals.
 */

const LOGIN_URL = "https://apiv2.shiprocket.in/v1/external/auth/login";
const RATE_URL = "https://apiv2.shiprocket.in/v1/external/courier/serviceability";
const TOKEN_KEY = "sr:token";
const TOKEN_TTL_SECONDS = 8 * 24 * 60 * 60; // Shiprocket tokens live ~10 days.
const RESULT_TTL_SECONDS = 24 * 60 * 60; // Rates barely move; cache aggressively.
const DAILY_CALL_CAP = 400; // Global backstop on upstream calls per day.
const PACKAGING_GRAMS = 200;

/** Refuse to estimate above this — a parcel this heavy needs a manual quote and
 *  courier slabs get unreliable. Guards against a huge quote silently billing a
 *  cheap slab. Exported so the route can reject before consuming a rate limit. */
export const MAX_WEIGHT_KG = 25;

export interface ShippingEstimate {
  amountPaise: number;
  days: string | null;
  weightKg: number;
}
export type ShippingReason = "TOO_HEAVY" | "NOT_CONFIGURED" | "NO_SERVICE" | "BUSY" | "UPSTREAM";
export type ShippingResult = { ok: true; estimate: ShippingEstimate } | { ok: false; reason: ShippingReason };

interface EstimateInput {
  deliveryPincode: string;
  weightGrams: number;
  declaredValuePaise: number;
}

class UpstreamError extends Error {}

interface CourierCompany {
  rate?: number;
  estimated_delivery_days?: string;
}

/** Part weight + packaging, billed by Shiprocket's 0.5 kg slabs. */
export function billedWeightKg(weightGrams: number): number {
  return Math.max(0.5, Math.ceil(((weightGrams + PACKAGING_GRAMS) / 1000) * 2) / 2);
}

/** The rate-affecting parcel dimensions Shiprocket bills on: the 0.5 kg-slab
 *  billed weight and the declared value in whole rupees (clamped). Isolated so
 *  the cache key, the upstream call, and the signed estimate token all derive
 *  them identically from the same authoritative weight/value. */
export function shippingBinding(weightGrams: number, declaredValuePaise: number) {
  return {
    weightKg: billedWeightKg(weightGrams),
    declaredValue: Math.min(1_000_000, Math.max(1, Math.round(declaredValuePaise / 100))),
  };
}

function derive(input: EstimateInput) {
  const { weightKg, declaredValue } = shippingBinding(input.weightGrams, input.declaredValuePaise);
  // Cache by EVERY rate-affecting dimension so a changed quote never reuses a
  // stale rate. The pickup pincode is one of them — rates depend on the origin —
  // so it's in the key too: changing SHIPROCKET_PICKUP_PINCODE (or sharing this
  // Redis across environments with different pickups) must not serve a rate
  // computed for a different origin. (rate5: key now includes pickup; the
  // version bump makes old rate4 entries miss and refetch. Payload is the
  // ShippingEstimate directly.)
  const pickup = env.shiprocketPickupPincode;
  const cacheKey = `sr:rate5:${pickup}:${input.deliveryPincode}:${weightKg}:${declaredValue}`;
  return { weightKg, declaredValue, cacheKey };
}

// ---------------------------------------------------------------------------
// Signed estimate token
// ---------------------------------------------------------------------------
// Checkout must charge the exact amount the customer was shown, not a fresh
// re-price (which could silently move on a rate change between estimate and
// submit). So the estimate endpoint hands back a short-lived HS256 token that
// binds the shown amount to its parcel dimensions; checkout trusts the signed
// amount only when those dimensions still match the authoritative rebuilt quote.

const ESTIMATE_TTL_SECONDS = 30 * 60; // A shown estimate is honoured for 30 min.
const secretKey = () => new TextEncoder().encode(env.sessionSecret);

interface EstimateClaims {
  p: string; // delivery pincode
  w: number; // billed weight (kg)
  dv: number; // declared value (whole rupees)
  amt: number; // amountPaise shown to the customer
  days: string | null;
}

/** Sign the estimate the customer was shown. Bound to pincode + parcel
 *  dimensions (which already fold in the pickup-scoped rate) so it can't be
 *  reused for a different quote, and short-lived so a genuinely changed rate
 *  forces a fresh estimate rather than a silent reprice. */
export async function issueEstimateToken(
  input: EstimateInput,
  estimate: ShippingEstimate,
): Promise<string> {
  const { weightKg, declaredValue } = shippingBinding(input.weightGrams, input.declaredValuePaise);
  const claims: EstimateClaims = {
    p: input.deliveryPincode,
    w: weightKg,
    dv: declaredValue,
    amt: estimate.amountPaise,
    days: estimate.days,
  };
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ESTIMATE_TTL_SECONDS)
    .sign(secretKey());
}

/** Verify a checkout-supplied estimate token against the authoritative,
 *  server-rebuilt quote. Returns the trusted amount + signed pincode ONLY if the
 *  signature is valid, unexpired, and the bound weight + declared value still
 *  match this quote. Any mismatch/expiry → null (caller must 409 → re-estimate).
 *  The pincode is taken from the signed token, so the client need not — and
 *  cannot usefully — send it separately. */
export async function verifyEstimateToken(
  token: string,
  weightGrams: number,
  declaredValuePaise: number,
): Promise<{ amountPaise: number; days: string | null; pincode: string } | null> {
  let claims: EstimateClaims;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    claims = payload as unknown as EstimateClaims;
  } catch {
    return null;
  }
  const { weightKg, declaredValue } = shippingBinding(weightGrams, declaredValuePaise);
  if (
    typeof claims.p !== "string" ||
    !/^\d{6}$/.test(claims.p) ||
    claims.w !== weightKg ||
    claims.dv !== declaredValue ||
    typeof claims.amt !== "number" ||
    !Number.isFinite(claims.amt) ||
    claims.amt < 0
  ) {
    return null;
  }
  return { amountPaise: claims.amt, days: typeof claims.days === "string" ? claims.days : null, pincode: claims.p };
}

/** Get a Shiprocket auth token, cached in Redis. `force` skips the cache to
 *  recover from an expired/revoked token. */
async function getToken(email: string, password: string, force = false): Promise<string> {
  if (!force) {
    const cached = await redis.get(TOKEN_KEY);
    if (cached) return cached;
  }
  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new UpstreamError(`login failed (${res.status})`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new UpstreamError("login returned no token");
  await redis.set(TOKEN_KEY, data.token, "EX", TOKEN_TTL_SECONDS);
  return data.token;
}

function rateUrl(pickup: string, delivery: string, weightKg: number, declaredValue: number): string {
  const qs = new URLSearchParams({
    pickup_postcode: pickup,
    delivery_postcode: delivery,
    weight: String(weightKg),
    cod: "0", // prepaid
    declared_value: String(declaredValue),
    rate_calculator: "1",
    is_web: "1",
  });
  return `${RATE_URL}?${qs.toString()}`;
}

/** Serve a previously cached estimate without touching the upstream. Returns
 *  null on a miss. The interactive route uses this so cache hits don't consume
 *  the per-client upstream rate-limit budget. */
export async function getCachedShipping(input: EstimateInput): Promise<ShippingEstimate | null> {
  const { cacheKey } = derive(input);
  const cached = await redis.get(cacheKey);
  return cached ? (JSON.parse(cached) as ShippingEstimate) : null;
}

/** Perform the paid rate lookup (assumes the cache already missed): global daily
 *  cap → Shiprocket login/serviceability → cheapest rate rounded up to ₹10 →
 *  cache + return. */
export async function fetchShipping(input: EstimateInput): Promise<ShippingResult> {
  const { weightKg, declaredValue, cacheKey } = derive(input);
  if (weightKg > MAX_WEIGHT_KG) return { ok: false, reason: "TOO_HEAVY" };

  // Global daily circuit breaker across all clients.
  const dayKey = `sr:calls:${new Date().toISOString().slice(0, 10)}`;
  const callsToday = await redis.incr(dayKey);
  if (callsToday === 1) await redis.expire(dayKey, 26 * 60 * 60);
  if (callsToday > DAILY_CALL_CAP) {
    logger.warn({ callsToday }, "Shipping daily call cap reached");
    return { ok: false, reason: "BUSY" };
  }

  let email: string;
  let password: string;
  try {
    email = env.shiprocketEmail;
    password = env.shiprocketPassword;
  } catch {
    logger.error("Shipping estimate: SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD not configured");
    return { ok: false, reason: "NOT_CONFIGURED" };
  }
  const pickup = env.shiprocketPickupPincode;

  try {
    let token = await getToken(email, password);
    const call = () =>
      fetch(rateUrl(pickup, input.deliveryPincode, weightKg, declaredValue), {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(12_000),
      });

    let res = await call();
    if (res.status === 401 || res.status === 403) {
      token = await getToken(email, password, true);
      res = await call();
    }
    if (!res.ok) throw new UpstreamError(`serviceability failed (${res.status})`);

    const data = (await res.json()) as { data?: { available_courier_companies?: CourierCompany[] } };
    const couriers = (data.data?.available_courier_companies ?? []).filter(
      (c) => typeof c.rate === "number" && c.rate > 0,
    );
    if (couriers.length === 0) return { ok: false, reason: "NO_SERVICE" };

    // Cheapest raw rate → round the rupee figure UP to ₹10. Presented as *our*
    // estimate: hides the exact upstream rate and the courier identity.
    const best = couriers.reduce((a, b) => (a.rate! <= b.rate! ? a : b));
    const roundedRupees = Math.max(10, Math.ceil(best.rate! / 10) * 10);
    const estimate: ShippingEstimate = {
      amountPaise: roundedRupees * 100,
      days: best.estimated_delivery_days ?? null,
      weightKg,
    };
    await redis.set(cacheKey, JSON.stringify(estimate), "EX", RESULT_TTL_SECONDS);
    return { ok: true, estimate };
  } catch (err) {
    logger.error({ err }, "Shipping rate lookup failed");
    return { ok: false, reason: "UPSTREAM" };
  }
}
