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
