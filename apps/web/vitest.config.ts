import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    coverage: { provider: "v8", reporter: ["text"] },
  },
  resolve: {
    // Mirror the tsconfig `@/*` → `./*` alias. A regex with a `/` boundary is
    // used deliberately so it rewrites `@/lib/x` but leaves workspace scopes
    // like `@print/db` untouched.
    alias: [{ find: /^@\//, replacement: `${root}/` }],
  },
});
