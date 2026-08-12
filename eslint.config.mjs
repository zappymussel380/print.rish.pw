import js from "@eslint/js";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import globals from "globals";
import tseslint from "typescript-eslint";

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
