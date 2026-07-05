import { Queue } from "bullmq";
import { SLICE_QUEUE, type SliceJobData } from "@print/shared";
import { env } from "./env";

/** Producer-side handle to the slice queue. BullMQ manages its own Redis
 *  connection (separate from the rate-limit client, which uses different retry
 *  semantics). The Queue is created lazily on first use so importing this
 *  module during `next build` trace collection doesn't dial a Redis that isn't
 *  running yet. */
const globalForQueue = globalThis as unknown as { sliceQueue?: Queue<SliceJobData> };

function parseRedis(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    password: u.password || undefined,
    maxRetriesPerRequest: null as null,
  };
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
