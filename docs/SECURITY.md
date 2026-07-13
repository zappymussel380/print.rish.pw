# Security review

Last reviewed: **2026-07-13**. The review covered the web/API routes, session and
quotation access controls, geometry parsers, queue/worker boundary, native
OrcaSlicer execution, storage/retention, database schema, dependencies,
containers, Compose, nginx, and deployment documentation.

Security is a moving target. The controls below reduce identified risk; they do
not make uploaded models or the service intrinsically safe.

## Threat model

Model uploads, filenames, multipart framing, JSON bodies, quote fields, slice
settings, request timing, and bearer capabilities are attacker-controlled.
Valid STL, 3MF, OBJ, and AMF files can target CPU, RAM, disk, archive/XML
parsers, native OrcaSlicer, and an administrator's desktop tools. Anonymous
clients may distribute traffic across IP addresses. A compromised native
slicer is assumed able to control all of its output.

The public reverse proxy, host/LXC, trusted Node orchestrator, PostgreSQL, Redis,
and secret store are trusted. OrcaSlicer is not a security boundary.

## Implemented controls

| Area | Controls |
| --- | --- |
| Requests and CSRF | Mutations require same-origin Fetch Metadata or an exact `Origin`. JSON is streamed through route-specific byte ceilings even without `Content-Length`; nginx defaults non-upload bodies to 64 KiB. Redis rate-limit updates are atomic and rejected floods do not grow sorted sets. |
| Sessions and admin | HS256 JWT verification pins issuer, audience, algorithm, and purpose. Production cookies are `Secure`, `HttpOnly`, `SameSite=Strict`, and `__Host-` prefixed. Authenticated admin APIs repeat authorization in the handler; login bcrypt work is admitted through a short cross-replica Redis lease, limited per IP, and capped by an IP-independent failed-password budget. Security-critical production environment values fail closed at startup. |
| Quotation access | New 256-bit capabilities are stored only as SHA-256 verifiers and expire after 30 days. The browser transports the initial token in a URL fragment, redeems it through a same-origin rate-limited POST, clears the fragment, and uses a per-quotation `HttpOnly` cookie. Confirmation/PDF responses are private, `no-store`, `no-referrer`, and `noindex`. A query-token compatibility path remains for migrated links; new links never use it. |
| Upload storage | One file is streamed to an exclusively created private `0600` temporary file and parsed. Original STL/OBJ/raw-AMF files are atomically renamed to an unpredictable server-generated UUID path; that rename is not itself an exclusive-create primitive. Every 3MF and zipped AMF is instead persisted as canonical binary STL using exclusive creation. Reads derive the expected UUID path, refuse symlinks, require regular files, and check size. Controls include hard file/session/model limits, per-IP byte budgets, worst-case archive-expansion capacity reservations, and a final free-space recheck preserving a 2 GiB reserve by default. |
| Geometry parsing | Text models are limited to 32 MiB, XML to 8 MiB, one million vertices, four million triangles, 100,000 XML elements, depth 128, 1,024 ZIP entries, 64 MiB total relevant extraction, 20 plates, and bounded 3MF component expansion. DTDs, duplicate relevant 3MF entries, oversized tags/settings, invalid consumed indices, unknown units, and decompression overruns are rejected. App-selected archive geometry is normalized to millimetres and binary STL, so the original attacker-controlled ZIP namespace never reaches Orca; downstream STL parsing is still a separate parser boundary. A non-renewing Redis lease normally admits one in-process geometry inspection across replicas, but it is not a fencing guarantee if work outlives the lease. |
| Slice cache and queue | Persistent identities include pipeline/profile version, stored model format, canonical file hash, and canonical slice settings, preventing cross-format/polyglot or stale-profile reuse. Each retry receives a fresh attempt UUID and BullMQ job ID. Claims, progress, results, completions, and asynchronous failure events conditionally match that attempt and a live DB status; live-job repair also rechecks authoritative state, so stale work cannot reopen or overwrite terminal/newer work. The worker reloads authoritative rows and verifies job UUIDs, model/hash/settings/result binding before use. |
| Native slicer | Every job receives a size/hash-verified private copy and distinct UID/GID. Orca runs with a minimal explicit credential-free environment, no capabilities, `no-new-privileges`, no internet route, a per-job timeout, and escaped-process reaping by UID. CPU, RAM, and PID limits are aggregate worker-container limits shared by concurrent slicers, not per-Orca resource quotas. Trusted reads reject symlinks and bound result JSON, output archive, metadata, strings, and numeric statistics. A reaping failure terminates the worker before a UID can be reused. |
| Checkout, retention, and cleanup | Checkout atomically marks each model single-use; per-IP limits plus a 200/day global circuit breaker bound permanent rows/PDFs/notifications. PDFs are capped at 20 MiB and use a short Redis lease around the final free-space check and exclusive write. Terminal quotation states are immutable through conditional state transitions, allowing cleanup to establish a stable lifetime boundary. Paginated cleanup handles unattached uploads and old terminal quotations and reconciles orphaned derived files using server-derived paths. |
| Database and Redis | PostgreSQL and authenticated Redis are internal-only. A short-lived migration service holds the schema-owner credential. It provisions distinct web and worker roles, removes public database/schema creation, and reapplies explicit grants; the web role has column-scoped `SliceResult` lifecycle/identity writes and cannot write slicer measurements or raw metadata, which remain worker-only. Long-running services never receive the owner URL. Prisma production query logging is disabled. |
| Browser and proxy | Per-request nonces protect scripts; CSP also denies objects, framing, foreign forms, and foreign connections. Only styles retain `unsafe-inline`. HSTS is emitted for HTTPS deployments. Startup requires one exact trusted proxy host and rejects subnets/config syntax; untrusted peers receive 403. Forwarding headers are overwritten, IP keys are parsed/canonicalized, access logs omit args/referrers, and routine nginx error logs are suppressed because they can include full targets. |
| Containers and supply chain | Runtime filesystems are read-only apart from explicit volumes/tmpfs; ports, PIDs, memory, CPU, capabilities, and networks are constrained. The public web target excludes psql/owner credentials; those exist only in the one-shot migrate target. Final images remove package-manager tooling, and the worker prunes a vulnerable GUI-only Swiper bundle unused by headless slicing. Images/Orca are pinned; pnpm 11 has a 24-hour release delay; CI runs locked verification, CodeQL, and Trivy source scanning. |

