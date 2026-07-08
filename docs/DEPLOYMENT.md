# Deployment

Production runs as a Docker Compose stack on a homelab host. A public reverse
proxy terminates TLS for `print.rish.pw` and reverse-proxies to the compose
stack over a private route.

```
Internet -> public reverse proxy (TLS, print.rish.pw) -> private route -> homelab:8080 (compose proxy) -> web
```

## 1. Prerequisites on the host

- Docker + Docker Compose v2
- This repository checked out
- DNS A/AAAA for `print.rish.pw` pointing at the public reverse proxy
- A TLS cert on the public reverse proxy

## 2. Configure `.env`

```bash
cp .env.example .env
```

Fill in **all** secrets:

- `SESSION_SECRET` — `openssl rand -hex 32`
- `POSTGRES_PASSWORD` — a long random string (also update `DATABASE_URL`)
- `ADMIN_PASSWORD_HASH` — `pnpm --filter @print/web hash-password '<password>'`
  - ⚠️ **Docker Compose interpolates `.env`.** bcrypt hashes contain `$`, so
    **double every `$` to `$$`** in this file (e.g. `$2a$12$…` → `$$2a$$12$$…`).
    The container receives the correct single-`$` value.
- `WHATSAPP_NUMBER` — international format, digits only (e.g. `919876543210`)
- `APP_ORIGIN` — `https://print.rish.pw`
- `PROXY_BIND` — the homelab host address the public reverse proxy can reach
  (for example the host's Tailscale IP, or the service LXC's LAN IP). The
  compose proxy publishes port 8080 on this address only; it defaults to
  `127.0.0.1` (loopback), which is safe but unreachable remotely. Never use
  `0.0.0.0` - the stack must not be exposed on every interface.
- `TRUSTED_PROXY_CIDR` — the source address the reverse proxy's traffic arrives
  from (for example the VPS tailnet IP, subnet-router address, or Nginx Proxy
  Manager LXC IP). The compose proxy adopts the proxy-set `X-Real-IP` only from
  this source, so
  rate limiting keys on real browser IPs instead of lumping every visitor into
  the forwarder's bucket. Defaults to `127.0.0.1` (trust nobody).

See [ENV.md](ENV.md) for the full list.

## 3. Build and start

```bash
docker compose up -d --build
```

This builds the web and worker images (the worker image is large — it bundles
OrcaSlicer + webkit, ~1.5–2 GB — and the first build downloads the AppImage).
On start-up the web container runs `prisma migrate deploy` automatically.

Check health:

```bash
docker compose ps
# Use the address you set as PROXY_BIND (localhost if you kept the default).
curl -s http://${PROXY_BIND:-localhost}:8080/api/health   # {"ok":true,"db":true,"redis":true}
```

## 4. Public Reverse Proxy

Use exactly one public reverse proxy path. If Nginx Proxy Manager is only a
local convenience proxy for LAN IP-to-name routing, keep `print.rish.pw` on the
VPS nginx path and do not move production ingress to NPM. Put `print.rish.pw`
in NPM only if that NPM LXC is intentionally promoted to the public ingress, or
if the VPS is only tunneling traffic to NPM.

### Plain nginx server block

Add a server block that proxies to the host address from `PROXY_BIND`:

```nginx
server {
    server_name print.rish.pw;
    listen 443 ssl;
    # ssl_certificate / ssl_certificate_key managed by certbot

    # MUST match the compose proxy — a smaller value silently breaks 100 MB uploads.
    client_max_body_size 110m;
    proxy_read_timeout 120s;

    location / {
        proxy_pass http://<PROXY_BIND_ADDRESS>:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> **`client_max_body_size 110m` is the single most common deployment mistake.**
> It must be set on **both** the public reverse proxy and the compose proxy
> (already done in `docker/proxy/nginx.conf`). If the public proxy value is
> smaller, large uploads fail with an opaque 413 before ever reaching the app.

### Nginx Proxy Manager as Public Ingress

Create a Proxy Host:

- Domain Names: `print.rish.pw`
- Scheme: `http`
- Forward Hostname / IP: the `PROXY_BIND` address, for example `192.168.1.7`
- Forward Port: `8080`
- Enable SSL with Let's Encrypt, Force SSL, and HTTP/2
- Keep "Block Common Exploits" enabled

In the NPM Advanced field, add:

```nginx
client_max_body_size 110m;
proxy_read_timeout 120s;
proxy_send_timeout 120s;
```

Then set `TRUSTED_PROXY_CIDR` to the NPM LXC address as seen by the print LXC,
and update the host firewall allowlist for port 8080 to that same source.

For local-only NPM routing, use a separate LAN name such as
`print.home.arpa`/`print.lan`, or a split-DNS override for `print.rish.pw` only
inside your LAN. If local NPM proxies directly to port 8080, also add the NPM
LXC IP to the port-8080 firewall allowlist; otherwise local users can simply use
the public `https://print.rish.pw` path through the VPS and no firewall change is
needed.

The compose proxy sets `X-Real-IP`/`X-Forwarded-For`; rate limiting keys off the
client IP the public reverse proxy forwards. The compose proxy is the trust
boundary - do not expose port 8080 to the public internet. The compose file
helps enforce this: port 8080 binds to `PROXY_BIND` (default `127.0.0.1`) - see
step 2.

## 5. Operating

```bash
docker compose logs -f web worker      # tail logs
docker compose restart web             # restart a service
docker compose pull && docker compose up -d --build   # update
```

Backups, retention and Orca upgrades are covered in [MAINTENANCE.md](MAINTENANCE.md).

## Notes

- `DEPLOYMENT.md` in the **repository root** (not this file) holds host-specific
  secrets/topology and is git-ignored — never commit those details.
- Only the compose `proxy` publishes a port. `postgres`, `redis`, `web` and
  `worker` are reachable only on the internal compose network.
