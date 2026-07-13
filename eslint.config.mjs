import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import globals from "globals";
import tseslint from "typescript-eslint";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});
const convertedNextConfig = compat.extends("next/core-web-vitals");
const nextPlugin = convertedNextConfig.find((config) => config.plugins?.["@next/next"])
  ?.plugins?.["@next/next"];

if (!nextPlugin) throw new Error("eslint-config-next did not expose the Next.js plugin");

const nextConfig = convertedNextConfig.map((config) => {
  const plugins = config.plugins ? { ...config.plugins } : undefined;
  if (plugins) delete plugins["@next/next"];
  return {
    ...config,
    ...(plugins ? { plugins } : {}),
    files: ["apps/web/**/*.{js,jsx,ts,tsx}"],
  };
});

export default tseslint.config(
  {
    ignores: ["**/.next/**", "**/dist/**", "**/next-env.d.ts", "packages/db/generated/**"],
  },
  { ...js.configs.recommended, files: ["**/*.{js,mjs,cjs}"] },
  ...tseslint.configs.recommended,
  // Register this once globally so Next 15's build-time detector sees the
  // plugin; its actual rules remain scoped to apps/web below.
  { plugins: { "@next/next": nextPlugin } },
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
