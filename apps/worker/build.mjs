import { readFileSync } from "node:fs";
import { build } from "esbuild";

// Bundle the worker plus the TS-source workspace packages (@print/*) into
// plain JS so the production image runs `node dist/index.js` without tsx.
//
// The deployed node_modules is not hoisted, so only the worker's own
// package.json dependencies are resolvable from the app root at runtime:
// those stay external, while the workspace packages' third-party deps
// (zod, @xmldom/xmldom) are bundled in. Prisma 7's generated client is plain
// TypeScript with no engine binary, so it is simply bundled like any other
// workspace source; its runtime (@prisma/client) and the pg driver adapter are
// declared as worker dependencies so they stay external and get installed into
// the image by `pnpm deploy --prod`.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const runtimeDeps = new Set(
  Object.entries(pkg.dependencies)
    .filter(([, version]) => !version.startsWith("workspace:"))
    .map(([name]) => name),
);

await build({
  // parse-child is its own entry: the orchestrator spawns dist/parse-child.js
  // as a sandboxed subprocess rather than importing it.
  entryPoints: ["src/index.ts", "src/parse-child.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outdir: "dist",
  sourcemap: true,
  logLevel: "info",
  plugins: [
    {
      name: "worker-externals",
      setup(builder) {
        builder.onResolve({ filter: /^[^./]/ }, (args) => {
          const name = args.path.startsWith("@")
            ? args.path.split("/").slice(0, 2).join("/")
            : args.path.split("/")[0];
          if (runtimeDeps.has(name) || args.path.startsWith("node:")) {
            return { path: args.path, external: true };
          }
          return undefined;
        });
      },
    },
  ],
});
