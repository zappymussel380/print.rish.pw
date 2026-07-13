# Repository audit and action plan

Audit performed **2026-07-13** at commit `017c855` by a full manual read of ~90% of
server-side source, all infra/CI config, and all security docs (React components,
the PDF template, and marketing pages got lighter structural review). The owner
has reviewed the audit and answered its open questions; those decisions are
folded in below and marked **DECIDED**.

**How to use this document (Codex):** work the task plan top to bottom
(M0 → M1 → M2 → M3). Before acting on any finding, re-verify it against the
current code — cite lines here may have drifted. Match the repo's culture:
comments explain constraints, docs are kept accurate (update `SECURITY.md` /
`MAINTENANCE.md` / `ENV.md` whenever behavior changes), fail closed, no new
dependencies without need. Run `pnpm -r typecheck && pnpm -r test && pnpm build`
before claiming any task done. Do not change security semantics as a side effect
of cleanup.

---

## 1. Owner decisions (2026-07-13)

1. **PII retention — DECIDED:** do **not** anonymize. Delete quotation data
   **90 days** after the quotation reaches a terminal state (same window for
   COMPLETED, DELIVERED, and CANCELLED). Add a clear note on the website that
   customers agree their data is stored for 90 days and that **no analysis and
   no selling** of their data happens — the goal is earned trust. → Task 1.2.
2. **Admin auth — DECIDED (defer):** a single password is fine for now.
   Revocation/TOTP moved to the Deferred section; revisit later.
3. **Global ingest lock — DECIDED (keep + monitor):** keep the one-at-a-time
   upload-inspection lock. Add visibility (count/alert on `INGEST_BUSY` /
   `UPLOAD_BUSY` 503s) so the decision to build a dedicated ingest service can
   be made from data instead of guesswork. → folded into Tasks 2.1 and 3.4.
   *(Superseded by decision 8: the lock is replaced by the upload queue,
   Task 2.4. The 2.1 alert remains as an interim measure until 2.4 lands.)*
4. **Legacy PDF query-token path — DECIDED:** there are no orders yet, so no
   legacy links exist. Remove the path now instead of waiting for token expiry.
   → Task 1.3.
5. **PRODUCT.md — DECIDED:** commit it as the design charter. (Audit note: its
   content was reviewed — users, purpose, brand personality, design principles,
   accessibility targets — and contains nothing confidential.) → Task 1.4.
6. **Alert channel — DECIDED:** reuse the existing Telegram bot/chat for
   operational alerts. → Task 2.1.
7. **Verification debt — DECIDED:** the audit environment could not run the
   suite (Node 20 + broken corepack; repo needs Node ≥ 24). Re-running the full
   verification is a task for Codex. → Task 0.5.

**Follow-up decisions (same day, after review):**

8. **Upload queue — DECIDED:** replace the "busy, try again" contention error
   with a real queue. Uploads are always accepted (up to a hard depth bound);
   the customer sees an honest position — "N models ahead of you" — with no
   details about other customers' models. This supersedes the "keep + monitor"
   part of decision 3: the global ingest lock is replaced by a FIFO ingest
   queue consumed in the worker, which also retires residual risk S2 (parsing
   on the web event loop) — the direction `docs/SECURITY.md` and
   `docs/HARDENING.md` already recommend. → Task 2.4 (sketch ④).
9. **Prisma → Kysely (suggested by a friend) — RECOMMENDATION: do not migrate
   now** (owner may overrule; see §"Evaluated — not adopted now"). Prisma is
   load-bearing in exactly the conditional-claim code that guards money and
   races, and that code has no real-database tests yet. Build Tasks 0.2/0.3
   first — they are the harness that would make any future data-layer migration
   safe — and revisit only on a concrete trigger.

---

## 2. Executive summary

**Overall health: A−.** The security architecture described in
`docs/SECURITY.md` and `docs/HARDENING.md` is actually implemented in the code —
every claim spot-checked (proxy trust, IP validation, capability hashing,
single-use checkout claims, generation-fenced worker writes, column-scoped DB
grants) matched the source. There are **no Critical or High findings**; residual
risks are known, documented, and mostly deliberate trade-offs.

Deductions from a straight A:

- The core race-safety mechanisms (conditional `updateMany` fences, single-use
  claims) are verified only through **mocked** Prisma calls, never against a
  real Postgres.
- The root `lint` script is a **phantom** — no linter config exists anywhere,
  despite `eslint-disable` comments in source.
