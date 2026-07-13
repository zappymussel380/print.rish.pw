import type { Queue } from "bullmq";
import {
  INGEST_ADMISSION_KEY,
  INGEST_ADMISSION_TTL_SECONDS,
  INGEST_MAX_WAITING,
  type IngestJobData,
  type IngestJobResult,
} from "@print/shared";
import { redis } from "./redis";

export interface IngestAdmission {
  /** Conservative count of admitted jobs ahead at the instant of admission. */
  position: number;
}

/** Atomically reserve one of the bounded ingest slots across every web replica.
 * Real BullMQ lists account for durable work; the ZSET covers only concurrent
 * reserve→add gaps and ambiguous producer outcomes. Markers expire
 * independently, so a crash can reduce capacity temporarily but never leak it. */
export async function reserveIngestAdmission(
  queue: Queue<IngestJobData, IngestJobResult>,
  ticket: string,
): Promise<IngestAdmission | null> {
  const now = Date.now();
  const expiresAt = now + INGEST_ADMISSION_TTL_SECONDS * 1000;
  const result = await redis.eval(
    `
      redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
      if redis.call('ZSCORE', KEYS[1], ARGV[2]) then return -2 end
      local count = redis.call('ZCARD', KEYS[1])
        + redis.call('LLEN', KEYS[2])
        + redis.call('LLEN', KEYS[3])
        + redis.call('LLEN', KEYS[4])
      if count >= tonumber(ARGV[3]) then return -1 end
      redis.call('ZADD', KEYS[1], ARGV[4], ARGV[2])
      redis.call('EXPIRE', KEYS[1], ARGV[5])
      return count
    `,
    4,
    INGEST_ADMISSION_KEY,
    queue.toKey("wait"),
    queue.toKey("paused"),
    queue.toKey("active"),
    now,
    ticket,
    INGEST_MAX_WAITING,
    expiresAt,
    INGEST_ADMISSION_TTL_SECONDS + 60,
  );
  const position = Number(result);
  if (position === -1) return null;
  if (!Number.isInteger(position) || position < 0 || position >= INGEST_MAX_WAITING) {
    throw new Error("Ingest admission returned an invalid result");
  }
  return { position };
}

/** Release only a producer-owned marker. Worker terminal cleanup uses the same
 * shared key after ownership has transferred. */
export async function releaseIngestAdmission(ticket: string): Promise<void> {
  await redis.zrem(INGEST_ADMISSION_KEY, ticket);
}

/** Return the count of active/waiting jobs ahead in one Redis snapshot.
 * BullMQ's waiting list is reversed internally; `asc=true` presents FIFO order.
 * Including `paused` keeps positions honest during an operational queue pause. */
export async function getIngestCountAhead(
  queue: Queue<IngestJobData, IngestJobResult>,
  ticket: string,
): Promise<number | null> {
  const ids = await queue.getRanges(
    ["active", "waiting", "paused"],
    0,
    INGEST_MAX_WAITING,
    true,
  );
  const index = ids.indexOf(ticket);
  return index === -1 ? null : index;
}
