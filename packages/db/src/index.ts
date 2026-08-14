import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/client/client";

/** Singleton PrismaClient — safe across Next.js hot reloads in development. */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Prisma 7 removed the Rust query engine: the connection string no longer comes
// from the schema's datasource block, it is handed to a driver adapter here.
// PrismaPg does not connect on construction — pg's pool is lazy — so importing
// this module still costs nothing until the first query.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    // Prisma error events can embed query arguments. Let callers log a bounded,
    // redacted summary instead of emitting customer data directly in production.
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : [],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * A throwaway client bound to one specific connection string.
 *
 * The integration fences open a client per database role to prove the
 * least-privilege grants actually hold. Prisma 6 did that with the
 * `datasourceUrl` option, which 7 removed along with the query engine; the
 * replacement is a per-client driver adapter. Keeping it here means the tests
 * never have to depend on `@prisma/adapter-pg` themselves. Callers own the
 * returned client and must `$disconnect()` it.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export * from "../generated/client/client";
