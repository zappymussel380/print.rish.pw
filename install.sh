#!/usr/bin/env bash
#
# Print shop installer — sets up your own copy of this 3D-printing quote site.
#
#   curl -fsSL https://raw.githubusercontent.com/zappymussel380/print.rish.pw/main/install.sh | sudo bash
#
# It asks for your shop's name, web address, rates, materials and contact
# details, then builds and starts everything. Run it again from the install
# folder (sudo ./install.sh) to change the web address, admin password or
# integrations, reset the shop settings, or uninstall. Update with:
#
#   sudo /opt/print-shop/update.sh
#
# Unattended installs: set PS_UNATTENDED=1 and answer with PS_* variables
# (see docs/SELF-HOSTING.md), e.g. `curl … | sudo PS_UNATTENDED=1 PS_BRAND=… bash`.
set -euo pipefail

PS_REPO="${PS_REPO:-https://github.com/zappymussel380/print.rish.pw.git}"
PS_BRANCH="${PS_BRANCH:-main}"

# ── Bootstrap: piped from curl, or run outside a checkout ─────────────────────
# Fetch the code, then hand over to the checkout's own copy of this script with
# the terminal re-attached (stdin is the script itself under `curl | bash`).
bootstrap() {
  local dir answer
  if [ "$(id -u)" -ne 0 ]; then
    echo "Please run the installer with sudo:" >&2
    echo "  curl -fsSL https://raw.githubusercontent.com/zappymussel380/print.rish.pw/main/install.sh | sudo bash" >&2
    exit 1
  fi
  echo "Print shop installer"
  dir="${PS_DIR:-/opt/print-shop}"
  if [ "${PS_UNATTENDED:-0}" != "1" ] && [ -z "${PS_DIR:-}" ]; then
    { exec 3</dev/tty; } 2>/dev/null || { echo "No terminal to ask questions on. Use PS_UNATTENDED=1 (see docs/SELF-HOSTING.md)." >&2; exit 1; }
    read -r -p "Install folder [$dir]: " answer <&3 || true
    exec 3<&-
    dir="${answer:-$dir}"
  fi
  if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      echo "Installing git and curl…"
      DEBIAN_FRONTEND=noninteractive apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates openssl >/dev/null
    else
      echo "Please install git and curl, then run this again." >&2
      exit 1
    fi
  fi
  if [ -d "$dir/.git" ]; then
    echo "Using the existing install in $dir"
    # A first install that never finished picks up fixes published since. A
    # finished one only ever changes through update.sh (backup + rollback).
    if ! grep -q '^SELFHOST_STATE=installed' "$dir/.env" 2>/dev/null \
      && git -C "$dir" diff --quiet 2>/dev/null && git -C "$dir" fetch --quiet origin 2>/dev/null; then
      # .env and .selfhost/ are git-ignored, so the answers so far survive this.
      git -C "$dir" reset --quiet --hard "origin/$(git -C "$dir" rev-parse --abbrev-ref HEAD)" 2>/dev/null || true
    fi
  elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    echo "$dir already exists and is not empty. Choose another folder with PS_DIR=/some/path." >&2
    exit 1
  else
    echo "Downloading into $dir…"
    git clone --quiet --branch "$PS_BRANCH" "$PS_REPO" "$dir"
  fi
  if [ "${PS_UNATTENDED:-0}" = "1" ]; then
    exec bash "$dir/install.sh" "$@"
  fi
  exec bash "$dir/install.sh" "$@" </dev/tty
}

SELF="${BASH_SOURCE[0]:-}"
if [ -z "$SELF" ] || [ ! -f "$SELF" ] || [ ! -f "$(dirname "$SELF")/scripts/selfhost/lib.sh" ]; then
  bootstrap "$@"
fi

ROOT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
# shellcheck source=scripts/selfhost/lib.sh
. "$ROOT_DIR/scripts/selfhost/lib.sh"
trap 'echo; die "Stopped."' INT

# ── Materials offered out of the box (ids, names and default rates) ───────────
MATERIALS=(PLA PLA_AESTHETIC PLA_CF PETG PETG_PREMIUM ABS ASA)
declare -A MAT_NAME=(
  [PLA]="PLA" [PLA_AESTHETIC]="Aesthetic PLA (silk, matte, metallic…)" [PLA_CF]="PLA-CF (carbon fibre)"
  [PETG]="PETG" [PETG_PREMIUM]="PETG Premium (translucent, carbon fibre)" [ABS]="ABS" [ASA]="ASA"
)
declare -A MAT_RATE=([PLA]=2 [PLA_AESTHETIC]=3 [PLA_CF]=3.5 [PETG]=2.5 [PETG_PREMIUM]=3.5 [ABS]=2.5 [ASA]=3)

