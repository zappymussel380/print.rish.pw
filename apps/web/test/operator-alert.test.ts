import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: {
    redisDown: false,
    expirations: new Map<string, number>(),
    counters: new Map<string, number>(),
  },
  set: vi.fn(),
  incr: vi.fn(),
  getdel: vi.fn(),
  fetch: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  env: {
    telegramBotToken: "test-token",
    telegramChatId: "test-chat",
    telegramMessageThreadId: 42,
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: mocks.info, warn: mocks.warn },
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    set: mocks.set,
    incr: mocks.incr,
    getdel: mocks.getdel,
  },
}));

async function sender() {
  return import("@/lib/telegram");
}

function sentText(call = 0): string {
  const request = mocks.fetch.mock.calls[call]?.[1] as RequestInit | undefined;
  const payload = JSON.parse(String(request?.body)) as { text: string };
  return payload.text;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-13T10:00:00Z"));
  mocks.state.redisDown = false;
  mocks.state.expirations.clear();
  mocks.state.counters.clear();

  mocks.set.mockImplementation(
    async (key: string, _value: string, _mode: string, ttlSeconds: number) => {
      if (mocks.state.redisDown) throw new Error("redis unavailable");
      const expiresAt = mocks.state.expirations.get(key) ?? 0;
      if (expiresAt > Date.now()) return null;
      mocks.state.expirations.set(key, Date.now() + ttlSeconds * 1000);
      return "OK";
    },
  );
  mocks.incr.mockImplementation(async (key: string) => {
    if (mocks.state.redisDown) throw new Error("redis unavailable");
    const value = (mocks.state.counters.get(key) ?? 0) + 1;
    mocks.state.counters.set(key, value);
    return value;
  });
  mocks.getdel.mockImplementation(async (key: string) => {
    if (mocks.state.redisDown) throw new Error("redis unavailable");
    const value = mocks.state.counters.get(key);
    mocks.state.counters.delete(key);
    return value === undefined ? null : String(value);
  });
  mocks.fetch.mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("operator alerts", () => {
  it("sends the first alert promptly with the configured chat and thread", async () => {
    const { sendOperatorAlert } = await sender();

    await sendOperatorAlert("checkout_5xx", "Checkout failed before the order was created.");

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-token/sendMessage",
      expect.objectContaining({ method: "POST" }),
    );
    const request = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      chat_id: "test-chat",
      message_thread_id: 42,
      disable_web_page_preview: true,
    });
    expect(sentText()).toContain("Operator alert: checkout_5xx");
  });

  it("suppresses a same-kind storm and reports its count on the next send", async () => {
    const { sendOperatorAlert } = await sender();

    await sendOperatorAlert("quotation_pdf_failure", "PDF generation failed.");
    await Promise.all([
      sendOperatorAlert("quotation_pdf_failure", "PDF generation failed."),
      sendOperatorAlert("quotation_pdf_failure", "PDF generation failed."),
      sendOperatorAlert("quotation_pdf_failure", "PDF generation failed."),
    ]);

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.incr).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);
    await sendOperatorAlert("quotation_pdf_failure", "PDF generation failed again.");

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(sentText(1)).toContain("3 similar alerts were suppressed");
  });

  it("rate-limits each alert kind independently", async () => {
    const { sendOperatorAlert } = await sender();

    await sendOperatorAlert("ingest_queue_depth", "The ingest queue is nearly full.");
    await sendOperatorAlert("shipping_daily_cap", "The shipping daily cap was reached.");

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(sentText(0)).toContain("Operator alert: ingest_queue_depth");
    expect(sentText(1)).toContain("Operator alert: shipping_daily_cap");
  });

  it("falls back to a local cap when Redis is unavailable", async () => {
    mocks.state.redisDown = true;
    const { sendOperatorAlert } = await sender();

    await Promise.all([
      sendOperatorAlert("worker_heartbeat", "Worker heartbeat has been missing for a minute."),
      sendOperatorAlert("worker_heartbeat", "Worker heartbeat is still missing."),
      sendOperatorAlert("worker_heartbeat", "Worker heartbeat is still missing."),
    ]);

    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);
    await sendOperatorAlert("worker_heartbeat", "Worker heartbeat is still missing.");

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(sentText(1)).toContain("2 similar alerts were suppressed");
  });

  it("bounds alert text to Telegram's payload budget", async () => {
    const { sendOperatorAlert } = await sender();

    await sendOperatorAlert("shipping_daily_cap", "x".repeat(10_000));

    expect(sentText().length).toBeLessThanOrEqual(3900);
  });

  it("aborts a stalled Telegram request after five seconds", async () => {
    let signal: AbortSignal | undefined;
    mocks.fetch.mockImplementation(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        signal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("request aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      },
    );
    const { sendOperatorAlert } = await sender();

    const sending = sendOperatorAlert("checkout_5xx", "Checkout failed.");
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(sending).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });

  it("never rejects when Telegram fails", async () => {
    mocks.fetch.mockRejectedValue(new Error("network failure"));
    const { sendOperatorAlert } = await sender();

    await expect(
      sendOperatorAlert("checkout_5xx", "Checkout failed before the order was created."),
    ).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith(
      { errorType: "Error" },
      "telegram notification failed",
    );
  });
});
