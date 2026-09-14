import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  incr: vi.fn(),
  expire: vi.fn(),
  sendOperatorAlert: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    incr: mocks.incr,
    expire: mocks.expire,
  },
}));

vi.mock("@/lib/telegram", () => ({
  sendOperatorAlert: mocks.sendOperatorAlert,
}));

const { fetchShipping } = await import("@/lib/shipping");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.incr.mockResolvedValue(401);
  mocks.expire.mockResolvedValue(1);
});

describe("Shiprocket operational alerts", () => {
  it("returns BUSY without waiting for the daily-cap alert", async () => {
    let finishAlert: (() => void) | undefined;
    mocks.sendOperatorAlert.mockReturnValue(
      new Promise<void>((resolve) => {
        finishAlert = resolve;
      }),
    );

    const result = await fetchShipping(
      { deliveryPincode: "781001", weightGrams: 300, declaredValuePaise: 50_000 },
      { live: true, email: "api@shop.test", password: "pw", pickupPincode: "781001" },
    );

    expect(result).toEqual({ ok: false, reason: "BUSY" });
    expect(mocks.sendOperatorAlert).toHaveBeenCalledOnce();
    expect(mocks.sendOperatorAlert).toHaveBeenCalledWith(
      "shipping_daily_cap",
      "Shiprocket daily call cap reached; shipping estimates are temporarily busy.",
    );
    finishAlert?.();
  });
});

describe("an estimator that isn't set up", () => {
  it("spends nothing: no daily-cap count, no upstream call", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = await fetchShipping(
      { deliveryPincode: "781001", weightGrams: 300, declaredValuePaise: 50_000 },
      { live: false, email: "", password: "", pickupPincode: "781001" },
    );
    expect(result).toEqual({ ok: false, reason: "NOT_CONFIGURED" });
    expect(mocks.incr).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
