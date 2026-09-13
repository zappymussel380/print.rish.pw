# Run your own print shop

This site is open source. One command sets up your own copy — your name, your
rates, your materials, your contact details — on a server of your own.

## What you need

- A Linux server with an **Intel/AMD (x86_64)** CPU. ARM servers (Raspberry Pi,
  Oracle Ampere, AWS Graviton) can't run the slicer. Debian or Ubuntu is easiest.
- **8 GB RAM** (4 GB works for small models), **25 GB free disk**, 2+ CPU cores.
- A **domain name** you control, e.g. `print.example.com`. The site only runs
  over HTTPS.
- A **single-nozzle printer with a 0.4 mm nozzle** that OrcaSlicer supports —
  321 of them from 57 brands (Bambu Lab, Prusa, Creality, Voron, Elegoo, Qidi,
  Anycubic, Sovol …). Every quote is sliced with that printer's own profiles.
- The shop is India-focused: prices are in rupees, and live shipping quotes
  use Shiprocket (optional).

Docker is installed for you if it's missing.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/zappymussel380/print.rish.pw/main/install.sh | sudo bash
```

It downloads the code to `/opt/print-shop` (you can pick another folder) and
asks, in plain language:

1. **Your shop:** name, the initials your quotation numbers start with
   (e.g. `AP-2026-0001`), a one-line tagline, and your city.
2. **Your printer:** pick the brand, then the model (with its build volume),
   and say whether it has an AMS/MMU for automatic multicolour.
3. **Web address and HTTPS:** your domain, and how visitors reach the server
   (see [HTTPS options](#https-options)).
4. **Admin password:** for `https://your-domain/admin`.
5. **Materials and rates:** which materials you print (PLA, Aesthetic PLA,
   PLA-CF, PETG, PETG Premium, ABS, ASA), the price per gram of each, and your
   setup fee per order.
6. **Materials page:** which materials `/materials` compares for customers.
7. **Contact details:** WhatsApp (every quote hands off to it), email, phone,
   address, and an optional Google Maps embed.
8. **Optional extras:**
   - contact-form email (Resend)
   - live courier prices (Shiprocket)
   - Telegram alerts for new quotes

Then it builds everything. That takes 10–25 minutes the first time. When it's
done it prints your site and admin addresses.

After that, **the admin dashboard is where you change things**:

- **Catalog:** which colours you have in stock. ABS and ASA start with black and
  white; add any colour by name and hex code.
- **Rates:** per-gram prices, the setup fee, lead time, and your real filament
  and running costs (for profit estimates).
- **Site:** shop name, contact details, footer, and the Materials page.

If the first run is interrupted (for example the build fails on a network
blip), just run the command again: it picks up where it stopped.

## HTTPS options

**1. Public server (recommended).** Your server has a public IP and ports 80
and 443 are free.