# ── Preflight ─────────────────────────────────────────────────────────────────
preflight() {
  head_line "Checking this server"
  [ "$(id -u)" -eq 0 ] || die "Please run with sudo: sudo $ROOT_DIR/install.sh"
  [ "$(uname -s)" = "Linux" ] || die "This installer supports Linux servers only."
  [ "$(uname -m)" = "x86_64" ] || die "This server is $(uname -m). The slicer (OrcaSlicer) only ships for x86_64 (Intel/AMD) servers."
  ok "Linux, x86_64"

  local t
  for t in git curl openssl; do
    command -v "$t" >/dev/null 2>&1 || die "'$t' is missing — install it and run this again."
  done

  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker is not installed."
    say "  The official script (https://get.docker.com) can install it for you."
    if confirm "Install Docker now?" Y DOCKER; then
      curl -fsSL https://get.docker.com | sh || die "Docker installation failed."
      ok "Docker installed"
    else
      die "Install Docker Engine with the Compose plugin, then run this again: https://docs.docker.com/engine/install/"
    fi
  fi
  docker info >/dev/null 2>&1 || die "Docker is installed but not running (try: systemctl start docker)."
  docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing: https://docs.docker.com/compose/install/"
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) with Compose"

  local mem_gb disk_gb cpus
  mem_gb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
  disk_gb=$(( $(df -Pk "$ROOT_DIR" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
  cpus=$(nproc)
  if [ "$mem_gb" -ge 7 ]; then ok "${mem_gb} GB memory"
  else warn "${mem_gb} GB memory — 8 GB is recommended; big models may fail to slice."; fi
  if [ "$disk_gb" -ge 25 ]; then ok "${disk_gb} GB free disk"
  else warn "${disk_gb} GB free disk — 25 GB is recommended (the slicer image alone is ~3 GB)."; fi
  if [ "$cpus" -ge 2 ]; then ok "${cpus} CPU cores"
  else warn "1 CPU core — slicing will be slow."; fi
  assert_project_is_ours
}

# ── Wizard sections ───────────────────────────────────────────────────────────
sec_shop() {
  head_line "Your shop"
  hint "This is how customers see you: in the header, page titles, PDFs and WhatsApp messages."
  ask BRAND "Shop name (e.g. Acme Prints)" "" valid_brand "Use 1–40 plain characters (no quotes or backslashes)."
  ask QUOTE_PREFIX "Initials for quotation numbers (e.g. $(initials_for "${ANS[BRAND]}")-2026-0001)" "$(initials_for "${ANS[BRAND]}")" valid_quote_prefix "Use 2 to 5 capital letters, like AP."
  ANS[QUOTE_PREFIX]=${ANS[QUOTE_PREFIX]^^}
  ask TAGLINE "One-line tagline" "instant 3D printing quotes" valid_tagline "Up to 80 plain characters, please."
  ask CITY "City you print from (shown as '3D printing · City')" "" valid_city "Up to 60 plain characters, please."
}

# ── Printer ───────────────────────────────────────────────────────────────────
PRINTERS_FILE="$ROOT_DIR/docker/selfhost/printers.tsv"
vendor_label() { case "$1" in BBL) echo "Bambu Lab" ;; *) echo "$1" ;; esac; }
MENU_MAX=0
valid_menu_index() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le "$MENU_MAX" ]; }