On 2026-07-13, a full `pnpm audit` reported **0 known vulnerabilities** across
production and development dependencies. That is a dated observation, not a
guarantee; CI and update automation are the ongoing controls.

## Residual risks

- Geometry inspection is bounded and normally serialized by a five-minute,
  non-renewing Redis lease, but still executes synchronously in a web process.
  Lease expiry does not fence an old holder, so exceptionally long work can
  overlap; the similar per-session upload-finalization lease is also advisory
  rather than a database quota constraint. A worst-case valid model can block
  that replica's Node event loop or exhaust its 2 GiB container. Renewable
  fenced locks or database advisory locks would make concurrency strict; a
  dedicated no-network ingest service or VM is the stronger isolation boundary.
- The bcrypt and PDF-write critical sections use the same non-renewing Redis
  lock primitive with shorter leases. Rate limits, exclusive PDF creation, and
  final capacity checks remain independent controls, but a lease is not proof
  that an old holder stopped executing.
- Orca shares the worker container and host kernel. UID/capability/network and
  output controls reduce impact but are weaker than a disposable VM. A
  compromised slicer can also return plausible, in-range but false time/weight
  figures and influence pricing; monitor outliers and manually review valuable
  orders.
- Admin authentication is a single static password without MFA. Admin JWTs live
  for up to 12 hours and have no targeted revocation list; rotate
  `SESSION_SECRET` for emergency global revocation. The global failure budget
  bounds distributed guesses but can be exhausted to delay legitimate login.
- A stolen quotation capability remains usable until its 30-day expiry or the
  quotation is deleted. Hashing protects capabilities at rest, not after
  browser, message, or endpoint compromise.
- Per-IP limits can inconvenience large NATs and can be bypassed by distributed
  clients. Capacity reservations preserve free disk and checkout is globally
  capped, but a botnet can consume allowed storage or exhaust the daily cap to
  deny legitimate submissions. Enforce upstream bot/connection/rate controls
  and alert on usage.
- Client-IP provenance still depends on the outer edge overwriting forwarding
  headers and on its transport source not being shared with unauthorized
  callers. The exact-host validator fails closed, but mTLS or another
  authenticated proxy link is stronger than address-based trust.
- Quotation rows and PDFs contain customer PII and currently have no automatic
  maximum retention. Checkout/contact/shipping workflows intentionally send
  relevant PII to WhatsApp, Telegram, Resend, and Shiprocket when configured.
  Establish a lawful retention/deletion policy and vendor agreements before
  production use.
- Web has broad DML rights over business tables and the worker has selected
  read/update/delete grants. Slice measurement/raw-metadata columns are an
  exception and remain worker-only through column-scoped grants. Separate roles
  remove DDL and unrelated secrets, but PostgreSQL row-level isolation is not
  used.
- CSP still permits inline styles for current React/Next rendering. Script
  execution is nonce protected, but removing `style-src 'unsafe-inline'` would
  further reduce style-injection impact.
- An administrator may download a hostile but valid model. Treat downloads as
  untrusted and inspect/open them only in patched, isolated desktop software.
- Encryption at rest protects powered-off media, not a compromised running
  host. Keep encrypted, immutable/off-host backups with credentials unavailable
  to the application host, and regularly test restores.
- Pinned artifacts and automated scans reduce supply-chain drift, but newly
  disclosed dependency, base-image, kernel, or Orca vulnerabilities remain
  possible between scans and upgrades. The 2026-07-13 all-advisory image scan
  still reported 19 HIGH/CRITICAL Debian records in the public runner and 35 in
  the migration image that Trivy marked unfixed, deferred, or will-not-fix; the
  worker reported none. CI's fix-available gate does not make those residual
  base-image findings disappear, so track them and refresh the pinned base.
- Explicitly approved dependency lifecycle scripts still execute trusted build
  code. Docker excludes `.env` files from build context; likewise, do not run
  package installation with production secrets exposed to the process or
  checked-out worktree.

## Operational rules

- Never expose PostgreSQL, Redis, or port 8080 to the public internet. Firewall
  8080 to the actual reverse-proxy source, set `TRUSTED_PROXY_CIDR` to that one
  host, and require the outer edge to overwrite both IP forwarding headers.
- Require HTTPS at the public edge, redirect HTTP, emit HSTS there, and omit
  query strings/referrers from every upstream access log.
- Keep `.env` mode `0600`; use independent random secrets/passwords and rotate
  all affected credentials after suspected disclosure.
- Run dependency installation/builds in a clean environment without production
  credentials. Review changes to `allowBuilds`, the lockfile, and any
  minimum-release-age exception as code-execution changes.
- Do not log model contents, bearer capabilities, credentials, or customer
  name/email/phone/notes. Restrict and expire logs and backups as PII.
- Bump `SLICE_PIPELINE_VERSION` whenever Orca or any machine/process/filament
  profile can affect toolpaths. Update the pinned Orca checksum and pass a
  known-model smoke test before deployment.
- Review migration SQL before release, verify the `migrate` service succeeds,
  and never give its owner URL to the web or worker service.
- Test restore procedures; a backup that has not been restored is unverified.