- Quotation PII had **no maximum retention** (now decided: 90 days, Task 1.2).

Top 3 risks: (1) cutover misconfiguration of `TRUSTED_PROXY_CIDR` / edge header
overwriting, on which per-IP rate-limit fairness depends (fails closed, but
degrades all per-IP limits into shared buckets); (2) indefinite PII accumulation
(being fixed by Task 1.2); (3) mock-only testing of the money-path race fences,
meaning a Prisma upgrade could silently change their semantics.

Top 3 opportunities: a real-database integration test suite for checkout/slice
fences (highest leverage per hour), a real lint gate in CI (half a day,
permanent payoff), and operational alerting through the existing Telegram bot.

---

## 3. Repo map (orientation for the reader)

**Purpose:** instant 3D-printing quotation service. Uploads are genuinely
sliced with OrcaSlicer; pricing derives from real toolpath grams/time; checkout
produces a PDF quotation, WhatsApp handoff, and Telegram notification.
Solo-operated; VPS cutover pending.

**Stack:** pnpm 11 monorepo · Next.js 15 App Router (TS strict +
`noUncheckedIndexedAccess`) · Prisma/PostgreSQL 16 · Redis 7 (BullMQ, rate
limits, locks) · OrcaSlicer 2.4.1 headless in a hardened container · Docker
Compose · GitHub Actions (typecheck + test + build + `pnpm audit`, Trivy,
CodeQL, nginx trust-validator tests — all actions SHA-pinned).

```
apps/web/          Next.js UI + all API routes; lib/ = security, sessions, storage, shipping
apps/worker/       BullMQ consumer: Orca runner (per-job UID isolation), thumbnails, retention
packages/db/       Prisma schema + migrations, client singleton
packages/shared/   Pure pricing engine, catalog, zod schemas, settings keys, message builders
packages/geometry/ STL/3MF/OBJ/AMF parsers with hard resource budgets (incl. bomb fixtures)
docker/            Dockerfiles (split runner/migrate targets), nginx proxy template, validator
docs/              architecture, deploy, env, security, hardening, maintenance…
```

---

## 4. Findings (reference — grouped by dimension, severity-sorted)

Severity scale: Critical / High / Medium / Low / Info. No Critical or High
findings exist.

### 4.1 Security

Verified strengths (facts): Fetch-Metadata + exact-Origin CSRF
(`apps/web/lib/security.ts:14-26`); strict X-Real-IP validation failing closed
to an `unknown` bucket (`security.ts:36-53`); atomic Lua sliding-window rate
limiter that doesn't grow sets on rejection (`security.ts:181-201`);
hashed-at-rest quotation capabilities with constant-work comparison and
enumeration-uniform 404s (`apps/web/lib/quotation-access.ts:37-50`,
`apps/web/app/api/quotations/[number]/pdf/route.ts:44-57`); O_NOFOLLOW
descriptor-validated file opens (`apps/web/lib/storage.ts:79-101`); nginx
fail-closed proxy trust with CI-tested validator (`docker/proxy/nginx.conf:56-64`);
per-job slicer UIDs with capability stripping and a /proc-scanning reaper that
kills the worker if reaping fails (`apps/worker/src/orca.ts:139-263`);
column-scoped grants making slicer measurements worker-only
(`apps/web/scripts/provision-database.mjs:134-154`); client-side SCRAM verifier
generation so role passwords never reach server logs
(`provision-database.mjs:47-55`).

| # | Severity | Finding | Where | Status |
|---|----------|---------|-------|--------|
| S1 | Medium | Admin auth is one static password + 12 h non-revocable JWT; logout only deletes the cookie. | `apps/web/lib/session.ts:14,107-116` | **Deferred by owner decision 2.** Documented residual risk stands (`docs/SECURITY.md`). |
| S2 | Medium | Geometry parsing runs synchronously on the web event loop under a non-renewing global lease; worst-case valid model can stall a replica. | `apps/web/app/api/uploads/route.ts:407-489` | **Fix via Task 2.4** (decision 8): ingest moves off the web event loop into a worker-consumed FIFO queue. Interim: Task 2.1 alert on `INGEST_BUSY`. |
| S3 | Low | Quotation PII/PDFs had no maximum retention; sweep purged model files only. | `apps/worker/src/retention.ts:173-287` | **Fix via Task 1.2** (90-day deletion + website notice). |
| S4 | Low | Legacy query-string capability path for PDFs still accepted. | `apps/web/app/api/quotations/[number]/pdf/route.ts:40,54,75-82` | **Remove now via Task 1.3** (no orders exist yet). |
| S5 | Low | Admin JWT verification logic duplicated between edge middleware and session lib (deliberate, edge-compat) — drift risk. | `apps/web/middleware.ts:9-32` vs `apps/web/lib/session.ts:15-45` | Task 3.2 (consolidate constants only; keep middleware Redis-free). |
| S6 | Info | `/api/health` public, discloses db/redis booleans (5 s-cached, deduped). Documented and accepted. | `apps/web/app/api/health/route.ts` | No action. |

