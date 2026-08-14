import { createRequire } from "node:module";

import js from "@eslint/js";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import globals from "globals";
import tseslint from "typescript-eslint";

// eslint-config-next sets `settings.react.version: "detect"`, and under ESLint 10
// eslint-plugin-react's detection path crashes: it calls the removed
// `context.getFilename()` (util/version.js) and every react rule dies with
// "contextOrFilename.getFilename is not a function". Pinning the version skips
// that path entirely. Read it from the installed React rather than hardcoding a
// number, so it cannot drift out of step with the app.
const reactVersion = createRequire(new URL("./apps/web/package.json", import.meta.url))(
  "react/package.json",
).version;

// A missing version would not fail loudly — the plugin would just warn and fall
// back to a default — so assert it here instead.
if (!/^\d+\.\d+\.\d+/.test(reactVersion ?? "")) {
  throw new Error(`Could not read the installed React version (got ${reactVersion})`);
}

// eslint-config-next 16 ships a native flat config, so it is imported directly.
// Routing it through FlatCompat (which is for eslintrc-style configs) throws
// "Converting circular structure to JSON" on the plugin graph.
const WEB_FILES = ["apps/web/**/*.{js,jsx,ts,tsx}"];

if (!nextCoreWebVitals.some((entry) => entry.plugins?.["@next/next"])) {
  throw new Error("eslint-config-next did not expose the Next.js plugin");
}

// Next's rules apply to the web app only. Entries that carry neither `files`
// nor `rules` are its global `ignores` block; adding `files` to that would
// demote it to an ordinary config object and silently stop it ignoring.
const nextConfig = nextCoreWebVitals.map((entry) =>
  entry.files || entry.rules ? { ...entry, files: WEB_FILES } : entry,
);

export default tseslint.config(
  {
    ignores: ["**/.next/**", "**/dist/**", "**/next-env.d.ts", "packages/db/generated/**"],
  },
  { ...js.configs.recommended, files: ["**/*.{js,mjs,cjs}"] },
  ...tseslint.configs.recommended,
  ...nextConfig,
  { settings: { react: { version: reactVersion } } },
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { args: "all", argsIgnorePattern: "^_" }],
      "no-control-regex": "error",
      // Apostrophes in static JSX copy are clear and safe; requiring entities
      // would be a style-only churn rather than a correctness check.
      "react/no-unescaped-entities": "off",
    },
  },
  {
    files: ["**/test/**/*.ts", "**/*.test.ts"],
    rules: {
      // Vitest mocks occasionally need to stand in for generated Prisma types.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
