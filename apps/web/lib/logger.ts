import pino from "pino";

/** Structured logger with PII redaction. Customer contact fields are never
 *  written to logs in the clear — they are replaced with [redacted] wherever
 *  they appear at common paths. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "email",
      "phone",
      "notes",
      "*.email",
      "*.phone",
      "*.notes",
      "customer.email",
      "customer.phone",
      "customer.notes",
      "customer.name",
    ],
    censor: "[redacted]",
  },
});

/** Keep operational error context without allowing upstream URLs/query values,
 * control characters, or large reflected strings into logs. */
export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 300);
}