### 4.2 Testing

| # | Severity | Finding | Where | Status |
|---|----------|---------|-------|--------|
| T1 | Medium | Race-safety core (single-use checkout claim, slice attempt-generation fences, retention conditional deletes) tested only with mocked Prisma; real SQL semantics never exercised. | e.g. `apps/web/test/slices-route.test.ts:17-30` | Tasks 0.2 + 0.3. |
| T2 | Medium | No component/browser/E2E tests; ~2,300 lines of React verified only manually. | `apps/web/components/**`, `apps/web/vitest.config.ts` (node env only) | Task 2.2 (API-level flow test first; UI tests remain out of scope). |
| T3 | Low | No coverage measurement; `--passWithNoTests` could mask an empty suite. | `apps/web/vitest.config.ts`; `apps/web/package.json` | Task 0.4. |
| T4 | Info | Audit environment could not run the suite (Node 20, broken corepack). CI attests green on Node 24 (2026-07-13). | — | Task 0.5. |

Strength: existing tests are behavior-asserting and adversarial (IPv6
canonicalization to one rate-limit key, ZIP local/central-directory divergence,
`bomb.3mf` fixture, retry state machines). ~2,900 test lines vs ~14k source.

### 4.3 Code quality

Healthy: strict TS everywhere; zero `console.*` / `TODO` / `@ts-ignore` /
`as any` in first-party source; comments explain constraints, not mechanics.

| # | Severity | Finding | Where | Status |
|---|----------|---------|-------|--------|
| Q1 | Low | Phantom lint pipeline: root `"lint": "pnpm -r lint"` matches zero packages; no ESLint/Prettier/Biome config anywhere; CI has no lint step; four vestigial `eslint-disable` comments in source. | `package.json:15`; `.github/workflows/security.yml`; `apps/web/app/api/contact/route.ts:27`, `packages/shared/src/filename.ts:35`, `apps/web/components/quote/model-card.tsx:67`, `model-viewer.tsx:167` | Task 0.1. |
| Q2 | Low | `threemf.ts` (775 lines) is the complexity hotspot (archive traversal + mesh XML + plate settings + JSON preflight + transforms + DOM helpers). Cohesive and well-tested. | `packages/geometry/src/threemf.ts` | No action unless the file grows again. |
| Q3 | Info | Minor duplication: UUID regex in 6+ files; `fitsBed` copied between two routes. | `apps/web/lib/storage.ts:6`, `apps/worker/src/index.ts:29`, `apps/worker/src/retention.ts:16`, `apps/web/app/api/uploads/route.ts:157-163` vs `apps/web/app/api/models/route.ts:26-32` | Task 3.2. |
| Q4 | Info | Worker runs TS via `tsx` in production. | `docker/worker.Dockerfile:109` | Task 3.3 (polish). |

### 4.4 Architecture & design

Healthy. Boundaries clean (routes → `lib/` → workspace packages; `geometry`
depends only on `fflate`/`xmldom`; `shared` only on `zod`; no circular deps
observed). Worker/web privilege split enforced simultaneously at DB, filesystem,
and container layers. The 200-line upload `POST` handler
(`apps/web/app/api/uploads/route.ts:298-497`) is long but linear and its
ordering is load-bearing — do not split it as a cleanup.

### 4.5 Performance

Healthy for intended scale. Bounded notables: global single-flight ingest lock
(60 s wait → 503, `uploads/route.ts:488`) — first ceiling under growth, now
monitored per decision 3; checkout runs ≤2 queries per line item, bounded at 20
items (`apps/web/app/api/quotations/route.ts:101-147`) — not worth batching;
slice polling costs 2 DB queries per 1.5 s poll (`apps/web/app/api/slices/[id]/route.ts:32-37`)
— revisit only at 10× concurrency; Telegram notify blocks checkout ≤5 s with a
hard timeout and never throws (`apps/web/lib/telegram.ts:107-146`) — correct.

### 4.6 Dependencies & supply chain

