#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const appOrigin = process.env.APP_ORIGIN;
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

if (!appOrigin || !databaseUrl || !redisUrl) {
  throw new Error("APP_ORIGIN, DATABASE_URL, and REDIS_URL are required for the API flow test");
}
const origin = new URL(appOrigin);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (
  origin.protocol !== "http:" ||
  !loopbackHosts.has(origin.hostname) ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
) {
  throw new Error("The API flow test is restricted to a loopback HTTP APP_ORIGIN");
}
const databaseConnection = new URL(databaseUrl);
const database = databaseConnection.pathname.replace(/^\//, "");
if (
  !["postgres:", "postgresql:"].includes(databaseConnection.protocol) ||
  !loopbackHosts.has(databaseConnection.hostname) ||
  !database.endsWith("_integration")
) {
  throw new Error("The API flow test requires a loopback, disposable *_integration database");
}
const redisConnection = new URL(redisUrl);
if (
  !["redis:", "rediss:"].includes(redisConnection.protocol) ||
  !loopbackHosts.has(redisConnection.hostname) ||
  redisConnection.pathname !== "/1"
) {
  throw new Error("The API flow test requires loopback Redis database 1");
}
if (process.env.STUB_SLICER !== "true") {
  throw new Error("The API flow test requires STUB_SLICER=true");
}

const cookies = new Map();
const clientIp = `192.0.2.${20 + Math.floor(Math.random() * 200)}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function absorbCookies(response) {
  if (typeof response.headers.getSetCookie !== "function") {
    throw new Error("Node 24 Headers.getSetCookie() is required for the API flow test");
  }
  for (const value of response.headers.getSetCookie()) {
    const attributeStart = value.indexOf(";");
    const pair = attributeStart === -1 ? value : value.slice(0, attributeStart);
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new Error("The dev server returned an invalid Set-Cookie header");
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeader() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function request(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-real-ip", clientIp);
  if (cookies.size > 0) headers.set("cookie", cookieHeader());
  const response = await fetch(new URL(path, origin), {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  absorbCookies(response);
  return response;
}

function mutationHeaders(extra = {}) {
  return {
    origin: origin.origin,
    "sec-fetch-site": "same-origin",
    "x-requested-with": "XMLHttpRequest",
    ...extra,
  };
}

async function jsonResponse(response, expectedStatus, label) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function waitForDevServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await request("/api/health");
      if (response.status === 200) return;
    } catch {
      // Next may still be compiling or binding its socket.
    }
    await delay(250);
  }
  throw new Error("The Next.js dev server did not become healthy within 60 seconds");
}

await waitForDevServer();

const fixtureUrl = new URL(
  "../../worker/test-fixtures/calibration-cube.stl",
  import.meta.url,
);
const cube = Buffer.from(await readFile(fixtureUrl));
if (cube.length < 84) throw new Error("Calibration cube fixture is not a binary STL");
// Binary STL headers are descriptive only. A unique one guarantees this run
// cannot hit a prior synthetic SliceResult while preserving the cube geometry.
cube.fill(0, 0, 80);
cube.write(`api-flow-${randomUUID()}`, 0, 80, "ascii");

const form = new FormData();
form.append("file", new Blob([cube], { type: "model/stl" }), "calibration-cube.stl");
const upload = await jsonResponse(
  await request("/api/uploads", {
    method: "POST",
    headers: mutationHeaders(),
    body: form,
  }),
  201,
  "upload",
);
const model = upload.model;
if (!model || typeof model.id !== "string" || model.format !== "stl" || model.fitsBed !== true) {
  throw new Error(`upload returned an unexpected model: ${JSON.stringify(upload)}`);
}
if (![...cookies.keys()].some((name) => name.endsWith("qsid"))) {
  throw new Error("upload did not establish the anonymous quote-session cookie");
}

const sliceSettings = {
  material: "PLA",
  layerHeightUm: 200,
  infillPct: 15,
  supports: "auto",
};
let slice = await jsonResponse(
  await request("/api/slices", {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ modelId: model.id, settings: sliceSettings }),
  }),
  202,
  "slice request",
);
if (typeof slice.sliceId !== "string" || slice.status !== "queued") {
  throw new Error(`slice request did not enqueue new work: ${JSON.stringify(slice)}`);
}

const sliceDeadline = Date.now() + 30_000;
while (slice.status !== "done" && Date.now() < sliceDeadline) {
  if (slice.status === "failed") {
    throw new Error(`stub slice failed: ${JSON.stringify(slice.error)}`);
  }
  await delay(250);
  slice = await jsonResponse(
    await request(`/api/slices/${encodeURIComponent(slice.sliceId)}`),
    200,
    "slice poll",
  );
}
if (slice.status !== "done") throw new Error("stub slice did not finish within 30 seconds");
const expectedStats = {
  filamentGrams: 5,
  filamentMm: 1_670,
  printSeconds: 2_700,
  supportGrams: null,
};
if (JSON.stringify(slice.result) !== JSON.stringify(expectedStats)) {
  throw new Error(`stub slice returned unexpected measurements: ${JSON.stringify(slice.result)}`);
}

const config = { ...sliceSettings, colour: "black", quantity: 1 };
const checkout = await jsonResponse(
  await request("/api/quotations", {
    method: "POST",
    headers: mutationHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      items: [{ modelId: model.id, config }],
      customer: {
        name: "API Flow Test",
        email: "api-flow@example.invalid",
        phone: "+919876543210",
        city: "Guwahati",
        notes: "Disposable CI fixture",
      },
    }),
  }),
  201,
  "checkout",
);
if (
  typeof checkout.number !== "string" ||
  typeof checkout.pdfUrl !== "string" ||
  !checkout.pdfUrl.startsWith(`/api/quotations/${checkout.number}/pdf`)
) {
  throw new Error("checkout returned an invalid quotation reference");
}

const pdfResponse = await request(checkout.pdfUrl);
if (pdfResponse.status !== 200 || pdfResponse.headers.get("content-type") !== "application/pdf") {
  throw new Error(`quotation PDF returned HTTP ${pdfResponse.status}`);
}
const pdf = Buffer.from(await pdfResponse.arrayBuffer());
if (pdf.length < 100 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
  throw new Error("quotation PDF response did not contain a valid PDF header");
}

console.log("[api-flow] upload -> stub slice -> checkout -> PDF passed");
