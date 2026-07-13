import { Queue } from "bullmq";
import {
  INGEST_JOB_RETENTION_SECONDS,
  INGEST_QUEUE,
  SLICE_QUEUE,
  type IngestJobData,
  type IngestJobResult,
  type SliceJobData,
} from "@print/shared";
import { env } from "./env";

/** Producer-side handle to the slice queue. BullMQ manages its own Redis
 *  connection (separate from the rate-limit client, which uses different retry
 *  semantics). The Queue is created lazily on first use so importing this
 *  module during `next build` trace collection doesn't dial a Redis that isn't
 *  running yet. */
const globalForQueue = globalThis as unknown as {
  sliceQueue?: Queue<SliceJobData>;
  ingestQueue?: Queue<IngestJobData, IngestJobResult>;
};

function parseRedis(url: string, maxRetriesPerRequest: number | null = null) {
  const u = new URL(url);
  const dbText = u.pathname.replace(/^\//, "");
  if (dbText && !/^\d+$/.test(dbText)) throw new Error("REDIS_URL has an invalid database index");
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: dbText ? Number(dbText) : 0,
    tls: u.protocol === "rediss:" ? { servername: u.hostname } : undefined,
    maxRetriesPerRequest,
  };
}

/** HTTP-facing producer/status handle for upload ingest. Unlike a Worker
 * connection, this must stop retrying so a Redis outage becomes a bounded 503
 * instead of pinning an upload request indefinitely. */
export function getIngestQueue(): Queue<IngestJobData, IngestJobResult> {
  if (!globalForQueue.ingestQueue) {
    globalForQueue.ingestQueue = new Queue<IngestJobData, IngestJobResult>(INGEST_QUEUE, {
      connection: parseRedis(env.redisUrl, 2),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: {
          age: INGEST_JOB_RETENTION_SECONDS,
          count: 500,
        },
        removeOnFail: {
          age: INGEST_JOB_RETENTION_SECONDS,
          count: 500,
        },
      },
    });
  }
  return globalForQueue.ingestQueue;
}

export function getSliceQueue(): Queue<SliceJobData> {
  if (!globalForQueue.sliceQueue) {
    globalForQueue.sliceQueue = new Queue<SliceJobData>(SLICE_QUEUE, {
      connection: parseRedis(env.redisUrl),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "fixed", delay: 4000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return globalForQueue.sliceQueue;
}