Healthy process: `minimumReleaseAge: 1440` + `allowBuilds` allowlist
(`pnpm-workspace.yaml`); Dependabot weekly (npm, docker ×2, actions); images and
actions digest/SHA-pinned; runtime images strip package managers. Pending majors
(no known vulns as of the 2026-07-13 audit run): Next 15→16, zod 3→4,
bcryptjs 2→3. Residual unfixed Debian base-image advisories tracked honestly in
`docs/HARDENING.md`. Licenses: all permissive; repo MIT with content carve-out.

### 4.7 DevEx & operations

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| O1 | Low | No engine enforcement — installs on wrong Node proceed with only a warning. | Task 0.4 (`.npmrc` `engine-strict=true`). |
| O2 | Low | No alerting on business failures (checkout 5xx, PDF failure, Shiprocket cap, ingest busy, worker heartbeat loss). | Task 2.1. |
| O3 | Info | Backup restore never drilled (`docs/SECURITY.md:127`). | Task 2.3 (operational). |
| O4 | Info | `PRODUCT.md` untracked. | Task 1.4 (commit — decision 5). |

### 4.8 Documentation

Exceptionally healthy. Every cross-checked claim matched code, including subtle
ones (cookie `Secure` derivation, canonical-STL rationale, compose `$$` bcrypt
escaping footgun, `TRUSTED_PROXY_CIDR` fail-closed contract). Docs honestly
list residual risks. Keep them accurate as tasks land — that is part of each
task's acceptance criteria.

### 4.9 Lighter-review areas

Structural skim only: React components (`apps/web/components/**` — the three
read fully were clean), `apps/web/lib/pdf/quotation-pdf.tsx`, marketing pages,
`packages/geometry/src/{png,math,obj,amf,thumbnail}.ts` internals (bounds
verified; rasterization math not re-derived), `docker-compose.vault.yml`,
`docs/STORAGE_VAULT_LXC.md`.

---

## 5. Task plan

### Milestone M0 — safety net

| ID | Task | Files | Acceptance criteria | Effort | Risk |
|----|------|-------|---------------------|--------|------|
| 0.1 | Real lint gate: ESLint flat config + `eslint-config-next` + typescript-eslint; per-package `lint` scripts; CI step. Keep rules minimal (no style bikeshedding — source is already consistent); ignore `.next/`, `packages/db/generated/`. The four existing `eslint-disable` comments become live or are removed. | new `eslint.config.mjs`, package.json files, `.github/workflows/security.yml` | `pnpm lint` runs real tooling and passes; CI fails on violations | S | Low |
| 0.2 | Integration-test rig: Postgres 16 + Redis 7 service containers in the CI `verify` job (digest-pinned like compose); run `prisma migrate deploy` (owner URL) then `apps/web/scripts/provision-database.mjs`; add a separate vitest project (`apps/web/vitest.integration.config.ts`, `test-integration/**`). | CI workflow, new test config/dir | Integration suite runs green in CI against real services; unit suite unchanged and fast | M | Low |
| 0.3 | Fence tests on the rig (see sketch ①): concurrent checkout single-use claim, slice retry generation fence, retention conditional deletes, models DELETE keep-list race. Run under the provisioned `print_web` role so column-scoped grants are regression-tested too. | `apps/web/test-integration/**` | Two concurrent checkouts of one model → exactly one `Quotation` row, one 201 + one 409; stale-generation write is a no-op; assertions on DB state, not mocks | M | Low |
| 0.4 | Hygiene: vitest coverage reported in CI output; drop `--passWithNoTests` from `apps/web/package.json`; add `.npmrc` with `engine-strict=true`. | small config edits | Coverage visible in CI; install on Node < 24 fails loudly | S | Low |
| 0.5 | Re-run full verification on Node 24 (the audit machine could not): `pnpm install --frozen-lockfile && pnpm -r typecheck && pnpm -r test && pnpm build && pnpm audit --audit-level low`. Record the result (date + outcome) at the top of this file. | this file | All green, or failures triaged and fixed | S | Low |

### Milestone M1 — decided security/correctness work

