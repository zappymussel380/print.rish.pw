import Redis from "ioredis";
import { env } from "./env";

/** Shared ioredis connection for rate limiting and queue access.
 *  (BullMQ creates its own connections with the required options.)
 *
 *  Connection is lazy: we only dial Redis on first command, so importing this
 *  module during `next build` trace collection doesn't spawn a connection storm
 *  against a Redis that isn't running yet. */
const globalForRedis = globalThis as unknown as { redis?: Redis };

function createClient(): Redis {
  const client = new Redis(env.redisUrl, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    lazyConnect: true,
  });
  // Avoid unhandled 'error' events crashing the process when Redis is briefly
  // unreachable; rate-limit callers handle command rejections themselves.
  client.on("error", () => {});
  return client;
}

export const redis = globalForRedis.redis ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}
