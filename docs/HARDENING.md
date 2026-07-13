# Hardening review and remediation

Claude's independent review was assessed and implemented on **2026-07-13**.
The scope covered web/API routes, quote-to-checkout integrity, model parsers,
the queue/worker boundary, native OrcaSlicer, storage, database roles,
containers, Compose, nginx, and deployment guidance. This is a point-in-time
review, not a claim that the service can never contain a vulnerability.

## Outcome

The original review found no direct price-manipulation, injection, IDOR, path
traversal, SSRF, XXE, deserialization, or authentication bypass. The main
finding was valid: fair per-client rate limiting depends on correct attribution
by the outer and compose proxies. Two corrections were important:

- Checking that `X-Real-IP` is syntactically an IP is useful key hygiene, but it
  does not establish provenance. A broad trust range still lets a reachable
  caller rotate valid addresses, while a wrong range still collapses visitors
  onto one valid proxy address.
- The local-header/central-directory difference between the JavaScript ZIP
  reader and Orca was a real semantic-integrity ambiguity. It was not safe to
  assume that both readers would necessarily slice the geometry the web tier
  inspected.

Both issues are now closed with enforcement outside the original proposal.

## Implemented remediations

| Finding | Resolution |
| --- | --- |
| Proxy trust could be broad, wrong, or omitted | `TRUSTED_PROXY_CIDR` is now required. Startup accepts exactly one IPv4 host (`/32` optional) or IPv6 host (`/128` optional), rejects subnets/malformed/config syntax, and nginx returns 403 to every other transport peer. The host firewall is still mandatory. |
| The outer edge could preserve forged forwarding headers | Deployment guidance and examples require the edge to overwrite `X-Real-IP` and `X-Forwarded-For`. Compose nginx overwrites them again, records safe `peer=`/`client=` fields, and forwards the original peer separately for diagnostics. |
| App accepted arbitrary rate-limit key text | `clientIp()` accepts only a valid proxy-written `X-Real-IP`, canonicalizes IPv6, rejects zones/lists/ports/garbage, ignores `X-Forwarded-For`, and otherwise uses the fail-closed `unknown` bucket. This is hygiene, not a substitute for proxy trust. |
| Admin brute-force control depended on per-IP fairness | Syntactically valid failed password checks also consume one IP-independent administrator-account budget (25 failures/15 minutes). Malformed/oversized inputs are rejected before this budget; bcrypt checks are admitted through a five-second cross-replica Redis lease, and successful and lock-busy attempts are refunded. |
| Web validation and Orca could interpret archive entries differently | The bounded application parser selects geometry from every 3MF and zipped AMF and serializes that triangle stream to binary STL. The selected triangle stream drives the upload preview, while the serialized STL is hashed, queued, and supplied to Orca, so Orca never receives the original attacker-controlled ZIP namespace. Tests use archives whose local and central filenames deliberately disagree. 3MF/AMF units are normalized to millimetres before serialization; downstream STL interpretation remains a separate parser boundary. |
| Terminal quotation status could be reopened by concurrent stale writes | Status transitions now conditionally claim the exact observed state in a transaction; history is written only for the winning transition. |
| Concurrent slice repair/retry could overwrite terminal work | A failed retry conditionally claims the exact prior attempt and creates a fresh attempt UUID/job ID. Worker claims, progress, result, completion, and asynchronous-failure writes must match that generation and a live DB status. Missing/non-live job repair rechecks authoritative status and generation before queue mutation. |
| Datastore root filesystems did not match the documented container posture | PostgreSQL and Redis now use read-only root filesystems, explicit writable volume/tmpfs mounts, `no-new-privileges`, and tested capability allowlists. |
| Runtime Node images contained vulnerable, unused package-manager tooling | The pinned package manager was upgraded from pnpm 9 to pnpm 11.12.0, newly published dependencies have a 24-hour review delay, and npm/Corepack/pnpm are removed from final web/worker images. |
| The public web image inherited migration-only psql and its larger OS dependency tree | The Dockerfile now emits separate `runner` and `migrate` targets. Only the short-lived, internal migration target contains psql and receives the schema-owner URL. Web health uses Node directly instead of wget. |
| Orca's AppImage bundled a vulnerable Swiper copy in GUI-only help pages | The headless worker build removes both unused Swiper directories after verifying/extracting the pinned AppImage; the slicing CLI is smoke-tested afterward. |
| Proxy error logs could include full request targets | Routine nginx error logging is suppressed (`crit` only); access logs omit query strings and referrers. This trades some proxy diagnostics for capability/PII privacy. |

