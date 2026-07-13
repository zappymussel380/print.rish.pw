# Proxy trust cutover verification — Task 1.1 evidence

Date: **2026-07-13** (probes run 08:06–10:06 UTC)
Deployed commit: `ac7d36c9b98f8275116f1ddb3a7bd37e5ec7fbe3`
Verified on the production host by the operator (assisted).

This records the evidence requested by `docs/AUDIT.md` Task 1.1, following
`docs/DEPLOYMENT.md` §"Verify the proxy trust cutover". **All four checks
pass.** This public copy masks concrete addresses, hostnames, and paths; the
unredacted record (raw log lines and exact values) is retained off-repo on the
production host.

## Deployment record

The stack had been running images built before the hardening commits
(`7abb6b9`, `017c855`, both 2026-07-13). Before evidence could be collected,
the current code was deployed:

- Database backed up first (custom-format `pg_dump` via the atomic-rename
  procedure from MAINTENANCE.md) to a root-only directory outside the repo.
- Images rebuilt from commit `ac7d36c` and deployed via `docker compose up -d`.
- Migrations applied by the one-shot migrate service (now 8 total in
  `_prisma_migrations`): `add_slice_progress`, `secure_quotation_access`,
  `single_use_models`, `add_slice_attempt_generation`.
- Least-privilege role split provisioned: `pg_roles` now contains the owner
  role (migrate-only) plus `print_web` and `print_worker`; the env file
  carries the three split URLs (`MIGRATION_DATABASE_URL`, `DATABASE_URL`,
  `WORKER_DATABASE_URL`).
- The owner password was rotated to a 48-char random value (the provisioning
  script rejects passwords under 32 bytes; the pre-existing password was
  shorter). Rotation executed by the operator via a reviewed script.
- Post-deploy: all five containers healthy; `/`, `/quote`, `/contact` return
  200 through the public edge.

## Check 1 — exact trusted proxy, firewalled port

- `TRUSTED_PROXY_CIDR` is set to a single exact host address (the relay that
  carries VPS edge traffic; no prefix). Value redacted here; recorded in the
  host env file.
- Host firewall (DOCKER-USER chain): port 8080 is allowed from that same
  single host and **dropped for all other sources**; the INPUT chain carries
  the same pair. Rule counters show the allow rule passing traffic.
- Discovery was not needed: the pinned address matches the transport peer the
  proxy observes (see check 3).

## Check 2 — edge overwrites forwarding headers

Probe sent through the public edge with a forged header:

```
curl https://print.rish.pw/api/health -H "X-Real-IP: 192.0.2.99"   → 200
```

The proxy log recorded the prober's true egress IP (verified match with the
probing connection), not the marker:

```
peer=<trusted-relay> client=<prober-real-ip> … "GET /api/health HTTP/1.0" 200   [13/Jul/2026:10:05:34 +0000]
```

`192.0.2.99` appears nowhere in proxy or web logs (grep count 0). The edge
overwrote `X-Real-IP` as required. (App-side, `clientIp()` additionally
ignores `X-Forwarded-For` entirely and validates `X-Real-IP` shape.)

## Check 3 — distinct real client IPs end to end

Log entries share the same trusted `peer` while carrying distinct, correct
`client` addresses (new `peer=`/`client=` log format): the controlled probe
above plus organic internet traffic on 2026-07-13 from five-plus distinct
public client addresses across different networks (values redacted). Per-client
rate-limit keying is real, not collapsed into a shared bucket.

## Check 4 — direct probe to 8080 refused

From an on-host, non-relay source (outside the trusted host):

```
curl http://<app-host>:8080/api/health -H "X-Real-IP: 192.0.2.55"   → 403
```

```
peer=<app-host> client=<app-host> … "GET /api/health HTTP/1.1" 403   [13/Jul/2026:10:05:33 +0000]
```

The compose nginx refused to proxy for an untrusted transport peer (this
returned 200 on the pre-hardening image — the backstop is a property of
today's deploy), and the forged header was not adopted (`client` stayed the
peer address). Off-host sources cannot reach 8080 at all (firewall drop,
check 1); this on-host probe exercises the nginx backstop behind it.

## Residual notes

- The X-Real-IP marker probe "from the trusted edge host" (DEPLOYMENT.md
  step 4, first half) was intentionally replaced by the stronger end-to-end
  forged-header probe in check 2: it proves overwrite behaviour through the
  real edge path rather than simulating it.
- A pre-rotation copy of the env file is retained off-repo (root-only mode;
  the secrets it contains are now invalid).
