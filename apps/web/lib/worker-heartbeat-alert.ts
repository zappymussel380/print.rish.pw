export const WORKER_HEARTBEAT_ALERT_MESSAGE =
  "Worker heartbeat has been missing or Redis has been unreachable for more than one minute. Slicing and retention jobs may be stalled; check the web, worker, and Redis services.";

const OUTAGE_THRESHOLD_MS = 60_000;
const ALERT_INTERVAL_MS = 15 * 60_000;

export interface WorkerHeartbeatAlertMonitor {
  observe(healthy: boolean): void;
}

/**
 * Process-local outage monitor for the health route. The Telegram sender has
 * its own cross-process limiter when Redis is available; this second gate is
 * deliberately local so a Redis outage cannot create an HTTP alert storm.
 */
export function createWorkerHeartbeatAlertMonitor(
  sendAlert: (message: string) => Promise<void>,
): WorkerHeartbeatAlertMonitor {
  let unhealthySince: number | null = null;
  let lastAlertAt: number | null = null;
  let suppressed = 0;

  return {
    observe(healthy) {
      const now = Date.now();
      if (healthy) {
        unhealthySince = null;
        lastAlertAt = null;
        suppressed = 0;
        return;
      }

      unhealthySince ??= now;
      if (now - unhealthySince <= OUTAGE_THRESHOLD_MS) return;

      if (lastAlertAt !== null && now - lastAlertAt < ALERT_INTERVAL_MS) {
        suppressed += 1;
        return;
      }

      const message =
        suppressed > 0
          ? `${WORKER_HEARTBEAT_ALERT_MESSAGE} Repeated alerts suppressed since the previous notification: ${suppressed}.`
          : WORKER_HEARTBEAT_ALERT_MESSAGE;
      lastAlertAt = now;
      suppressed = 0;

      // Health checks and their response latency must not depend on Telegram.
      // The sender is specified never to throw; retain a final rejection guard
      // so a future regression still cannot create an unhandled rejection.
      void Promise.resolve()
        .then(() => sendAlert(message))
        .catch(() => {});
    },
  };
}