# Every single-nozzle, 0.4 mm printer OrcaSlicer ships (docker/selfhost/printers.tsv:
# vendor, model, Orca machine preset, build volume). Quotes are sliced with the
# chosen printer's own profiles, generated after the build.
sec_printer() {
  head_line "Your printer"
  hint "Every quote is sliced with your printer's own OrcaSlicer profiles, so weight, time and fit match it."
  [ -f "$PRINTERS_FILE" ] || die "Missing $PRINTERS_FILE — the download looks incomplete."
  local machine="" i=1 vendor row def
  if [ -n "${PS_PRINTER:-}" ]; then
    machine=$(awk -F'\t' -v p="$PS_PRINTER" '$3==p || $2==p {print $3; exit}' "$PRINTERS_FILE")
    [ -n "$machine" ] || die "PS_PRINTER: no printer called '$PS_PRINTER' (see $PRINTERS_FILE)."
  else
    local -a vendors models
    mapfile -t vendors < <(cut -f1 "$PRINTERS_FILE" | awk '!seen[$0]++')
    def=1
    for vendor in "${vendors[@]}"; do
      [ "$vendor" = BBL ] && def=$i
      printf '  %3d) %-24s' "$i" "$(vendor_label "$vendor")"
      [ $((i % 3)) -eq 0 ] && echo
      i=$((i + 1))
    done
    echo
    MENU_MAX=${#vendors[@]}
    ask PRINTER_VENDOR "Printer brand (number)" "$def" valid_menu_index "Pick a number from the list."
    vendor=${vendors[$((ANS[PRINTER_VENDOR] - 1))]}
    mapfile -t models < <(awk -F'\t' -v v="$vendor" '$1==v' "$PRINTERS_FILE")
    i=1; def=1
    for row in "${models[@]}"; do
      IFS=$'\t' read -r _ _ mach bed <<<"$row"
      [ "$mach" = "$A1_MACHINE" ] && def=$i
      # The preset name, not the model: a few models come in variants that share one.
      printf '  %3d) %-44s %s mm\n' "$i" "${mach% 0.4 nozzle}" "${bed//x/ × }"
      i=$((i + 1))
    done
    MENU_MAX=${#models[@]}
    ask PRINTER_MODEL "Which $(vendor_label "$vendor") printer (number)" "$def" valid_menu_index "Pick a number from the list."
    machine=$(cut -f3 <<<"${models[$((ANS[PRINTER_MODEL] - 1))]}")
  fi
  ANS[PRINTER_MACHINE]=$machine
  ANS[PRINTER_MULTI]=0
  if confirm "Does it have an AMS, MMU or tool changer for automatic multicolour?" N MULTI_MATERIAL; then
    ANS[PRINTER_MULTI]=1
  fi
  ok "Printer: $(awk -F'\t' -v m="$machine" '$3==m {print $2; exit}' "$PRINTERS_FILE")"
}

sec_address() {
  head_line "Web address and HTTPS"
  hint "You need a domain (e.g. print.example.com) — the site only runs over HTTPS."
  ask DOMAIN "Domain name" "${CFG[SELFHOST_DOMAIN]:-}" valid_domain "Enter just the domain, like print.example.com (no https://)."
  say ""
  say "  How will visitors reach this server?"
  say "   1) This server has a public IP and ports 80/443 are free  ${C_DIM}(recommended — automatic HTTPS)${C_OFF}"
  say "   2) It's at home / behind a router — use a free Cloudflare Tunnel  ${C_DIM}(no port forwarding)${C_OFF}"
  say "   3) I already run my own reverse proxy (nginx, Nginx Proxy Manager, Traefik…)"
  local current=1
  case "${CFG[SELFHOST_MODE]:-}" in tunnel) current=2 ;; proxy) current=3 ;; esac
  ask MODE_CHOICE "Choose 1, 2 or 3" "$current" valid_mode_choice "Please answer 1, 2 or 3."
  case "${ANS[MODE_CHOICE]}" in
    1|caddy)
      ANS[MODE]=caddy
      ask ACME_EMAIL "Email for Let's Encrypt certificate notices (optional)" "${CFG[SELFHOST_ACME_EMAIL]:-}" valid_email_or_empty "That doesn't look like an email address."
      check_ports_free
      check_dns "${ANS[DOMAIN]}" ;;
    2|tunnel)
      ANS[MODE]=tunnel
      say ""
      say "  In the Cloudflare dashboard (your domain must use Cloudflare DNS):"
      say "   1. Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared. Name it anything."
      say "   2. Copy the token from the install command it shows (the long string after --token)."
      say "   3. Public hostname: ${C_BOLD}${ANS[DOMAIN]}${C_OFF} → Service type ${C_BOLD}HTTP${C_OFF}, URL ${C_BOLD}caddy:80${C_OFF}"
      if [ -n "${CFG[CLOUDFLARE_TUNNEL_TOKEN]:-}" ] && ! unattended && confirm "Keep the existing tunnel token $(mask "${CFG[CLOUDFLARE_TUNNEL_TOKEN]}")?" Y; then
        ANS[TUNNEL_TOKEN]="${CFG[CLOUDFLARE_TUNNEL_TOKEN]}"
      else
        ask_secret TUNNEL_TOKEN "Tunnel token (input hidden)" valid_tunnel_token "That doesn't look like a tunnel token (a long base64 string)."
      fi
      warn "Cloudflare limits uploads to 100 MB per file, so model uploads are capped at 95 MB in this mode." ;;
    3|proxy)
      ANS[MODE]=proxy
      hint "Your proxy must terminate HTTPS for ${ANS[DOMAIN]} and forward to this server's port 8080."
      ask PROXY_IP "IP address your proxy connects FROM (exactly one host)" "${CFG[TRUSTED_PROXY_CIDR]:-}" valid_ipv4 "Enter one IPv4 address, like 192.168.1.20."
      ask PROXY_BIND "Address on THIS server to listen on for it (never 0.0.0.0)" "${CFG[PROXY_BIND]:-127.0.0.1}" valid_bind_address "Enter one IPv4 address of this server (not 0.0.0.0)." ;;
  esac
}
# Lengths match the site profile's own limits (packages/shared/src/site-profile.ts),
# or the app would quietly replace an over-long value with its default.
valid_brand()   { valid_text "$1" && [ ${#1} -le 40 ]; }
valid_quote_prefix() { [[ "${1^^}" =~ ^[A-Z]{2,5}$ ]]; }
# "Acme Prints" → AP, "Printery" → PRI (matches initialsFor in packages/shared).
initials_for() {
  local w out=""
  for w in $(printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9\n' ' '); do
    w=${w//[^A-Z]/}; [ -n "$w" ] && out+=${w:0:1}
  done
  if [ ${#out} -lt 2 ]; then out=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -cd 'A-Z' | cut -c1-3); fi
  out=${out:0:5}
  [[ "$out" =~ ^[A-Z]{2,5}$ ]] && echo "$out" || echo RSP
}
valid_tagline() { valid_text_or_empty "$1" && [ ${#1} -le 80 ]; }
valid_city()    { valid_text_or_empty "$1" && [ ${#1} -le 60 ]; }
valid_mode_choice() { [[ "$1" =~ ^(1|2|3|caddy|tunnel|proxy)$ ]]; }
valid_tunnel_token() { [[ "$1" =~ ^[A-Za-z0-9+/=_-]{60,}$ ]]; }
valid_bind_address() { valid_ipv4 "$1" && [ "$1" != "0.0.0.0" ]; }

check_ports_free() {
  local busy
  busy=$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E '(^|:)(80|443)$' || true)
  if [ -n "$busy" ] && ! docker ps --format '{{.Names}}' | grep -q '^print-caddy-'; then
    err "Something on this server already uses port 80 or 443:"
    ss -ltnp 2>/dev/null | grep -E ':(80|443)\s' | sed 's/^/    /' >&2 || true
    die "Stop that web server (or choose option 3 and put this site behind it), then run this again."
  fi
  ok "Ports 80 and 443 are free"
}

check_dns() {
  local domain=$1 public resolved
  public=$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)
  # getent exits non-zero for a name that doesn't resolve yet — expected here.
  resolved=$(getent ahostsv4 "$domain" 2>/dev/null | awk 'NR==1 {print $1}' || true)
  if [ -z "$resolved" ]; then
    warn "$domain doesn't resolve yet. Point an A record at ${public:-the IP of this server} — HTTPS starts working once it does."
  elif [ -n "$public" ] && [ "$resolved" != "$public" ]; then
    warn "$domain points at $resolved, but this server's public IP looks like $public."
    hint "Fine if a CDN or NAT sits in between; otherwise fix the DNS A record, or Let's Encrypt will fail."
  else
    ok "$domain points at this server"
  fi
}

sec_admin() {
  head_line "Admin password"
  hint "You'll use this at https://${ANS[DOMAIN]}/admin to manage quotes, rates and colours."
  local again
  while true; do
    ask_secret ADMIN_PASSWORD "Choose an admin password (12+ characters, hidden)" valid_password "Use 12 to 72 characters."
    [ -n "${PS_ADMIN_PASSWORD:-}" ] && break
    read -r -s -p "Type it again: " again </dev/tty; echo
    [ "$again" = "${ANS[ADMIN_PASSWORD]}" ] && break
    warn "Those didn't match — try again."
  done
}

sec_materials() {
  head_line "Materials and rates"
  hint "Customers pay: grams of filament (from the real slicer) × the material's rate, plus one setup fee per order."
  local i=1 m
  for m in "${MATERIALS[@]}"; do say "   $i) ${MAT_NAME[$m]}"; i=$((i + 1)); done
  ask MATERIALS "Which do you print? Numbers, comma-separated" "1,4" valid_material_list "Use numbers from the list, e.g. 1,4,6"
  OFFERED=()
  local n
  for n in ${ANS[MATERIALS]//,/ }; do OFFERED+=("${MATERIALS[$((n - 1))]}"); done
  mapfile -t OFFERED < <(printf '%s\n' "${OFFERED[@]}" | awk '!seen[$0]++')

  ask SETUP_FEE "One-time setup fee per order, in ₹" "150" valid_rupees "Enter an amount like 150 or 99.50."
  for m in "${OFFERED[@]}"; do
    ask "RATE_$m" "Price per gram for ${MAT_NAME[$m]}, in ₹" "${MAT_RATE[$m]}" valid_rate "Enter a price like 2 or 2.50 (₹0.01 to ₹1000)."
  done
  if [[ " ${OFFERED[*]} " == *" ABS "* || " ${OFFERED[*]} " == *" ASA "* ]]; then
    warn "ABS/ASA print best in an enclosure; on an open-frame printer large flat parts can warp."
    hint "They start with black and white; add more colours by hex code in admin → Catalog."
  fi
  hint "Colours, internal costs and lead time are managed in the admin dashboard later."

  say ""
  say "  The Materials page compares materials side by side for customers."
  local default_page="" idx
  for m in "${OFFERED[@]}"; do
    for idx in "${!MATERIALS[@]}"; do [ "${MATERIALS[$idx]}" = "$m" ] && default_page+="${default_page:+,}$((idx + 1))"; done
  done
  ask MATERIALS_PAGE "Which should it explain? Numbers, comma-separated" "$default_page" valid_material_list "Use numbers from the list above."
}
valid_material_list() {
  local n
  [[ "$1" =~ ^[0-9]+(,[[:space:]]*[0-9]+)*$ ]] || return 1
  for n in ${1//,/ }; do [ "$n" -ge 1 ] && [ "$n" -le ${#MATERIALS[@]} ] || return 1; done
}
material_ids() {  # "1,4" → "PLA PETG" (deduplicated, in the order given)
  local n out=()
  for n in ${1//,/ }; do out+=("${MATERIALS[$((n - 1))]}"); done
  printf '%s\n' "${out[@]}" | awk '!seen[$0]++'
}

sec_contact() {
  head_line "Contact details"
  hint "Shown on the Contact page. WhatsApp matters most: every quote hands off to it."
  ask WHATSAPP "WhatsApp number with country code (e.g. 91 98765 43210)" "" valid_whatsapp_or_empty "Enter 8–15 digits including the country code."
  [ -n "${ANS[WHATSAPP]}" ] || warn "Without a WhatsApp number, customers can't send you their quote after submitting."
  ask EMAIL "Contact email (optional)" "" valid_email_or_empty "That doesn't look like an email address."
  ask PHONE "Phone number (optional)" "" valid_phone_or_empty "Digits, spaces, + and dashes only (up to 24)."
  ask ADDRESS "Address or area (optional)" "" valid_address_or_empty "Up to 300 characters, no double quotes."
  ask MAPS_URL "Google Maps embed link for the Contact page (optional)" "${CFG[GOOGLE_MAPS_EMBED_URL]:-}" valid_maps_or_empty "Paste the https://www.google.com/maps/embed?... link from Share → Embed a map."
}

sec_integrations() {
  head_line "Optional extras (you can skip all of these)"
  if confirm "Email contact-form messages to you (needs a free resend.com account)?" N RESEND; then
    ask_secret RESEND_KEY "Resend API key (input hidden)"
    ask MAIL_TO "Send contact-form messages to" "${ANS[EMAIL]:-${CFG[MAIL_TO]:-}}" valid_email "Enter an email address."
    ask CONTACT_FROM_EMAIL "Send them from (an address on a domain verified in Resend)" "contact@${ANS[DOMAIN]}" valid_email "Enter an email address."
  fi
  if confirm "Show live courier shipping prices (needs a Shiprocket API user)?" N SHIPROCKET; then
    ask SHIPROCKET_EMAIL "Shiprocket API user email" "" valid_email "Enter an email address."
    ask_secret SHIPROCKET_PASSWORD "Shiprocket API user password (input hidden)"
    ask PINCODE "Pickup pincode" "" valid_pincode_or_empty "Enter a 6-digit pincode."
  fi
  if confirm "Get a Telegram message for every new quotation?" N TELEGRAM; then
    ask_secret TELEGRAM_TOKEN "Telegram bot token from @BotFather (input hidden)"
    ask TELEGRAM_CHAT "Telegram chat id" "" valid_text "Enter the chat id."
  fi
}

summary() {
  head_line "Summary"
  local m rates=""
  for m in "${OFFERED[@]}"; do rates+="${rates:+, }$m ₹$(from_paise "$(to_paise "${ANS[RATE_$m]}")")/g"; done
  say "  Shop:        ${ANS[BRAND]}${ANS[CITY]:+ · ${ANS[CITY]}}  (quotes numbered ${ANS[QUOTE_PREFIX]:-RSP}-$(date +%Y)-0001)"
  say "  Address:     https://${ANS[DOMAIN]}  (${ANS[MODE]})"
  say "  Printer:     ${ANS[PRINTER_MACHINE]% 0.4 nozzle}$([ "${ANS[PRINTER_MULTI]:-0}" = 1 ] && echo " (automatic multicolour)")"
  say "  Materials:   $rates"
  say "  Setup fee:   ₹$(from_paise "$(to_paise "${ANS[SETUP_FEE]}")") per order"
  say "  Materials page: $(material_ids "${ANS[MATERIALS_PAGE]}" | paste -sd, - | sed 's/,/, /g')"
  say "  WhatsApp:    ${ANS[WHATSAPP]:-(none)}"
  say "  Install dir: $ROOT_DIR"
  confirm "Build and start the site now? (the first build takes 10–25 minutes)" Y START || die "Nothing was changed."
}

# ── Resume support ────────────────────────────────────────────────────────────
# The wizard's answers (never the admin password) are kept in a private file
# until the install finishes, so a failed build can be resumed without asking
# everything again.
ANSWERS_FILE="$ROOT_DIR/.selfhost/answers"

save_answers() {
  local k tmp
  mkdir -p "$ROOT_DIR/.selfhost"
  tmp=$(mktemp "$ANSWERS_FILE.XXXXXX")
  for k in "${!ANS[@]}"; do
    [ "$k" = ADMIN_PASSWORD ] && continue
    printf '%s=%s\n' "$k" "$(env_value "${ANS[$k]}")"
  done > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ANSWERS_FILE"
}

load_answers() {
  local -A saved_cfg=()
  local k
  for k in "${!CFG[@]}"; do saved_cfg[$k]=${CFG[$k]}; done
  CFG=()
  load_env "$ANSWERS_FILE"
  for k in "${!CFG[@]}"; do ANS[$k]=${CFG[$k]}; done
  CFG=()
  for k in "${!saved_cfg[@]}"; do CFG[$k]=${saved_cfg[$k]}; done
}

# ── Apply ─────────────────────────────────────────────────────────────────────
configure_env() {
  local mode=${ANS[MODE]}
  CFG[SELFHOST]=1
  CFG[SELFHOST_MODE]=$mode
  CFG[SELFHOST_DOMAIN]=${ANS[DOMAIN]}
  CFG[SELFHOST_ACME_EMAIL]=${ANS[ACME_EMAIL]:-}
  CFG[SELFHOST_VERSION]=$(git -C "$ROOT_DIR" rev-parse --short HEAD)
  # update.sh follows the branch this checkout was installed from.
  local branch; branch=$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)
  [ "$branch" = HEAD ] || CFG[SELFHOST_BRANCH]=$branch
  CFG[APP_ORIGIN]="https://${ANS[DOMAIN]}"
  [ -n "${PS_TLS_INTERNAL:-}" ] && CFG[SELFHOST_TLS_INTERNAL]=$PS_TLS_INTERNAL
  apply_env_defaults || true

  unset 'CFG[EDGE_SUBNET]' 'CFG[EDGE_CADDY_IP]' 'CFG[TUNNEL_SUBNET]' 'CFG[TUNNEL_CADDY_IP]' 'CFG[TUNNEL_CLOUDFLARED_IP]' 'CFG[CLOUDFLARE_TUNNEL_TOKEN]'
  case "$mode" in
    caddy|tunnel)
      CFG[EDGE_SUBNET]=${PREV_EDGE_SUBNET:-$(pick_subnet)}
      CFG[EDGE_CADDY_IP]=$(subnet_host "${CFG[EDGE_SUBNET]}" 10)
      CFG[PROXY_BIND]=127.0.0.1
      CFG[TRUSTED_PROXY_CIDR]=${CFG[EDGE_CADDY_IP]} ;;
    proxy)
      CFG[PROXY_BIND]=${ANS[PROXY_BIND]}
      CFG[TRUSTED_PROXY_CIDR]=${ANS[PROXY_IP]} ;;
  esac
  if [ "$mode" = tunnel ]; then
    CFG[TUNNEL_SUBNET]=${PREV_TUNNEL_SUBNET:-$(pick_subnet "${CFG[EDGE_SUBNET]}")}
    CFG[TUNNEL_CADDY_IP]=$(subnet_host "${CFG[TUNNEL_SUBNET]}" 10)
    CFG[TUNNEL_CLOUDFLARED_IP]=$(subnet_host "${CFG[TUNNEL_SUBNET]}" 20)
    CFG[CLOUDFLARE_TUNNEL_TOKEN]=${ANS[TUNNEL_TOKEN]}
    CFG[MAX_UPLOAD_MB]=95
  elif [ "${CFG[MAX_UPLOAD_MB]:-300}" = 95 ]; then
    CFG[MAX_UPLOAD_MB]=300
  fi
  CFG[COMPOSE_FILE]=$(compose_files_for_mode "$mode")
  [ -n "${ANS[PRINTER_MACHINE]:-}" ] && CFG[PRINTER_MACHINE]=${ANS[PRINTER_MACHINE]}
  [ -n "${ANS[PRINTER_MULTI]:-}" ] && CFG[PRINTER_MULTI_MATERIAL]=${ANS[PRINTER_MULTI]}
  # Menu 2 asks no printer questions: the tests above then fail, and that
  # status must not become the function's, or set -e ends the installer.
  return 0
}

generate_secrets() {
  # Only ever generated once: rotating them on a re-run would lock the
  # database out of its own data.
  if [ -z "${CFG[POSTGRES_PASSWORD]:-}" ]; then
    local owner web worker
    owner=$(rand_hex 32); web=$(rand_hex 32); worker=$(rand_hex 32)
    CFG[POSTGRES_PASSWORD]=$owner
    CFG[MIGRATION_DATABASE_URL]="postgresql://${CFG[POSTGRES_USER]}:$owner@postgres:5432/${CFG[POSTGRES_DB]}"
    CFG[DATABASE_URL]="postgresql://print_web:$web@postgres:5432/${CFG[POSTGRES_DB]}"
    CFG[WORKER_DATABASE_URL]="postgresql://print_worker:$worker@postgres:5432/${CFG[POSTGRES_DB]}"
    ok "Database passwords generated"
  fi
  [ -n "${CFG[REDIS_PASSWORD]:-}" ] || CFG[REDIS_PASSWORD]=$(rand_hex 32)
  [ -n "${CFG[SESSION_SECRET]:-}" ] || CFG[SESSION_SECRET]=$(rand_hex 32)
  # Compose refuses to even build with this unset. The real hash replaces the
  # marker once the tools image exists; web never starts with it (and would
  # refuse to if it did).
  [ -n "${CFG[ADMIN_PASSWORD_HASH]:-}" ] || CFG[ADMIN_PASSWORD_HASH]=pending-install
}

configure_integrations() {
  CFG[GOOGLE_MAPS_EMBED_URL]=${ANS[MAPS_URL]:-${CFG[GOOGLE_MAPS_EMBED_URL]:-}}
  if [ -n "${ANS[RESEND_KEY]:-}" ]; then
    CFG[RESEND_API_KEY]=${ANS[RESEND_KEY]}
    CFG[MAIL_TO]=${ANS[MAIL_TO]}
    local sender="${ANS[BRAND]:-${CFG[CONTACT_FROM]% <*}}"
    [ -n "$sender" ] && [ "$sender" != "${CFG[CONTACT_FROM]:-}" ] || sender="Print shop"
    CFG[CONTACT_FROM]="$sender <${ANS[CONTACT_FROM_EMAIL]}>"
  fi
  if [ -n "${ANS[SHIPROCKET_EMAIL]:-}" ]; then
    CFG[SHIPROCKET_EMAIL]=${ANS[SHIPROCKET_EMAIL]}
    CFG[SHIPROCKET_PASSWORD]=${ANS[SHIPROCKET_PASSWORD]}
    CFG[SHIPROCKET_PICKUP_PINCODE]=${ANS[PINCODE]:-}
  fi
  if [ -n "${ANS[TELEGRAM_TOKEN]:-}" ]; then
    CFG[TELEGRAM_BOT_TOKEN]=${ANS[TELEGRAM_TOKEN]}
    CFG[TELEGRAM_CHAT_ID]=${ANS[TELEGRAM_CHAT]}
  fi
}

build_images() {
  head_line "Building (10–25 minutes the first time; later updates are faster)"
  dc build --pull || die "The build failed. Scroll up for the first error, or run: cd $ROOT_DIR && docker compose build"
  ok "Images built"
}

set_admin_password() {
  local hash
  # Resuming with a hash already in place and no new password: keep it.
  if [ -z "${ANS[ADMIN_PASSWORD]:-}" ] && [ "${CFG[ADMIN_PASSWORD_HASH]:-pending-install}" != "pending-install" ]; then
    return 0
  fi
  say "  Hashing the admin password…"
  dc --profile tools build tools >/dev/null || die "Could not build the password helper."
  hash=$(printf '%s' "${ANS[ADMIN_PASSWORD]}" | dc --profile tools run --rm -T tools 2>/dev/null | tail -n1) || hash=""
  docker image rm print-tools >/dev/null 2>&1 || true
  [[ "$hash" =~ ^\$2[aby]\$1[2-9]\$[./A-Za-z0-9]{53}$ ]] || die "Hashing the admin password failed."
  CFG[ADMIN_PASSWORD_HASH]=$hash
  write_env
  ok "Admin password set"
}

start_stack() {
  head_line "Starting"
  dc up -d --remove-orphans || die "Starting failed. See: cd $ROOT_DIR && docker compose logs --tail 80"
  wait_healthy 420 || die "The site didn't come up."
}

# The seed payload. Kept out of a command substitution: a heredoc nested in
# $( … ) that itself contains $( … ) is where bash's parser gives up.
settings_json() {
  local json_page=$1 json_rates=$2 json_offered=$3 json_colours=$4 json_customs=$5
  cat <<EOF
{
  "siteProfile": {
    "brandName": $(json_str "${ANS[BRAND]}"),
    "tagline": $(json_str "${ANS[TAGLINE]}"),
    "city": $(json_str "${ANS[CITY]}"),
    "contact": {
      "whatsappNumber": $(json_str "$(digits "${ANS[WHATSAPP]}")"),
      "email": $(json_str "${ANS[EMAIL]}"),
      "phone": $(json_str "${ANS[PHONE]}"),
      "address": $(json_str "${ANS[ADDRESS]}")
    },
    "footerNote": "",
    "quotationPrefix": $(json_str "${ANS[QUOTE_PREFIX]:-RSP}"),
    "materialsPage": [$json_page]
  },
  "pricing": {
    "setupFeePaise": $(to_paise "${ANS[SETUP_FEE]}"),
    "materials": {$json_rates}
  },
  "catalogAvailability": {
    "materials": {$json_offered},
    "colours": {$json_colours},
    "customColours": [$json_customs]
  }
}
EOF
}

# The shop's settings go straight into the database, where the admin dashboard
# edits them from then on.
seed_shop_settings() {
  local m first json_offered="" json_rates="" json_page="" json_colours="" json_customs="" id
  for m in "${MATERIALS[@]}"; do
    if [[ " ${OFFERED[*]} " == *" $m "* ]]; then json_offered+="${json_offered:+,}\"$m\":true"; else json_offered+="${json_offered:+,}\"$m\":false"; fi
  done
  for m in "${OFFERED[@]}"; do
    json_rates+="${json_rates:+,}\"$m\":{\"sellPerGramPaise\":$(to_paise "${ANS[RATE_$m]}")}"
  done
  while read -r m; do json_page+="${json_page:+,}\"$m\""; done < <(material_ids "${ANS[MATERIALS_PAGE]}")
  # ABS/ASA have no supplier palette: start them with black and white.
  for m in ABS ASA; do
    [[ " ${OFFERED[*]} " == *" $m "* ]] || continue
    id=${m,,}
    json_customs+="${json_customs:+,}{\"id\":\"custom-$id-black\",\"name\":\"Black\",\"hex\":\"#1A1A1A\",\"material\":\"$m\"}"
    json_customs+=",{\"id\":\"custom-$id-white\",\"name\":\"White\",\"hex\":\"#F4F4F0\",\"material\":\"$m\"}"
    json_colours+="${json_colours:+,}\"$m\":[\"custom-$id-black\",\"custom-$id-white\"]"
  done
  local payload
  payload=$(settings_json "$json_page" "$json_rates" "$json_offered" "$json_colours" "$json_customs")
  printf '%s' "$payload" | dc run --rm -T migrate seed-settings >/dev/null || die "Saving the shop settings failed."
  ok "Shop settings saved"
}

finish() {
  head_line "Done"
  local url="https://${CFG[SELFHOST_DOMAIN]}"
  say "  Your site:  ${C_BOLD}$url${C_OFF}"
  say "  Admin:      ${C_BOLD}$url/admin${C_OFF}  (the password you chose)"
  case "${CFG[SELFHOST_MODE]}" in
    caddy)
      if curl -fsS --max-time 15 "$url/api/health" >/dev/null 2>&1; then ok "Reachable over HTTPS"
      else warn "Not reachable over HTTPS yet — usually DNS still propagating. Caddy keeps retrying the certificate."; fi ;;
    tunnel) hint "Make sure the tunnel's public hostname points ${CFG[SELFHOST_DOMAIN]} at http://caddy:80." ;;
    proxy)
      say ""
      say "  Point your reverse proxy at http://${CFG[PROXY_BIND]}:8080 (from ${CFG[TRUSTED_PROXY_CIDR]} only)."
      say "  It must terminate HTTPS, OVERWRITE X-Real-IP and X-Forwarded-For with the visitor's IP,"
      say "  and allow request bodies up to 301 MB on /api/uploads. Full nginx example: docs/DEPLOYMENT.md" ;;
  esac
  say ""
  say "  Next, in the admin dashboard:"
  say "   • Catalog — switch on the colours you actually stock"
  say "   • Rates — your filament costs, so profit estimates are right"
  say "   • Site — name, contact details and the Materials page, any time"
  say ""
  say "  Update to the latest version any time:  ${C_BOLD}sudo $ROOT_DIR/update.sh${C_OFF}"
  say "  Change settings or uninstall:           ${C_BOLD}sudo $ROOT_DIR/install.sh${C_OFF}"
}

# ── Existing install ──────────────────────────────────────────────────────────
uninstall() {
  head_line "Uninstall"
  [ "${CFG[SELFHOST]:-}" = "1" ] || die "This .env wasn't written by install.sh — refusing to uninstall anything."
  confirm "Stop and remove the site's containers?" N UNINSTALL || die "Nothing was changed."
  dc --profile tools down --remove-orphans
  ok "Containers removed (your data is still there)"
  warn "The database, uploaded models and quotation PDFs are kept in Docker volumes."
  if confirm "Delete ALL of that data permanently?" N DELETE_DATA; then
    local typed="${PS_CONFIRM_DELETE_TEXT:-}"
    unattended || read -r -p "Type DELETE to confirm: " typed </dev/tty
    if [ "$typed" = "DELETE" ]; then
      dc --profile tools down -v --remove-orphans
      ok "Data deleted"
    else
      say "  Kept the data."
    fi
  fi
  say "  The code is still in $ROOT_DIR — delete that folder to remove everything."
  exit 0
}

existing_menu() {
  head_line "This site is already installed"
  say "  1) Rebuild and restart with the current settings"
  say "  2) Change the web address / HTTPS setup"
  say "  3) Change the admin password"
  say "  4) Change optional extras (email, shipping, Telegram, map)"
  say "  5) Change the printer"
  say "  6) Start over with new shop settings  ${C_DIM}(replaces name, rates, materials and contact set in admin)${C_OFF}"
  say "  7) Uninstall"
  say "  8) Quit"
  ask MENU "Choose" "1" valid_menu "Please answer 1–8."
}
valid_menu() { [[ "$1" =~ ^[1-8]$ ]]; }

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  say "${C_BOLD}Print shop installer${C_OFF}  ${C_DIM}($ROOT_DIR)${C_OFF}"
  if [ -f "$ENV_FILE" ]; then
    load_env
    [ "${CFG[SELFHOST]:-}" = "1" ] || die "$ENV_FILE was not written by this installer (it has no SELFHOST=1).
  It looks like a hand-configured deployment — this installer will not touch it."
  fi
  case "${1:-}" in
    --uninstall) preflight; uninstall ;;
    --help|-h) sed -n '2,16p' "$SELF"; exit 0 ;;
    "") ;;
    *) die "Unknown option $1 (try --help)" ;;
  esac
  preflight
  PREV_EDGE_SUBNET=${CFG[EDGE_SUBNET]:-}
  PREV_TUNNEL_SUBNET=${CFG[TUNNEL_SUBNET]:-}

  if [ "${CFG[SELFHOST]:-}" = "1" ] && [ "${CFG[SELFHOST_STATE]:-}" != "installed" ]; then
    resume_install
    exit 0
  fi

  if [ "${CFG[SELFHOST]:-}" = "1" ]; then
    existing_menu
    case "${ANS[MENU]}" in
      1) apply_env_defaults || true; write_env; render_caddyfile; build_images
         generate_printer_profiles || die "Slicing profiles could not be built."; start_stack; finish ;;
      2) local old_mode=${CFG[SELFHOST_MODE]}
         sec_address; configure_env
         # A different edge layout needs its networks recreated.
         [ "$old_mode" = "${CFG[SELFHOST_MODE]}" ] || dc down --remove-orphans
         write_env; render_caddyfile; start_stack; finish ;;
      3) ANS[DOMAIN]=${CFG[SELFHOST_DOMAIN]}; sec_admin; set_admin_password; dc up -d --force-recreate web; wait_healthy 180; ok "Password changed" ;;
      4) ANS[DOMAIN]=${CFG[SELFHOST_DOMAIN]}
         ask MAPS_URL "Google Maps embed link (optional)" "${CFG[GOOGLE_MAPS_EMBED_URL]:-}" valid_maps_or_empty "Paste the https://www.google.com/maps/embed?... link."
         sec_integrations; configure_integrations; write_env; dc up -d --force-recreate web; wait_healthy 180; ok "Saved" ;;
      5) sec_printer
         local old_machine=${CFG[PRINTER_MACHINE]:-} old_multi=${CFG[PRINTER_MULTI_MATERIAL]:-0}
         CFG[PRINTER_MACHINE]=${ANS[PRINTER_MACHINE]}; CFG[PRINTER_MULTI_MATERIAL]=${ANS[PRINTER_MULTI]}
         if ! generate_printer_profiles; then
           CFG[PRINTER_MACHINE]=$old_machine; CFG[PRINTER_MULTI_MATERIAL]=$old_multi
           die "Kept the previous printer."
         fi
         write_env
         dc up -d --force-recreate web worker; wait_healthy 240; ok "Now quoting for ${CFG[PRINTER_MACHINE]% 0.4 nozzle}" ;;
      6) ANS[DOMAIN]=${CFG[SELFHOST_DOMAIN]}; sec_shop; sec_materials; sec_contact
         confirm "Replace the shop settings in the admin dashboard with these?" N RESET || die "Nothing was changed."
         seed_shop_settings ;;
      7) uninstall ;;
      8) exit 0 ;;
    esac
    exit 0
  fi

  say "This sets up the whole site: shop details, web address, rates, then a build."
  hint "Press Enter to accept a [default]. Ctrl+C stops at any point without changing anything."
  sec_shop
  sec_printer
  sec_address
  sec_admin
  sec_materials
  sec_contact
  sec_integrations
  summary

  configure_env
  generate_secrets
  configure_integrations
  CFG[SELFHOST_STATE]=configured
  write_env
  save_answers
  ok "Settings written to $ENV_FILE"
  install_from_build
}

# Everything after the questions; also where an interrupted install resumes.
install_from_build() {
  render_caddyfile
  build_images
  generate_printer_profiles || die "Pick another printer with: sudo $ROOT_DIR/install.sh (option 5)."
  set_admin_password
  start_stack
  seed_shop_settings
  CFG[SELFHOST_STATE]=installed
  write_env
  rm -f "$ANSWERS_FILE"
  finish
}

resume_install() {
  head_line "Finishing the previous install"
  say "  An earlier run stopped before the site was fully set up. Picking up where it left off."
  if [ -f "$ANSWERS_FILE" ]; then
    load_answers
  else
    warn "The earlier answers were lost; please answer the shop questions again."
    ANS[DOMAIN]=${CFG[SELFHOST_DOMAIN]}
    sec_shop; sec_materials; sec_contact
    save_answers
  fi
  mapfile -t OFFERED < <(material_ids "${ANS[MATERIALS]}")
  if [ "${CFG[ADMIN_PASSWORD_HASH]:-pending-install}" = "pending-install" ]; then
    ANS[DOMAIN]=${CFG[SELFHOST_DOMAIN]}
    sec_admin
  fi
  apply_env_defaults || true
  write_env
  install_from_build
}

main "$@"
