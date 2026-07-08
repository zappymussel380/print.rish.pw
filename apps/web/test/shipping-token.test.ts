import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the signed shipping-estimate token
 * (lib/shipping.ts). This is what stops checkout from charging an amount the
 * customer never confirmed: checkout trusts `verifyEstimateToken` and nothing
 * else. These tests pin that it accepts only a valid, unexpired token whose
 * bound parcel dimensions still match the rebuilt quote — every other case
 * (tampered secret, changed weight/value, expiry, garbage) must return null so
 * the route falls through to a 409 "please re-estimate".
 */

const SECRET = "test-secret-please-ignore-0123456789abcdef";
process.env.SESSION_SECRET = SECRET;

// The token path never touches Redis; stub the lazy client so importing the
// module doesn't construct an ioredis connection.
vi.mock("@/lib/redis", () => ({ redis: {} }));

const { issueEstimateToken, verifyEstimateToken } = await import("@/lib/shipping");

// 300 g part → billed 0.5 kg; 50 000 paise declared → ₹500.
const input = { deliveryPincode: "781001", weightGrams: 300, declaredValuePaise: 50_000 };
const estimate = { amountPaise: 10_000, days: "3", weightKg: 0.5 };

afterEach(() => {
  vi.useRealTimers();
  process.env.SESSION_SECRET = SECRET;
});

describe("shipping estimate token", () => {
  it("round-trips a valid token, returning the signed amount + pincode", async () => {
    const token = await issueEstimateToken(input, estimate);
    const v = await verifyEstimateToken(token, input.weightGrams, input.declaredValuePaise);
    expect(v).toEqual({ amountPaise: 10_000, days: "3", pincode: "781001" });
  });

  it("rejects when the billed weight no longer matches the quote", async () => {
    const token = await issueEstimateToken(input, estimate);
    // 900 g bills at 1.5 kg vs the token's 0.5 kg → a different, dearer parcel.
    expect(await verifyEstimateToken(token, 900, input.declaredValuePaise)).toBeNull();
  });

  it("rejects when the declared value no longer matches the quote", async () => {
    const token = await issueEstimateToken(input, estimate);
    expect(await verifyEstimateToken(token, input.weightGrams, 60_000)).toBeNull();
  });

  it("rejects a token signed under a different secret", async () => {
    const token = await issueEstimateToken(input, estimate);
    process.env.SESSION_SECRET = "a-totally-different-secret-value-9876";
    expect(await verifyEstimateToken(token, input.weightGrams, input.declaredValuePaise)).toBeNull();
  });

  it("rejects a malformed token", async () => {
    expect(await verifyEstimateToken("not.a.jwt", input.weightGrams, input.declaredValuePaise)).toBeNull();
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await issueEstimateToken(input, estimate);
    // Past the 30-minute TTL.
    vi.setSystemTime(new Date("2026-01-01T00:31:00Z"));
    expect(await verifyEstimateToken(token, input.weightGrams, input.declaredValuePaise)).toBeNull();
  });
});
