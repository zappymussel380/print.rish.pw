# Deployment

Production is a Docker Compose stack behind one public reverse proxy. The edge
terminates TLS and reaches compose port 8080 only over a private/LAN/Tailscale
route.

```text
Internet -> public reverse proxy (TLS) -> private route -> compose nginx:8080 -> web
                                                        -> internal Postgres/Redis/worker
```

## 1. Prerequisites

- Docker Engine and Docker Compose v2
- This repository checked out
- DNS pointing at the public reverse proxy
- A valid TLS certificate at that proxy
- Encrypted off-host backup storage

Node is not required on the production host unless generating the admin hash
outside a container. Development/tooling requires Node.js 24 or newer.

## 2. Configure secrets

```bash
cp .env.example .env
chmod 0600 .env
```

Generate independent random values. Do not reuse passwords:

```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # Postgres owner password
openssl rand -hex 32   # web database password
openssl rand -hex 32   # worker database password
openssl rand -hex 32   # Redis password
pnpm --filter @print/web hash-password
```

The password helper prompts on the terminal (at least 12 characters, at most 72
UTF-8 bytes), so plaintext is not exposed in shell history or process listings.
Double every `$` in the resulting bcrypt hash to `$$` in Compose `.env`.

Set three distinct database URLs targeting the same database:

```dotenv
POSTGRES_USER=print_owner
POSTGRES_PASSWORD=<owner-password>
POSTGRES_DB=print
MIGRATION_DATABASE_URL=postgresql://print_owner:<owner-password>@postgres:5432/print
DATABASE_URL=postgresql://print_web:<web-password>@postgres:5432/print
WORKER_DATABASE_URL=postgresql://print_worker:<worker-password>@postgres:5432/print
```

Percent-encode URL passwords when necessary. The short-lived migration service
uses the owner URL, creates/rotates the runtime roles, revokes public access,
and reapplies explicit grants. Web and worker receive only their own runtime
role.

For an existing Postgres volume, keep its original `POSTGRES_USER` as the owner
and use that role in `MIGRATION_DATABASE_URL`; changing the environment value
does not rename an already-created database role. Choose two new runtime role
names/URLs. The next migration run provisions them before the app starts.

Also set:

- `APP_ORIGIN=https://print.rish.pw`
- `PROXY_BIND` to the private host address reached by the edge, never
  `0.0.0.0`
- `TRUSTED_PROXY_CIDR` to the exact source host seen from the edge: one IPv4
  address (no prefix or `/32`) or unbracketed IPv6 address (no prefix or `/128`)
- optional provider/business values documented in [ENV.md](ENV.md)

## 3. Build, migrate, and start

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs migrate
```

Compose fails interpolation when `TRUSTED_PROXY_CIDR` is empty. The proxy then
validates it again before nginx template expansion and refuses broad prefixes,
hostnames, lists, malformed addresses, and configuration metacharacters.

The one-shot `migrate` service must exit with status 0 before web or worker can
start. It applies Prisma migrations and least-privilege grants. To deliberately
rerun it after a grant/credential change:

```bash
docker compose run --rm migrate
docker compose up -d web worker
```

The worker image is large because it includes OrcaSlicer. For encrypted
bind-mounted storage, include `docker-compose.vault.yml` as described in
[STORAGE_VAULT_LXC.md](STORAGE_VAULT_LXC.md).

Check service health from inside the compose proxy, where the published-port
transport allowlist does not apply:

```bash
docker compose exec -T proxy wget -qO- http://web:3000/api/health
```

After the outer edge is configured, also verify the complete trusted path with
`curl --fail --silent --show-error https://print.rish.pw/api/health`. A host-side
curl to the private bind may correctly receive 403 because compose nginx accepts
HTTP only from `TRUSTED_PROXY_CIDR`.

## 4. Public reverse proxy

There must be only one public ingress. Firewall compose port 8080 so only that
exact proxy host can reach it. The outer edge must redirect HTTP, terminate TLS,
**overwrite** (not append or preserve) `X-Real-IP` and `X-Forwarded-For` with the
TCP client's address, set the original scheme, omit query strings and referrers
from logs, and grant the large body allowance only to the exact upload endpoint.
The compose proxy independently overwrites both IP headers before they reach the
application and returns 403 to any transport peer other than the configured
outer edge host. The firewall remains mandatory as the first boundary.

### Plain nginx example

