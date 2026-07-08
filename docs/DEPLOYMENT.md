# Deployment

Production runs as a Docker Compose stack on a homelab host. The VPS-host
nginx terminates TLS for `print.rish.pw` and reverse-proxies to the compose
stack over Tailscale.

```
Internet ──▶ VPS nginx (TLS, print.rish.pw) ──Tailscale──▶ homelab:8080 (compose proxy) ──▶ web
```

## 1. Prerequisites on the host

- Docker + Docker Compose v2
- This repository checked out
- DNS A/AAAA for `print.rish.pw` → the VPS
- A TLS cert on the VPS (certbot)

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
- `PROXY_BIND` — the homelab host's **Tailscale IP** (e.g. `100.x.y.z`). The compose
  proxy publishes port 8080 on this address only; it defaults to `127.0.0.1`
  (loopback), which is safe but unreachable from the VPS. Never use `0.0.0.0` —
  the stack must not be exposed on public interfaces.

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

## 4. The VPS nginx server block (lives OUTSIDE this repo)

Add a server block on the VPS host that proxies to the homelab host's tailnet IP:

```nginx
server {
    server_name print.rish.pw;
    listen 443 ssl;
    # ssl_certificate / ssl_certificate_key managed by certbot

    # MUST match the compose proxy — a smaller value silently breaks 100 MB uploads.
    client_max_body_size 110m;
    proxy_read_timeout 120s;

    location / {
        proxy_pass http://<HOMELAB_TAILNET_IP>:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> **`client_max_body_size 110m` is the single most common deployment mistake.**
> It must be set on **both** the VPS nginx and the compose proxy (already done in
> `docker/proxy/nginx.conf`). If the VPS value is smaller, large uploads fail
> with an opaque 413 before ever reaching the app.

The compose proxy sets `X-Real-IP`/`X-Forwarded-For`; rate limiting keys off the
client IP the VPS forwards. The compose proxy is the trust boundary — do not
expose port 8080 to the public internet, only to the tailnet. The compose file
enforces this: port 8080 binds to `PROXY_BIND` (default `127.0.0.1`), which
production sets to the tailnet IP — see step 2.

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