| ID | Task | Files | Acceptance criteria | Effort | Risk |
|----|------|-------|---------------------|--------|------|
| 1.1 | VPS cutover verification (operational; owner-driven, Codex assists with docs only). Follow `docs/DEPLOYMENT.md` §"Verify the proxy trust cutover" and the owner's cutover checklist: exact `TRUSTED_PROXY_CIDR`, edge overwrites both forwarding headers, post-cutover logs show distinct real client IPs, direct probe to 8080 from another peer gets 403. | `.env` on host; no code | All checks pass with recorded evidence | S | Medium (prod config) |
| 1.2 | **90-day PII deletion + website notice (DECIDED — see sketch ②).** Delete quotation rows (cascade items/history), PDFs, and now-orphaned models 90 days after terminal state. Add the customer-facing storage notice. No anonymization. | `apps/worker/src/retention.ts`, `apps/worker/src/config.ts`, `.env.example`, `docker-compose.yml`, checkout form + FAQ page, `docs/SECURITY.md`, `docs/MAINTENANCE.md`, `docs/ENV.md` | Aged terminal quotation fully deleted (row+PDF+files); non-terminal untouched; integration test proves it; notice visible at checkout; docs updated | M | Medium (destructive path) |
| 1.3 | **Remove legacy PDF query-token path (DECIDED).** Delete the `?token=` acceptance and the cookie-upgrade branch for it; cookie/fragment path unchanged. There are no existing orders, so no links break. | `apps/web/app/api/quotations/[number]/pdf/route.ts` | Query token no longer authorizes; tests updated; `docs/SECURITY.md` compatibility note removed | S | Low |
| 1.4 | **Commit `PRODUCT.md` (DECIDED).** Content reviewed — nothing confidential. | `PRODUCT.md` | Tracked in git | S | Low |

### Milestone M2 — high-leverage improvements

| ID | Task | Files | Acceptance criteria | Effort | Risk |
|----|------|-------|---------------------|--------|------|
| 2.1 | **Operator alerts via the existing Telegram bot (DECIDED — see sketch ③).** Alert on: checkout 5xx, PDF generation failure, Shiprocket daily-cap reached, worker heartbeat missing, and `INGEST_BUSY`/`UPLOAD_BUSY` 503 occurrences (interim signal until Task 2.4 replaces the lock; afterwards alert on ingest queue depth instead). Alerts must be rate-limited so an outage can't flood the chat. | `apps/web/lib/telegram.ts` (generalize sender), call sites, worker | Forced checkout failure produces one alert within a minute; alert storm capped | M | Low |
| 2.2 | API-level flow test: scripted upload (fixture cube) → stub-slicer completes the job → checkout → PDF exists; runs against a real dev server in CI. A worker env flag (`STUB_SLICER=true`, dev/test only, refused in production) returns canned plausible stats instead of spawning Orca. | new test script, small worker flag | One CI job proves the full HTTP funnel without Orca | L | Medium |
| 2.3 | Backup restore drill (operational): restore PG dump + volumes onto a clean host per `docs/MAINTENANCE.md`; record a dated note of the result in that doc. | `docs/MAINTENANCE.md` | Dated successful drill note exists | M | Low |
| 2.4 | **Upload ingest queue with visible position (DECIDED — decision 8, sketch ④).** Uploads return `202 + ticket` after the file lands; a worker-consumed FIFO queue (concurrency 1) parses and persists; the upload page polls the ticket and shows "N models ahead of you". Retires the global ingest lock, the per-session finalization lock, and residual risk S2. Sub-steps: (a) worker ingest consumer + `UploadedModel` INSERT grant for the worker role (M); (b) ticket status endpoint + queue-position calculation (S); (c) dropzone/quote-store rework for queued/processing states (M); (d) docs (`SECURITY.md`, `HARDENING.md`, `ARCHITECTURE.md`, `API.md`) + integration tests on the 0.2 rig (M). | `apps/web/app/api/uploads/**`, `apps/web/lib/upload-*`, `apps/web/components/quote/dropzone.tsx`, `apps/web/lib/quote-store.ts`, `apps/worker/src/**`, `apps/web/scripts/provision-database.mjs`, docs | Contended uploads queue instead of erroring; position shown is real queue state; parse no longer runs in the web process; fence/limit tests green; hard depth bound still exists but is practically unreachable | XL (broken down above) | Medium |

### Milestone M3 — polish

