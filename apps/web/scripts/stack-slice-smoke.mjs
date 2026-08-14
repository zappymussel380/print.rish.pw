#!/usr/bin/env node
/** Drive one real slice through the running stack's public API.
 *
 * The point is that nothing here reaches into a container. The worker picks the
 * job up off the queue by itself, so the slice runs under the real slicer
 * identity (setpriv to SLICER_UID) in the real per-job sandbox, from the real
 * `node dist/index.js` bundle in the worker image.
 *
 * That distinction is not academic. On 2026-08-11 every production slice failed
 * for nine hours while the deploy smoke test — which ran OrcaSlicer by hand,
 * inside the container, as root — passed every time. Root could write the shared
 * temp path that the slicer uid could not, so the by-hand check exercised a code
 * path no customer ever takes. A smoke test run under the wrong identity is
 * worse than no smoke test: it manufactures confidence.
 *
 *   node apps/web/scripts/stack-slice-smoke.mjs <baseUrl> [origin] [fixture]
 *
 * `origin` is the value sent as the Origin header and must equal the stack's
 * APP_ORIGIN, or the mutation origin check rejects the upload. It defaults to
 * `baseUrl` and only differs where the two legitimately diverge: the web image
 * requires APP_ORIGIN to be https, while inside a compose network the container
 * is reached over plain http, so CI addresses http://web:3000 while presenting
 * the configured https origin.
 *
 * `fixture` accepts a binary STL or a STEP file; the upload name and content
 * type follow its extension. Both legs matter — STEP additionally exercises the
 * OpenCASCADE tessellation the worker performs before anything is sliced.
 *
 * Leaves nothing behind: the uploaded model is deleted and no quotation is
 * created. Exits non-zero if the slice does not finish.
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error("usage: stack-slice-smoke.mjs <baseUrl> [origin] [fixture]");
  process.exit(2);
}
const origin = process.argv[3] || baseUrl;
const fixture = process.argv[4] ?? "apps/worker/test-fixtures/calibration-cube.stl";
const INGEST_TIMEOUT_MS = 120_000;
const SLICE_TIMEOUT_MS = 600_000;

const cookies = new Map();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(new URL(path, baseUrl), { ...init, headers, redirect: "manual" });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return res;
}

async function json(res, expected, label) {
  const body = await res.text();
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(res.status)) {
    throw new Error(
      `${label}: expected HTTP ${allowed.join(" or ")}, got ${res.status} — ${body.slice(0, 400)}`,
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label}: response was not JSON — ${body.slice(0, 200)}`);
  }
}

const mutation = (extra = {}) => ({ "x-requested-with": "XMLHttpRequest", origin, ...extra });

async function poll(path, label, timeoutMs, onUpdate) {
  const deadline = Date.now() + timeoutMs;
  let state = { status: "queued" };
  while (!["done", "failed"].includes(state.status) && Date.now() < deadline) {
    await delay(1000);
    state = await json(await request(path), 200, label);
    onUpdate?.(state);
  }
  return state;
}

const model = Buffer.from(await readFile(fixture));
const uploadName = fixture.split("/").pop();
const isStep = /\.(step|stp)$/i.test(uploadName);

// The upload has to be perturbed so it does not collide with a previous run's
// cached SliceResult, which is keyed on the stored file's hash — otherwise the
// smoke test would report success without any slicing having happened.
let payload;
if (isStep) {
  // A STEP file opens with the ISO-10303-21 magic and the worker rejects
  // anything else, so the STL trick below would make it unrecognisable. Append
  // a comment after the terminator instead: it changes the hash without
  // touching the structure.
  //
  // Note this only defeats the *ingest* cache. STEP is tessellated to a
  // canonical STL before storage and that conversion is deterministic, so the
  // stored file — and therefore the slice cache key — is identical across runs.
  // The STEP leg proves upload and STEP→STL conversion; the slice itself may
  // legitimately be served from cache.
  payload = Buffer.concat([model, Buffer.from(`\n/* stack-smoke-${randomUUID()} */\n`, "ascii")]);
} else {
  if (model.length < 84) throw new Error(`${fixture} is not a binary STL`);
  // Binary STL headers are descriptive only, so overwriting one keeps the
  // geometry while guaranteeing a fresh hash.
  model.fill(0, 0, 80);
  model.write(`stack-smoke-${randomUUID()}`, 0, 80, "ascii");
  payload = model;
}

const form = new FormData();
form.append(
  "file",
  new Blob([payload], { type: isStep ? "application/step" : "model/stl" }),
  uploadName,
);
const upload = await json(
  await request("/api/uploads", { method: "POST", headers: mutation(), body: form }),
  202,
  "upload",
);
console.log(`upload queued   ticket=${upload.ticket} position=${upload.position}`);

const ingest = await poll(
  `/api/uploads/status/${encodeURIComponent(upload.ticket)}`,
  "ingest poll",
  INGEST_TIMEOUT_MS,
);
if (ingest.status !== "done") {
  throw new Error(`ingest ${ingest.status}: ${JSON.stringify(ingest.error ?? ingest)}`);
}
console.log(`ingest done     modelId=${ingest.model.id} triangles=${ingest.model.triangleCount}`);

const queued = await json(
  await request("/api/slices", {
    method: "POST",
    headers: mutation({ "content-type": "application/json" }),
    body: JSON.stringify({
      modelId: ingest.model.id,
      settings: {
        material: "PLA",
        colour: "black",
        quality: "standard",
        layerHeightUm: 200,
        infillPct: 15,
        supports: "auto",
      },
    }),
  }),
  // 202 queues a fresh slice; 200 means an identical stored file was already
  // sliced with these settings and the cached SliceResult came straight back.
  // That is a legitimate outcome — see the STEP note above — and the polling
  // and measurement assertions below still have to pass either way.
  [202, 200],
  "slice request",
);
console.log(
  `slice ${queued.status === "done" ? "cached  " : "queued  "} sliceId=${queued.sliceId}`,
);

let lastStage = "";
const slice = await poll(
  `/api/slices/${encodeURIComponent(queued.sliceId)}`,
  "slice poll",
  SLICE_TIMEOUT_MS,
  (s) => {
    const stage = `${s.progressPct ?? "?"}% ${s.progressStage ?? ""}`;
    if (stage !== lastStage) {
      lastStage = stage;
      console.log(`  ${stage} ${s.progressMessage ?? ""}`);
    }
  },
);

let failure = null;
if (slice.status !== "done") {
  failure = `slice ${slice.status}: ${JSON.stringify(slice.error ?? slice)}`;
} else if (!(Number(slice.result?.filamentGrams) > 0) || !(Number(slice.result?.printSeconds) > 0)) {
  // A "done" slice carrying no measurements would mean the stub slicer ran, or
  // the result never made it back — either way this test proved nothing.
  failure = `slice reported no measurements: ${JSON.stringify(slice.result ?? {})}`;
} else {
  console.log(
    `SLICE OK        filamentGrams=${slice.result.filamentGrams} printSeconds=${slice.result.printSeconds}`,
  );
}

// Best-effort: never let cleanup mask the real result.
try {
  const cleanup = await request("/api/models", {
    method: "DELETE",
    headers: mutation({ "content-type": "application/json" }),
    body: JSON.stringify({ keep: [] }),
  });
  console.log(`cleanup         DELETE /api/models -> ${cleanup.status}`);
} catch (error) {
  console.log(`cleanup         failed (ignored): ${error.message}`);
}

if (failure) {
  console.error(failure);
  process.exit(1);
}
