import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["test-integration/**/*.test.ts"],
    // Every test uses the same disposable database and Redis namespace. Keeping
    // files serial makes cleanup deterministic as the suite grows in Task 0.3.
    fileParallelism: false,
    pool: "forks",
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
  resolve: {
    alias: [{ find: /^@\//, replacement: `${root}/` }],
  },
});