| ID | Task | Files | Acceptance criteria | Effort | Risk |
|----|------|-------|---------------------|--------|------|
| 3.1 | Consolidate duplicated helpers: UUID regex, `fitsBed`, JWT issuer/audience/cookie-name constants (middleware keeps its own verification *logic*, shares only constants). | `packages/shared`, ~8 call sites | Single source each; zero behavior change; suite green | S | Low |
| 3.2 | Worker build step: compile to JS, run `node dist/index.js`, drop `tsx` from the production image. | `apps/worker/package.json`, `docker/worker.Dockerfile` | Image smoke test passes; `tsx` absent from final image | S | Low |
| 3.3 | Major upgrades as separate PRs when Dependabot offers: Next 16, zod 4, bcryptjs 3. Each PR must pass the integration suite (0.3). | lockfile + code as needed | CI fully green per upgrade | L | Medium |
| 3.4 | Add a "scale triggers" note to `docs/ARCHITECTURE.md`: revisit ingest capacity (queue consumer concurrency, child-process or dedicated ingest service) when queue-wait alerts from 2.1/2.4 become regular; revisit poll-path caching at ~10× quote-page concurrency. | `docs/ARCHITECTURE.md` | Note present; no code change | S | Low |

### Quick wins (do first)

0.1 (lint), 0.4 (three one-liners), 0.5 (verification stamp), 1.3 (legacy token
removal), 1.4 (commit PRODUCT.md).

### Deferred by owner decision

- **Admin session revocation (jti denylist) and optional TOTP** — decision 2:
  single password is acceptable for now. When picked up later: add `jti` to the
  admin JWT, denylist it in Redis on logout, check in `requireAdminApi` (keep
  middleware Redis-free; fail closed if Redis is down); TOTP gated on an
  `ADMIN_TOTP_SECRET` env var, required after the bcrypt check inside the
  existing global-budget flow.
- **Dedicated ingest *service/VM*** (separate container/VM for parsing) — the
  queue in Task 2.4 gets most of the benefit (off the web event loop, FIFO
  fairness, no advisory-lock races). Full process isolation for the parser
  (child process or separate service) remains a later hardening step; revisit
  with data from queue-depth alerts.

### Evaluated — not adopted now: Prisma → Kysely (decision 9)

**Recommendation: stay on Prisma for now.** Kysely is a reasonable tool and the
instinct behind the suggestion isn't wrong — this codebase hand-writes
conditional-claim semantics (`updateMany` + `items: { none: {} }` fences) where
explicit SQL would be *more* transparent, and the repo has already been bitten
by Prisma semantic drift once (see the `notIn: []` inconsistency note in
`apps/web/app/api/models/route.ts`). But migrating now is maximum risk for
minimum payoff:

- Prisma is load-bearing in exactly the code that guards money and races
  (checkout transaction + single-use claims, slice generation fences, retention
  conditional deletes), and none of that behavior has real-database tests yet
  (finding T1). A rewrite before Tasks 0.2/0.3 exist would swap the layer under
  the most critical logic with no net to catch semantic changes.
- The full surface is large: ~40+ call sites across web/worker, interactive
  transactions, `Decimal(10,3)` handling (pg returns numerics as strings —
  every `Number(slice.filamentGrams)` site needs review), JSON columns, the
  migration tooling story (`prisma migrate deploy` is wired into the migrate
  container and docs), and the Dockerfile engine-bundling that is already
  solved and tested.
- The main structural complaints about Prisma (query-engine binary in images,
  generate step) are already tamed here, and Prisma's own roadmap is moving to
  engine-less clients, which weakens the argument further over time.

**Revisit triggers** (any one of these makes the migration worth re-costing):
a Prisma upgrade blocked or behavior-changing in the fence queries; an
engine-related CVE without a timely fix; a query the app genuinely needs that
Prisma cannot express; sustained image-size or memory pressure attributable to
the engine.

**If adopted later, the safe path:** land 0.2/0.3 first and keep those
integration tests ORM-agnostic (they drive route handlers, not the ORM);
migrate table-by-table starting with low-risk reads; consider the hybrid where
the Prisma schema stays as the type source (`prisma-kysely` codegen) so
migrations and types keep a single source of truth.

---

## 6. Implementation sketches (key tasks)

### ① Task 0.2/0.3 — real-database fence tests

Add `services:` blocks (postgres:16-alpine, redis:7-alpine, digest-pinned) to
the CI `verify` job; run `prisma migrate deploy` with an owner URL, then
`node apps/web/scripts/provision-database.mjs` so tests run under the actual
web-role grants — regression-testing the grant script itself. Separate vitest
project so unit tests stay service-free. Tests import route handlers directly
and invoke them with constructed `NextRequest`s (env access is lazy —
`apps/web/lib/env.ts:100-113` — so setting `DATABASE_URL`/`REDIS_URL`/
`SESSION_SECRET` in setup suffices). Key cases: (a) seed a session + DONE
`SliceResult`, fire two `POST /api/quotations` concurrently, assert exactly one
201/one 409/one `Quotation`; (b) FAILED slice → retry → stale-generation
`updateRunningSliceAttempt` is a no-op; (c) retention sweep against fixture
files in a temp `UPLOAD_DIR`. Gotchas: `cookies()` needs request scope — mint
the session JWT with `jose` (reuse the signing shape from
`apps/web/lib/session.ts:47-59`) and pass it as a Cookie header; flush Redis
between tests (rate limits); run money-path tests under the provisioned
`print_web` role to catch grant drift (e.g. the column-scoped `SliceResult`
INSERT list in `provision-database.mjs:143-147`).

