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

    const result = await fetchShipping({
      deliveryPincode: "781001",
      weightGrams: 300,
      declaredValuePaise: 50_000,
    });

    expect(result).toEqual({ ok: false, reason: "BUSY" });
    expect(mocks.sendOperatorAlert).toHaveBeenCalledOnce();
    expect(mocks.sendOperatorAlert).toHaveBeenCalledWith(
      "shipping_daily_cap",
      "Shiprocket daily call cap reached; shipping estimates are temporarily busy.",
    );
    finishAlert?.();
  });
});