Archive normalization intentionally means the original 3MF/zipped-AMF package,
textures, and unrelated project metadata are not retained for download. Only
the geometry and source print fields understood by the bounded parser are kept;
administrators receive the canonical STL, not an archival source project.

## Quotation-integrity verification

- The merchandise total is
  `sum(round(slicerGrams * quantity * sellPerGramPaise)) + setupFee`.
  A validated signed shipping amount is added separately when selected.
- Of the long-running application roles, only the worker can populate bounded
  slice weight/time/raw-metadata columns; column-scoped database grants enforce
  that boundary against the web role. The short-lived schema owner remains
  privileged. The worker reloads authoritative model/hash/settings rows before
  slicing, verifies the staged bytes against the recorded hash, and fences each
  result commit on the live attempt generation and status.
- Checkout rebuilds every line from session-owned database rows and looks up a
  result by canonical file hash plus normalized settings key. Client totals are
  ignored; quantity and configuration are schema-bounded; models are atomically
  single-use.
- Multi-plate 3MF support mode is retained and locked per extracted plate.
  Other supported 3MF source settings are imported as defaults, not all treated
  as immutable.
- Shipping tokens are purpose/issuer/audience/algorithm pinned, short-lived,
  and bound to destination, billed weight, declared value, and amount.

## Verification performed

- Focused adversarial tests for proxy trust, forged headers, client-IP
  normalization, global login limits, archive divergence, canonical
  persistence, status races, and slice retry/repair races.
- Full workspace tests, typechecks, and production build.
- Frozen pnpm 11 install and `pnpm audit --audit-level low`.
- Trivy dependency/configuration/secret scanning found no actionable
  HIGH/CRITICAL source findings. Final image scans found no fix-available
  HIGH/CRITICAL findings; the worker also had zero when unfixed advisories were
  included. The all-advisory scan still reported 19 HIGH/CRITICAL Debian records
  in the public runner and 35 in the migration image marked unfixed, deferred,
  or will-not-fix. Those residual base-image records are tracked rather than
  represented as a clean scan.
- Nginx IPv4/IPv6 syntax and trusted/untrusted peer integration tests.
- Fresh PostgreSQL write and Redis persistence tests with the new read-only
  root/capability profiles.
- Worker final-image smoke checks verified package-manager removal, the
  generated Prisma engine, and headless Orca startup after GUI-only assets were
  pruned.

## Remaining risks and recommendations

- Deployment must still identify the actual transport peer, firewall port 8080
  to that exact source, and prove the outer edge overwrites inbound headers.
  Follow the staged checks in [DEPLOYMENT.md](DEPLOYMENT.md). If the observed
  peer is shared NAT/subnet-router infrastructure, use a dedicated path or
  authenticated proxy link (for example mTLS) rather than trusting unrelated
  callers behind that source.
- `/api/health` remains publicly reachable and discloses only DB/Redis up/down
  booleans. Keep it for monitoring or restrict it at the outer edge if that
  small disclosure is unnecessary.
- Admin authentication remains one static password and 12-hour non-revocable
  JWTs. The new global failure cap bounds guesses but can itself be exhausted to
  delay an administrator. MFA or an external identity provider is the next
  meaningful improvement.
- Geometry inspection is bounded and normally serialized, but its Redis lease
  is non-renewing and provides no fencing after expiry. Per-session upload
  finalization uses the same advisory pattern. Move parsing to a dedicated
  no-network ingest service/VM for stronger availability and parser isolation;
  use renewable fenced or database advisory locks where strict serialization
  is required.
- Orca remains native code sharing the worker kernel. A disposable VM per job
  is the stronger boundary; CPU/RAM/PID ceilings are aggregate container limits,
  not per-slicer quotas. Continue manual review of high-value/outlier quotes.
- Establish a maximum retention/deletion policy for quotation PII and PDFs,
  review third-party data handling, and test encrypted off-host restores.
- Keep weekly source and runtime-image scans, including unfixed findings rather
  than only the fix-available CI gate. Advisory databases and pinned artifacts
  can become stale between checks; refresh the pinned Debian base as fixes land.
- Dependency lifecycle scripts are name-allowlisted but still execute build
  code. Keep production secrets out of install/build environments and review
  any allowlist or release-age exception as a privileged supply-chain change.