```nginx
log_format print_no_args '$remote_addr - $remote_user [$time_local] '
                         '"$request_method $uri $server_protocol" $status $body_bytes_sent '
                         '"-" "$http_user_agent"';

server {
    listen 80;
    server_name print.rish.pw;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name print.rish.pw;
    # ssl_certificate / ssl_certificate_key managed by your ACME client

    access_log /var/log/nginx/print.access.log print_no_args;
    # Routine nginx errors can include the full request target/query. Preserve
    # only critical events; use service health and application logs for diagnosis.
    error_log /var/log/nginx/print.error.log crit;
    add_header Strict-Transport-Security "max-age=31536000" always;
    server_tokens off;

    # Small by default. Upload is the sole exception below.
    client_max_body_size 64k;
    client_body_timeout 15s;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    location = /api/uploads {
        client_max_body_size 301m;
        client_body_timeout 120s;
        proxy_request_buffering off;
        proxy_pass http://<PROXY_BIND_ADDRESS>:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
    }

    location / {
        proxy_pass http://<PROXY_BIND_ADDRESS>:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
    }
}
```

Using `$uri` rather than `$request_uri` prevents customer search values and
other sensitive query data from entering access logs. Do not add
`$http_referer` to this vhost's log format. Nginx error messages can contain
the complete request target, so the example records only `crit` and higher;
this trades routine proxy warnings for
query privacy. Use web logs, edge health, and `docker compose ps` for ordinary
diagnosis. Keep the 301 MiB streaming exception exact; granting it to `/` lets
small JSON endpoints become buffering/slow-body targets at the edge.

### Nginx Proxy Manager

- Enable Let's Encrypt, Force SSL, HTTP/2, HSTS, and Block Common Exploits.
- Set the default advanced body limit to `64k` and body timeout to `15s`.
- Add an exact custom location `/api/uploads` with `client_max_body_size 301m`,
  `client_body_timeout 120s`, and `proxy_request_buffering off`.
- Configure an access log that excludes query strings and referrers, or disable
  access logging for this host if NPM cannot provide a safe format.
- Suppress request-level error logging (retain only critical events) if NPM's
  error format includes full request targets. This reduces proxy diagnostics but
  prevents legacy query capabilities or PII entering error logs.
- Confirm NPM's generated location overwrites both `X-Real-IP` and
  `X-Forwarded-For` with `$remote_addr`; it must not pass a browser-supplied
  forwarding chain through unchanged.
- Set `TRUSTED_PROXY_CIDR` and the port-8080 firewall allowlist to the one NPM
  source host as observed by the compose proxy.

### Verify the proxy trust cutover

Perform this before opening production traffic:

1. Firewall port 8080 to the expected outer edge source first. Do not temporarily
   expose it publicly to discover the source address. Set the expected exact host
   in `TRUSTED_PROXY_CIDR`; if NAT makes it uncertain, use a deliberately
   nonmatching host such as `127.0.0.1` for this short discovery window.
2. Send a request with a unique path through the outer edge. A wrong provisional
   value safely returns 403 but still writes an access entry. Inspect
   `docker compose logs proxy`: each line records `peer=<transport>` and
   `client=<adopted browser>`, without query strings or referrers. Set
   `TRUSTED_PROXY_CIDR` to that exact `peer` host and recreate the proxy with
   `docker compose up -d --force-recreate proxy`.
3. Request through the edge from two known client networks. Their log entries
   must have the same expected `peer` but distinct, correct `client` addresses.
   If `peer` and `client` remain identical, the trusted host is wrong or the
   outer edge did not overwrite `X-Real-IP`.
4. From the trusted edge host only, make a direct probe to port 8080 with a
   reserved test address such as `X-Real-IP: 192.0.2.123`; the compose log should
   show the edge as `peer` and the marker as `client`. Then confirm a non-edge
   host cannot connect to port 8080 at all. If a controlled firewall test does
   let that host connect, compose nginx must return 403 without proxying it.

Trust a NAT/subnet-router address only when the firewall guarantees that other
clients sharing that source cannot reach port 8080. The validator intentionally
does not permit trusting an entire Docker, LAN, or tailnet subnet.

For local-only routing use a separate LAN name or split DNS. Do not create a
second publicly reachable path to port 8080.

## 5. Operations

```bash
docker compose logs -f web worker
docker compose restart web
docker compose pull
docker compose up -d --build
```

Review migration SQL, image-digest updates, CI scans, backups, and the Orca
smoke gate before deploying. See [MAINTENANCE.md](MAINTENANCE.md) and
[SECURITY.md](SECURITY.md).

Only compose nginx publishes a port. PostgreSQL and authenticated Redis remain
on the internal backend network; the worker has no edge-network attachment.
