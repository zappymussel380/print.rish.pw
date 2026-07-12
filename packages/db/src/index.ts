import { PrismaClient } from "../generated/client/index.js";

/** Singleton PrismaClient — safe across Next.js hot reloads in development. */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Prisma error events can embed query arguments. Let callers log a bounded,
    // redacted summary instead of emitting customer data directly in production.
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : [],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export * from "../generated/client/index.js";