### ② Task 1.2 — 90-day deletion + website notice (DECIDED shape)

Config: `QUOTATION_RETENTION_DAYS` (default **90**) in
`apps/worker/src/config.ts`, `.env.example`, compose, `docs/ENV.md`.

Sweep: add a step to `runRetention` mirroring the existing terminal-quotation
pagination (`retention.ts:211-279`): select quotations with
`status IN (COMPLETED, DELIVERED, CANCELLED)` and
`updatedAt < now - QUOTATION_RETENTION_DAYS`. For each: delete the `Quotation`
row first (schema cascades items + history), then unlink the PDF via the
existing path-derivation pattern, then delete now-orphaned models with the
established conditional claim (`deleteMany` where `items: { none: {} }` —
mirror `apps/web/app/api/admin/quotations/[id]/route.ts:97-109`) and unlink
their files/thumbnails. Terminal statuses are immutable
(`admin/quotations/[id]/route.ts:46-48`), so age is a stable boundary; the
orphan reconciler remains the safety net for unlink failures. Note that
`FILE_RETENTION_DAYS` (30 d) already removes model files earlier — this step
removes rows + PDFs. Non-terminal quotations are never auto-deleted (the admin
closes orders; document this nuance).

Website notice (required elements, wording Codex's): at the checkout form near
the contact fields and in the FAQ — customer details are stored **only to
process the order**, are **deleted 90 days after the order completes or is
cancelled**, and are **never analyzed, sold, or used for marketing**. Keep it
honest: details are shared with the operator's WhatsApp/Telegram/email and the
shipping API as part of processing (already documented in `SECURITY.md`).

Consequence to document for the owner (in `docs/MAINTENANCE.md`): revenue
history older than 90 days disappears from the app — if long-term records are
wanted, download the admin CSV export periodically; the sweep will not keep it.

Update `docs/SECURITY.md` (the "no automatic maximum retention" residual-risk
paragraph) and `docs/MAINTENANCE.md` retention section. Integration test on the
0.2 rig proves: aged terminal quotation fully gone; fresh terminal and
non-terminal quotations untouched.

### ③ Task 2.1 — operator alerts via the existing bot

Generalize `apps/web/lib/telegram.ts` with a small `sendOperatorAlert(kind, message)`
that reuses the existing token/chat/thread env and 5 s timeout, never throws,
and rate-limits per `kind` via a Redis `SET NX EX` key (e.g. one alert per kind
per 15 min, with a suppressed-count appended on the next send). Wire call
sites: checkout catch path and PDF-failure branch
(`apps/web/app/api/quotations/route.ts:367-370`), Shiprocket daily-cap branch
(`apps/web/lib/shipping.ts:218-221`), `INGEST_BUSY`/`UPLOAD_BUSY` 503 branches
in the upload route, and a worker-side alert when the heartbeat loop detects
Redis unreachable for > 1 min. Gotchas: alerts must not add latency to the
customer path (fire-and-forget with `.catch`); never include customer PII in
alert text (match `logger` redaction discipline); worker has its own pino +
Redis — reuse its connection, not a new one.

---

### ④ Task 2.4 — upload ingest queue with visible position (DECIDED shape)

Goal: a contended upload never errors; the customer sees "N models ahead of
you" (a count only — never another customer's model details). This replaces the
`geometry-ingest` and `upload-session` advisory locks with a real FIFO and
moves parsing off the web event loop, in line with the ingest-isolation
direction `docs/SECURITY.md` already recommends.

**Flow.** `POST /api/uploads` keeps its entire transport phase unchanged
(CSRF + rate limits, byte budgets, storage reservations, busboy streaming to an
exclusive `uploads/tmp/<uuid>` file, truncation/size checks, extension check,
session model-count precheck). Then, instead of parsing inline, it enqueues a
BullMQ `ingest` job and returns `202 { ticket, position }`. A new
`GET /api/uploads/status/[ticket]` reports `queued(position)` →
`processing` → `done(models[])` | `failed(code,message)`. The dropzone polls it
(reuse the `use-slice-sync` polling pattern, ~1.5 s) and renders the position.
On `done`, the payload is exactly today's `{ model, models }` shape so
`markReadyMany`, multi-plate, and the restore flow keep working.

**Queue as the source of truth — no new table.** The BullMQ job *is* the
ticket: `jobId` = a fresh UUID returned to the client; job data =
`{ tmpName, sessionId, originalName, format, sizeBytes, sha256, reservationMember }`
where `tmpName` is the bare UUID filename — the worker re-derives the full path
under its own `UPLOAD_DIR` (matching the server-derived-paths discipline in
`lib/storage.ts`; never a client- or Redis-supplied path). Status endpoint:
load the job, require `job.data.sessionId` to match the caller's session (404
otherwise, like model routes), map BullMQ state → ticket state; position =
index in the waiting list + 1 if a job is active; keep completed jobs
~1 h (`removeOnComplete: { age: 3600 }`) so slow pollers still see results.
Rate-limit polling with a bucket like `slicePoll`.

