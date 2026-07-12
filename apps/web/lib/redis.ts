import Redis from "ioredis";
import { env } from "./env";

/** Shared ioredis connection for rate limiting and queue access.
 *  (BullMQ creates its own connections with the required options.)
 *
 *  Connection is lazy: we only dial Redis on first command, so importing this
 *  module during `next build` trace collection doesn't spawn a connection storm
 *  against a Redis that isn't running yet. */
const globalForRedis = globalThis as unknown as { redis?: Redis };
let moduleClient: Redis | undefined;

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

function client(): Redis {
  const existing = globalForRedis.redis ?? moduleClient;
  if (existing) return existing;
  const created = createClient();
  moduleClient = created;
  if (process.env.NODE_ENV !== "production") globalForRedis.redis = created;
  return created;
}

/** Method-compatible lazy facade. Reading REDIS_URL and constructing ioredis
 * are both deferred until the first actual property/method access; Next can
 * therefore import route modules during a production build without credentials
 * or a live Redis service. Methods are bound to the real client because ioredis
 * relies on its instance as `this`. */
export const redis = new Proxy({} as Redis, {
  get(_target, property) {
    const instance = client();
    const value = Reflect.get(instance, property, instance) as unknown;
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
