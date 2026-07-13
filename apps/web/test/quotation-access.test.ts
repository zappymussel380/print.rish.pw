import { describe, expect, it } from "vitest";
import {
  issueQuotationAccess,
  quotationAccessMatches,
} from "@/lib/quotation-access";

describe("quotation access capabilities", () => {
  it("stores a hash verifier and accepts the bearer only before expiry", () => {
    const now = new Date("2026-07-12T00:00:00Z");
    const access = issueQuotationAccess(now);

    expect(access.token).toMatch(/^[0-9a-f]{64}$/);
    expect(access.verifier).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(access.verifier).not.toContain(access.token);
    expect(quotationAccessMatches(access.token, access.verifier, access.expiresAt, now)).toBe(true);
    expect(
      quotationAccessMatches(
        access.token,
        access.verifier,
        access.expiresAt,
        new Date(access.expiresAt.getTime() + 1),
      ),
    ).toBe(false);
  });

  it("rejects tampered/malformed bearers and raw stored capabilities", () => {
    const now = new Date("2026-07-12T00:00:00Z");
    const access = issueQuotationAccess(now);
    // Flip the last hex digit so the tampered token always differs.
    const flipped = access.token.endsWith("0") ? "1" : "0";
    expect(
      quotationAccessMatches(
        `${access.token.slice(0, -1)}${flipped}`,
        access.verifier,
        access.expiresAt,
        now,
      ),
    ).toBe(false);
    expect(quotationAccessMatches("not-a-token", access.verifier, access.expiresAt, now)).toBe(false);
    expect(quotationAccessMatches(access.token, access.token, access.expiresAt, now)).toBe(false);
  });
});