**Worker consumer.** A second BullMQ `Worker` in `apps/worker` with
**concurrency 1** — the same one-at-a-time protection the global lock provided,
now with real FIFO fairness and no lease-expiry ambiguity. It runs the logic
currently in the upload route's locked section: read temp file →
`prepareUploadModels` → per-file/session-limit checks → persist models +
canonical STLs + thumbnail → delete temp file → return the serialized models as
the job's return value. Single consumer makes the session-limit check
race-free, so the `upload-session` Redis lock is deleted too. `ModelParseError`
→ `job.failed` with the existing `INVALID_MODEL_*` codes so client messages
are unchanged.

**Grants.** The worker role needs `INSERT` on `UploadedModel`
(`provision-database.mjs` — today it has only SELECT/UPDATE/DELETE, line ~152).
Once the web route no longer creates models, *revoke* web's `INSERT` on
`UploadedModel` — net privilege moves rather than widens. Update the grant
comments and `docs/SECURITY.md`/`docs/DATABASE.md` accordingly.

**Bounds and failure honesty.**
- Hard queue-depth cap (e.g. 25 waiting): beyond it, reject at POST with a
  friendly "site is unusually busy" — the error still exists but is practically
  unreachable, and temp-file disk exposure stays bounded (the existing
  capacity-reservation zset still covers reserved bytes; move the reservation
  release from request-end to ingest completion/failure — its TTL mechanism
  already fits).
- Retention's 2 h tmp-file grace (`retention.ts:147-159`) comfortably exceeds
  any realistic queue transit; assert that relationship in a comment.
- BullMQ retry: `attempts: 1` for ingest (a parse failure is deterministic;
  retrying a hostile file is waste). A worker crash mid-ingest leaves a
  temp file for the sweeper and a `failed` ticket — the client offers re-upload.
- New coupling: uploads now require the worker to be running. In product terms
  this is not new — quotes already require the worker for slicing — but the
  ticket UI should show an honest "waiting for the processor" state, and the
  Task 2.1 heartbeat alert covers the operator side.
- Optional hardening step (e), later: run the parse inside a short-lived child
  process within the worker container so a parser crash/OOM is contained —
  a cheap step toward the "dedicated ingest service" end-state; not required
  for v1.

**Order of work:** (a) worker consumer + grants → (b) ticket endpoint →
(c) client states (`queued`/`processing` in `quote-store.ts`, dropzone UI) →
(d) integration tests on the 0.2 rig (enqueue two uploads, assert FIFO order,
position reporting, session-limit enforcement inside the consumer, temp-file
cleanup on both success and failure) + docs. Do this only after 0.2/0.3 and
cutover (1.1) — it is the largest change in the plan and deserves the net.

## 7. Audit verification record

- 2026-07-13 — audit performed; suite **not** run in the audit environment
  (Node 20 + broken corepack; repo requires Node ≥ 24). CI attests green
  typecheck/test/build + `pnpm audit` (0 vulns) on Node 24 the same day
  (`.github/workflows/security.yml`, `docs/HARDENING.md`).
- 2026-07-13 — Task 0.5 re-verification completed on Node **v24.18.0**
  with pnpm **11.12.0**. Frozen install, workspace typecheck, **110 tests**,
  production build, and `pnpm audit --audit-level low` all passed; the audit
  reported no known vulnerabilities.