- Point your domain's DNS **A record** at the server.
- The installer adds [Caddy](https://caddyserver.com), which gets and renews a
  free Let's Encrypt certificate automatically.

**2. Cloudflare Tunnel.** For a server at home or behind a router, with no port
forwarding. Your domain must use Cloudflare's DNS. In the Cloudflare dashboard:

1. Go to **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**.
2. Copy the token from the command it shows (the long string after `--token`)
   and paste it into the installer.
3. Add a **public hostname**: your domain → service **HTTP**, URL `caddy:80`.

Cloudflare caps uploads at 100 MB, so model uploads are limited to 95 MB in
this mode.

**3. Your own reverse proxy** (nginx, Nginx Proxy Manager, Traefik…). The
installer asks for two addresses:

- the **one** IP your proxy connects from
- the address on this server to listen on for it (never `0.0.0.0`)

Your proxy must:

- terminate HTTPS
- **overwrite** `X-Real-IP` and `X-Forwarded-For` with the visitor's IP
- allow 301 MB request bodies on `/api/uploads`

See the nginx example in [DEPLOYMENT.md](DEPLOYMENT.md#4-public-reverse-proxy).
Firewall port 8080 so only your proxy can reach it.

## Updating

```bash
sudo /opt/print-shop/update.sh
```

It shows what's new and asks before doing anything. Then it:

1. backs up the database (the last 5 backups are kept in `backups/`)
2. keeps the current version's images for rollback
3. pulls the latest code
4. rebuilds, so updated dependencies come in
5. applies database migrations and restarts
6. checks the site is healthy

If the new version doesn't come up, it offers to roll straight back.

| Command | What it does |
| --- | --- |
| `update.sh --yes` | Update without asking. Suitable for a weekly cron job. |
| `update.sh --rebuild` | Rebuild even when there is nothing new. |
| `update.sh --full` | Rebuild without Docker's cache, which also refreshes OS packages. |
| `update.sh --rollback` | Go back to the version before the last update. |

Rolling back puts the old code and images back, but database migrations only
go forward. If the older version misbehaves after a rollback, `update.sh`
prints the command to restore the backup it took just before updating.

Your settings are never touched by an update. They live in `.env` and the
database, not in the code.

## Changing settings or uninstalling

Run the installer again from the install folder:

```bash
sudo /opt/print-shop/install.sh
```

It offers to:

- rebuild and restart
- change the web address or HTTPS setup
- change the admin password
- change the optional extras
- start over with new shop settings
- uninstall

Uninstalling removes the containers. Your data (database, uploaded models,
quotation PDFs) is only deleted if you confirm twice.

## Unattended install

Set `PS_UNATTENDED=1` and answer every question with a variable. With `sudo`,
put the variables after `sudo`, or they are dropped:

```bash
curl -fsSL https://raw.githubusercontent.com/zappymussel380/print.rish.pw/main/install.sh | sudo \
  PS_UNATTENDED=1 PS_DIR=/opt/print-shop \
  PS_BRAND="Acme Prints" PS_CITY=Pune PS_DOMAIN=print.acme.in PS_MODE_CHOICE=1 \
  PS_ADMIN_PASSWORD='a long admin password' PS_MATERIALS=1,4,6 PS_SETUP_FEE=120 \
  PS_RATE_PLA=2 PS_RATE_PETG=2.5 PS_RATE_ABS=3 PS_WHATSAPP=919876543210 bash
```

| Variable | Question |
| --- | --- |
| `PS_DIR`, `PS_BRANCH`, `PS_REPO` | Install folder (`/opt/print-shop`), branch (`main`), repository |
| `PS_BRAND`, `PS_TAGLINE`, `PS_CITY` | Shop name, tagline, city |
| `PS_QUOTE_PREFIX` | Quotation-number initials, 2–5 letters (default: the shop name's initials) |
| `PS_PRINTER` | Printer: the exact OrcaSlicer preset, e.g. `Prusa MK4 0.4 nozzle` (list: `docker/selfhost/printers.tsv`, 3rd column) |
| `PS_CONFIRM_MULTI_MATERIAL` | `y` if the printer has an AMS/MMU for automatic multicolour |
| `PS_DOMAIN` | Domain name |
| `PS_MODE_CHOICE` | `1` Caddy, `2` Cloudflare Tunnel, `3` own proxy |
| `PS_ACME_EMAIL` | Let's Encrypt email (mode 1, optional) |
| `PS_TUNNEL_TOKEN` | Tunnel token (mode 2) |
| `PS_PROXY_IP`, `PS_PROXY_BIND` | Proxy source IP, and the address to listen on (mode 3) |
| `PS_ADMIN_PASSWORD` | Admin password (12–72 characters) |
| `PS_MATERIALS` | Materials offered, by number: 1 PLA, 2 Aesthetic PLA, 3 PLA-CF, 4 PETG, 5 PETG Premium, 6 ABS, 7 ASA |
| `PS_SETUP_FEE`, `PS_RATE_<ID>` | Setup fee and per-gram rate in ₹, e.g. `PS_RATE_PLA_CF=3.5` |
| `PS_MATERIALS_PAGE` | Materials on `/materials`, by number (defaults to those offered) |
| `PS_WHATSAPP`, `PS_EMAIL`, `PS_PHONE`, `PS_ADDRESS`, `PS_MAPS_URL` | Contact details |
| `PS_CONFIRM_RESEND` + `PS_RESEND_KEY`, `PS_MAIL_TO`, `PS_CONTACT_FROM_EMAIL` | Contact-form email |
| `PS_CONFIRM_SHIPROCKET` + `PS_SHIPROCKET_EMAIL`, `PS_SHIPROCKET_PASSWORD`, `PS_PINCODE` | Shiprocket |
| `PS_CONFIRM_TELEGRAM` + `PS_TELEGRAM_TOKEN`, `PS_TELEGRAM_CHAT` | Telegram alerts |

## Where things live

| Path | What it holds |
| --- | --- |
| `.env` | Web address, generated passwords and API keys. Private (`chmod 600`); back it up. |
| `.selfhost/` | Files rendered from `.env` (the Caddyfile) and update state. |
| `backups/` | Database backups taken before each update. |
| Docker volumes `print_*` | Database, uploads and quotation PDFs. |

Useful commands, run from the install folder:

```bash
docker compose ps                        # what's running
docker compose logs -f --tail 100 web    # web logs (also: worker, migrate, caddy)
docker compose restart web
```

## Troubleshooting

- **"Something already uses port 80 or 443".** Another web server is running.
  Stop it, or choose HTTPS option 3 and put this site behind it.
- **The site isn't reachable over HTTPS.** Check that the DNS A record points
  at the server, and that ports 80/443 are open in any cloud firewall. Then
  check `docker compose logs caddy`.
- **Slices fail on big models.** The slicer needs memory; 8 GB is recommended.
- **Uploads over 95 MB fail with a tunnel.** That is Cloudflare's limit.

## For the maintainer: shipping updates to self-hosters

`update.sh` tracks `main`. Whatever is merged there is what every self-hosted
shop gets on its next update, dependency bumps included (they build from
`pnpm-lock.yaml`).

- **A new required env var** needs a default in `apply_env_defaults`
  (`scripts/selfhost/lib.sh`). Existing installs get it on their next update.
- **A new service**, or a change to CPU and memory limits, may need the
  overlays in `docker/selfhost/` updated.
- **`update.sh --after-pull`** is the interface between an installed updater
  and the one it just pulled. Keep it working.
- **New settings** that shops should set belong in the admin dashboard (an
  `AppSetting`), not in `.env`.
- **Bumping OrcaSlicer** changes which printers exist. Regenerate the list
  the installer offers from the new worker image, and commit it:
  `docker run --rm --entrypoint node <worker image> /app/worker/dist/profile-gen.js list > docker/selfhost/printers.tsv`.
  Installed shops regenerate their printer's profiles on every update.

## How printer profiles are made

`apps/worker/src/profile-gen.ts` builds a shop's slicing profiles from the
presets OrcaSlicer ships, inside the worker image:
- the printer's machine preset
- its 0.12 / 0.16 / 0.20 mm process presets (a missing height is derived from
  the printer's closest one)
- one filament preset per material tier: the printer vendor's own "Generic"
  preset where it has one, otherwise OrcaSlicer's universal library

Everything is flattened (the CLI doesn't resolve `inherits`) and written to
`.selfhost/profiles` with a `printer.json` describing the printer, which both
the worker and the website read. The Bambu Lab A1 keeps the hand-tuned
Numakers profiles print.rish.pw uses.
