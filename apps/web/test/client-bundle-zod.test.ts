import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Zod is ~65 KB gzipped, and until 2026-09 it shipped to every visitor because
 * the site header and friends import constants from @print/shared modules that
 * also built zod schemas. The schemas now live in `*-schema.ts` files, and the
 * package is `"sideEffects": false`, so public pages load none of them.
 *
 * This walks the real import graph from every client module outside the admin
 * dashboard (which may use zod: it loads for the owner only) and fails if any
 * runtime import reaches "zod".
 */

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = resolve(WEB, "../../packages/shared/src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".") || name === "test" || name === "test-integration") return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Runtime imports only: `import type`, `export type … from` and specifier
 *  lists made entirely of `type X` are erased by the compiler. */
function runtimeImports(file: string): { specifier: string; names: string[] }[] {
  const text = readFileSync(file, "utf8");
  const out: { specifier: string; names: string[] }[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)"|(?:^|\n)\s*import\s+"([^"]+)"/g;
  for (const m of text.matchAll(re)) {
    if (m[5]) {
      out.push({ specifier: m[5], names: ["*"] });
      continue;
    }
    if (m[2]) continue;
    const clause = m[3]!;
    const braces = clause.match(/\{([^}]*)\}/);
    const names = braces
      ? braces[1]!.split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("type "))
          .map((s) => s.split(/\s+as\s+/)[0]!)
      : ["*"];
    // `import X, { type Y }` still loads the module for X.
    const hasDefaultOrNamespace = /^[A-Za-z_$*]/.test(clause.trim()) && !clause.trim().startsWith("{");
    if (names.length === 0 && !hasDefaultOrNamespace) continue;
    out.push({ specifier: m[4]!, names: names.length ? names : ["*"] });
  }
  return out;
}

function resolveLocal(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(WEB, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The shared module that declares each exported name. */
function sharedOwners(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const file of readdirSync(SHARED)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file === "index.ts") continue;
    const text = readFileSync(join(SHARED, file), "utf8");
    for (const m of text.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|enum)\s+([A-Za-z0-9_$]+)/g)) {
      owners.set(m[1]!, join(SHARED, file));
    }
  }
  return owners;
}

/** Every file a module loads at runtime, following relative imports; returns
 *  the chain that reaches zod, if any. */
function zodChain(start: string, seen = new Set<string>()): string[] | null {
  if (seen.has(start)) return null;
  seen.add(start);
  for (const { specifier } of runtimeImports(start)) {
    if (specifier === "zod" || specifier.startsWith("zod/")) return [start, "zod"];
    const next = resolveLocal(start, specifier);
    if (!next) continue;
    const chain = zodChain(next, seen);
    if (chain) return [start, ...chain];
  }
  return null;
}

describe("public pages ship without zod", () => {
  const clientEntries = sourceFiles(WEB).filter(
    (f) => !relative(WEB, f).startsWith("components/admin/") && /^\s*["']use client["']/.test(readFileSync(f, "utf8")),
  );

  it("finds the client modules to check", () => {
    expect(clientEntries.length).toBeGreaterThan(10);
  });

  it("no public client module reaches zod, directly or through @print/shared", () => {
    const owners = sharedOwners();
    const problems: string[] = [];
    const visited = new Set<string>();
    const visit = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      for (const { specifier, names } of runtimeImports(file)) {
        if (specifier === "zod" || specifier.startsWith("zod/")) problems.push(`${relative(WEB, file)} imports zod`);
        if (specifier === "@print/shared") {
          for (const name of names) {
            const owner = owners.get(name);
            if (name === "*" || !owner) {
              problems.push(`${relative(WEB, file)}: can't tell where "${name}" comes from`);
              continue;
            }
            const chain = zodChain(owner);
            if (chain) {
              const path = chain.map((p) => (p === "zod" ? p : relative(SHARED, p))).join(" → ");
              problems.push(`${relative(WEB, file)} → ${name} → ${path}`);
            }
          }
        }
        const next = resolveLocal(file, specifier);
        if (next && !relative(WEB, next).startsWith("components/admin/")) visit(next);
      }
    };
    clientEntries.forEach(visit);
    expect(problems).toEqual([]);
  });
});
