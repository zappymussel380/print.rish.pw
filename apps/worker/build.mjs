import { readFileSync } from "node:fs";
import { build } from "esbuild";

// Bundle the worker plus the TS-source workspace packages (@print/*) into
// plain JS so the production image runs `node dist/index.js` without tsx.
//
// The deployed node_modules is not hoisted, so only the worker's own
// package.json dependencies are resolvable from the app root at runtime:
// those stay external, while the workspace packages' third-party deps
// (zod, @xmldom/xmldom) are bundled in. The Prisma client generated under
// @print/db carries a native engine and must load from disk; its relative
// import is rewritten to a package subpath that resolves in both the dev
// workspace and the deployed image.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const runtimeDeps = new Set(
  Object.entries(pkg.dependencies)
    .filter(([, version]) => !version.startsWith("workspace:"))
    .map(([name]) => name),
);

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist/index.js",
  sourcemap: true,
  logLevel: "info",
  plugins: [
    {
      name: "worker-externals",
      setup(builder) {
        builder.onResolve({ filter: /^\.\..*\/generated\/client\/index\.js$/ }, () => ({
          path: "@print/db/generated/client/index.js",
          external: true,
        }));
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
