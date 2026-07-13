import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkerHeartbeatAlertMonitor,
  WORKER_HEARTBEAT_ALERT_MESSAGE,
} from "@/lib/worker-heartbeat-alert";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("worker heartbeat alert monitor", () => {
  it("does not alert for an outage shorter than one minute", async () => {
    const sendAlert = vi.fn(async () => {});
    const monitor = createWorkerHeartbeatAlertMonitor(sendAlert);

    monitor.observe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    monitor.observe(false);
    await vi.runAllTicks();

    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("alerts after one minute and caps a continuing storm for fifteen minutes", async () => {
    const sendAlert = vi.fn(async () => {});
    const monitor = createWorkerHeartbeatAlertMonitor(sendAlert);

    monitor.observe(false);
    await vi.advanceTimersByTimeAsync(60_001);
    monitor.observe(false);
    await vi.runAllTicks();

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenLastCalledWith(WORKER_HEARTBEAT_ALERT_MESSAGE);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      monitor.observe(false);
    }
    await vi.runAllTicks();
    expect(sendAlert).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(12 * 60_000);
    monitor.observe(false);
    await vi.runAllTicks();

    expect(sendAlert).toHaveBeenCalledTimes(2);
    expect(sendAlert).toHaveBeenLastCalledWith(
      `${WORKER_HEARTBEAT_ALERT_MESSAGE} Repeated alerts suppressed since the previous notification: 3.`,
    );
  });

  it("resets both the outage threshold and local limiter after recovery", async () => {
    const sendAlert = vi.fn(async () => {});
    const monitor = createWorkerHeartbeatAlertMonitor(sendAlert);

    monitor.observe(false);
    await vi.advanceTimersByTimeAsync(60_001);
    monitor.observe(false);
    await vi.runAllTicks();
    expect(sendAlert).toHaveBeenCalledTimes(1);

    monitor.observe(true);
    monitor.observe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    monitor.observe(false);
    await vi.runAllTicks();
    expect(sendAlert).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    monitor.observe(false);
    await vi.runAllTicks();
    expect(sendAlert).toHaveBeenCalledTimes(2);
  });
});
