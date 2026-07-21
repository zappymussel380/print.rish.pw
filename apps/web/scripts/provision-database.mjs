#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

const PLACEHOLDER_RE = /^(?:change-me|changeme|password|secret|example)(?:[-_].*)?$/i;
const ROLE_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/;

function databaseUrl(name) {
  const raw = process.env[name];
  if (!raw) throw new Error(`Missing required environment variable ${name}`);

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error(`${name} must use postgresql://`);
  }

  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!ROLE_RE.test(username) || !database) {
    throw new Error(`${name} must contain a valid role and database name`);
  }
  if (Buffer.byteLength(password, "utf8") < 32 || PLACEHOLDER_RE.test(password)) {
    throw new Error(`${name} must contain a non-placeholder password of at least 32 bytes`);
  }
  return { url, username, password, database };
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  if (value.includes("\0")) throw new Error("Database credentials cannot contain NUL bytes");
  return `'${value.replaceAll("'", "''")}'`;
}

/** PostgreSQL accepts a valid SCRAM verifier as an already-encrypted password.
 * Generate it client-side so a failed DDL statement/server log can never
 * contain the plaintext runtime password. */
function scramVerifier(password) {
  const iterations = 4096;
  const salt = randomBytes(16);
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

const owner = databaseUrl("MIGRATION_DATABASE_URL");
const web = databaseUrl("WEB_DATABASE_URL");
const worker = databaseUrl("WORKER_DATABASE_URL");

const endpoint = (entry) => `${entry.url.hostname}:${entry.url.port || "5432"}/${entry.database}`;
if (endpoint(owner) !== endpoint(web) || endpoint(owner) !== endpoint(worker)) {
  throw new Error("Migration, web, and worker database URLs must target the same database");
}
if (new Set([owner.username, web.username, worker.username]).size !== 3) {
  throw new Error("Migration, web, and worker database roles must be distinct");
}
if (web.password === worker.password || owner.password === web.password || owner.password === worker.password) {
  throw new Error("Migration, web, and worker database passwords must be distinct");
}

const ownerRole = quoteIdentifier(owner.username);
const database = quoteIdentifier(owner.database);
const webRole = quoteIdentifier(web.username);
const workerRole = quoteIdentifier(worker.username);
const webRoleLiteral = quoteLiteral(web.username);
const workerRoleLiteral = quoteLiteral(worker.username);
const webVerifierLiteral = quoteLiteral(scramVerifier(web.password));
const workerVerifierLiteral = quoteLiteral(scramVerifier(worker.password));

const sql = `
SET client_min_messages = warning;

DO $provision$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${webRoleLiteral}) THEN
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', ${webRoleLiteral}, ${webVerifierLiteral});
  ELSE
    EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', ${webRoleLiteral}, ${webVerifierLiteral});
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${workerRoleLiteral}) THEN
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', ${workerRoleLiteral}, ${workerVerifierLiteral});
  ELSE
    EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', ${workerRoleLiteral}, ${workerVerifierLiteral});
  END IF;
END
$provision$;

DO $safety$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid = membership.member
    WHERE member.rolname IN (${webRoleLiteral}, ${workerRoleLiteral})
  ) OR EXISTS (
    SELECT 1 FROM pg_class object
    JOIN pg_roles owner ON owner.oid = object.relowner
    WHERE owner.rolname IN (${webRoleLiteral}, ${workerRoleLiteral})
  ) OR EXISTS (
    SELECT 1 FROM pg_proc function
    JOIN pg_roles owner ON owner.oid = function.proowner
    WHERE owner.rolname IN (${webRoleLiteral}, ${workerRoleLiteral})
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace namespace
    JOIN pg_roles owner ON owner.oid = namespace.nspowner
    WHERE owner.rolname IN (${webRoleLiteral}, ${workerRoleLiteral})
  ) THEN
    RAISE EXCEPTION 'Runtime roles must not inherit roles or own database objects';
  END IF;
END
$safety$;

REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM PUBLIC;
REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM ${webRole}, ${workerRole};
GRANT CONNECT ON DATABASE ${database} TO ${ownerRole}, ${webRole}, ${workerRole};
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${webRole}, ${workerRole};
GRANT USAGE ON SCHEMA public TO ${webRole}, ${workerRole};

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${webRole}, ${workerRole};
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${webRole}, ${workerRole};

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "Quotation", "QuotationItem", "StatusHistory", "QuotationCounter"
  TO ${webRole};

-- Runtime app settings (catalog availability) are read on the quote/pricing
-- pages and written by the admin panel; the worker never consults them.
GRANT SELECT, INSERT, UPDATE ON TABLE "AppSetting" TO ${webRole};

-- Upload transport is public-facing, but parsing and durable model creation run
-- only in the single-concurrency ingest worker. Move INSERT rather than widening
-- both roles; the web keeps lifecycle/config updates and guarded deletion.
GRANT SELECT, UPDATE, DELETE ON TABLE "UploadedModel" TO ${webRole};

-- Slice measurements feed pricing and are trusted worker output. The web role
-- may create cache rows and rotate/requeue lifecycle metadata, but cannot
-- insert or alter measurements, raw slicer output, or the recorded slicer
-- version after creation.
GRANT SELECT ON TABLE "SliceResult" TO ${webRole};
GRANT INSERT (
  "id", "attemptId", "fileHash", "settingsKey", "settingsJson", "status",
  "progressPct", "progressStage", "progressMessage", "progressUpdatedAt",
  "slicerVersion", "createdAt"
) ON TABLE "SliceResult" TO ${webRole};
GRANT UPDATE (
  "attemptId", "status", "progressPct", "progressStage", "progressMessage",
  "progressUpdatedAt", "errorCode", "errorMessage", "completedAt"
) ON TABLE "SliceResult" TO ${webRole};
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "UploadedModel" TO ${workerRole};
GRANT SELECT, UPDATE ON TABLE "SliceResult" TO ${workerRole};
-- Quotation DELETE powers the retention sweep. Cascading foreign keys remove
-- items/history, so the worker does not need direct DELETE on either child.
GRANT SELECT, DELETE ON TABLE "Quotation" TO ${workerRole};
GRANT SELECT ON TABLE "QuotationItem" TO ${workerRole};

ALTER ROLE ${webRole} SET search_path = public;
ALTER ROLE ${workerRole} SET search_path = public;
`;

const pgEnv = {
  ...process.env,
  PGHOST: owner.url.hostname,
  PGPORT: owner.url.port || "5432",
  PGDATABASE: owner.database,
  PGUSER: owner.username,
  PGPASSWORD: owner.password,
  PGCONNECT_TIMEOUT: "10",
};
const sslMode = owner.url.searchParams.get("sslmode");
if (sslMode) pgEnv.PGSSLMODE = sslMode;

const result = spawnSync(
  "psql",
  ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--quiet"],
  { env: pgEnv, input: sql, stdio: ["pipe", "inherit", "inherit"] },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Database role provisioning failed with status ${result.status}`);

console.log("[migrate] Runtime database roles provisioned");
