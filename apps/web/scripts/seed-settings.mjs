#!/usr/bin/env node
// Seed the shop's settings (profile, rates, catalog availability) into
// AppSetting. Used by the self-host installer, which has no admin session yet:
//
//   docker compose run --rm -T migrate seed-settings [--if-missing] < settings.json
//
// stdin is one JSON object whose keys are setting names; only the keys below
// are accepted. Values are stored as-is — the app normalises every setting on
// read, so a malformed value degrades to the defaults instead of breaking a
// page. `--if-missing` leaves any existing row alone (an admin's edits win).
// Values reach psql as variables, never interpolated into SQL text.
import { spawnSync } from "node:child_process";

const ALLOWED = new Set(["siteProfile", "pricing", "catalogAvailability"]);
const MAX_INPUT_BYTES = 256 * 1024;

const ifMissing = process.argv.includes("--if-missing");
const unknownFlag = process.argv.slice(2).find((a) => a !== "--if-missing");
if (unknownFlag) {
  console.error(`seed-settings: unknown argument ${unknownFlag}`);
  process.exit(64);
}

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > MAX_INPUT_BYTES) {
    console.error("seed-settings: input too large");
    process.exit(65);
  }
}

let settings;
try {
  settings = JSON.parse(raw);
} catch {
  console.error("seed-settings: stdin is not valid JSON");
  process.exit(65);
}
if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
  console.error("seed-settings: expected a JSON object of settings");
  process.exit(65);
}
for (const [key, value] of Object.entries(settings)) {
  if (!ALLOWED.has(key)) {
    console.error(`seed-settings: refusing unknown setting ${key}`);
    process.exit(65);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    console.error(`seed-settings: ${key} must be a JSON object`);
    process.exit(65);
  }
}

const url = new URL(process.env.DATABASE_URL ?? "");
const pgEnv = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || "5432",
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGCONNECT_TIMEOUT: "10",
};
const sslMode = url.searchParams.get("sslmode");
if (sslMode) pgEnv.PGSSLMODE = sslMode;

const conflict = ifMissing
  ? `DO NOTHING`
  : `DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`;

for (const [key, value] of Object.entries(settings)) {
  const sql = `INSERT INTO "AppSetting" (key, value, "updatedAt")
VALUES (:'key', :'value'::jsonb, now())
ON CONFLICT (key) ${conflict};\n`;
  const result = spawnSync(
    "psql",
    ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--quiet", "--set", `key=${key}`, "--set", `value=${JSON.stringify(value)}`],
    { env: pgEnv, input: sql, stdio: ["pipe", "ignore", "inherit"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`seed-settings: writing ${key} failed (psql status ${result.status})`);
    process.exit(1);
  }
  console.log(`[seed-settings] ${key} ${ifMissing ? "seeded if missing" : "written"}`);
}
