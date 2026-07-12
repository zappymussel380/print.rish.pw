#!/usr/bin/env node

const placeholder = /^(?:change-me|changeme|password|secret|example)(?:[-_].*)?$/i;
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};
const checkedUrl = (name, protocols) => {
  const raw = required(name);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!protocols.includes(url.protocol)) throw new Error(`${name} has an invalid protocol`);
  return url;
};

const origin = checkedUrl("APP_ORIGIN", ["https:"]);
if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
  throw new Error("APP_ORIGIN must contain only https scheme, host, and optional port");
}

const sessionSecret = required("SESSION_SECRET");
if (Buffer.byteLength(sessionSecret, "utf8") < 32 || placeholder.test(sessionSecret)) {
  throw new Error("SESSION_SECRET must be at least 32 random bytes");
}

const adminHash = required("ADMIN_PASSWORD_HASH");
const bcrypt = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/.exec(adminHash);
if (!bcrypt || Number(bcrypt[1]) < 12) {
  throw new Error("ADMIN_PASSWORD_HASH must be a bcrypt hash with cost 12 or higher");
}

for (const [name, protocols] of [
  ["DATABASE_URL", ["postgres:", "postgresql:"]],
  ["REDIS_URL", ["redis:", "rediss:"]],
]) {
  const url = checkedUrl(name, protocols);
  const password = decodeURIComponent(url.password);
  if (Buffer.byteLength(password, "utf8") < 32 || placeholder.test(password)) {
    throw new Error(`${name} must include a non-placeholder password of at least 32 bytes`);
  }
}

console.log("[web] Security-critical environment validated");
