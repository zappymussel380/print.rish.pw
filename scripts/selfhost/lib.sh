# shellcheck shell=bash
# shellcheck disable=SC2034  # ANS and CFG are read by the scripts that source this
# Shared helpers for install.sh and update.sh. Sourced, never executed.
#
# Every prompt can also be answered by an environment variable (PS_<NAME>), which
# is how unattended installs and the installer's own end-to-end test work. With
# PS_UNATTENDED=1 nothing is ever read from the terminal: a missing required
# answer is an error instead of a question.

# ── Output ──────────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""; C_DIM=""; C_OFF=""
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%s! %s%s\n' "$C_YELLOW" "$*" "$C_OFF"; }
err()  { printf '%s✗ %s%s\n' "$C_RED" "$*" "$C_OFF" >&2; }
die()  { err "$*"; exit 1; }
hint() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
head_line() { printf '\n%s== %s ==%s\n' "$C_BOLD" "$*" "$C_OFF"; }

unattended() { [ "${PS_UNATTENDED:-0}" = "1" ]; }

# ── Prompts ─────────────────────────────────────────────────────────────────────
# confirm "Question?" [Y|N] — returns 0 for yes. Unattended: the default, or the
# value of PS_CONFIRM_<KEY> when a third argument names one.
confirm() {
  local q="$1" def="${2:-N}" key="${3:-}" hint ans
  if [ -n "$key" ]; then
    local envname="PS_CONFIRM_${key}"
    if [ -n "${!envname:-}" ]; then
      case "${!envname,,}" in y|yes|1|true) return 0 ;; *) return 1 ;; esac
    fi
  fi
  if unattended; then [ "$def" = "Y" ]; return; fi
  if [ "$def" = "Y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  while true; do
    read -r -p "$q $hint " ans </dev/tty || die "Input closed."
    ans="${ans:-$def}"
    case "${ans,,}" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
    esac
  done
}

# Answers collected by the wizard, keyed by name. PS_<NAME> in the environment
# answers a question without asking (validated the same way).
# shellcheck disable=SC2034  # read by install.sh
declare -A ANS=()

# _prompt "Prompt" [default] — one line from the terminal, printed on stdout.
_prompt() {
  local q=$1 a
  if [ $# -ge 2 ]; then
    if unattended; then printf '%s' "$2"; return; fi
    read -r -p "$q [${2:-leave empty}]: " a </dev/tty || die "Input closed."
    printf '%s' "${a:-$2}"
  else
    unattended && die "Unattended install is missing an answer for: $q"
    while true; do
      read -r -p "$q: " a </dev/tty || die "Input closed."
      [ -n "$a" ] && { printf '%s' "$a"; return; }
      warn "This one is required." >&2
    done
  fi
}

# ask NAME "Prompt" [default [validator [message]]] — stores ANS[NAME]. Without a
# default the answer is required. A validator (function) is re-asked until it
# accepts; an env-supplied answer that fails it is an error when unattended.
ask() {
  local name=$1 q=$2 env="PS_$1" v check="${4:-}" msg="${5:-That does not look right.}"
  local -a def=()
  [ $# -ge 3 ] && def=("$3")
  if [ -n "${!env+x}" ]; then
    v="${!env}"
    if [ -z "$check" ] || "$check" "$v"; then ANS[$name]="$v"; return; fi
    unattended && die "$env: $msg (got '$v')"
    warn "$env: $msg"
  fi
  while true; do
    v=$(_prompt "$q" "${def[@]}")
    if [ -z "$check" ] || "$check" "$v"; then ANS[$name]="$v"; return; fi
    unattended && die "$q: $msg"
    warn "$msg"
  done
}

# ask_secret NAME "Prompt" [validator [message]] — hidden input, required.
ask_secret() {
  local name=$1 q=$2 env="PS_$1" v check="${3:-}" msg="${4:-That does not look right.}"
  if [ -n "${!env:-}" ]; then
    v="${!env}"
    if [ -z "$check" ] || "$check" "$v"; then ANS[$name]="$v"; return; fi
    die "$env: $msg"
  fi
  unattended && die "Unattended install is missing ${env}."
  while true; do
    read -r -s -p "$q: " v </dev/tty || die "Input closed."
    echo
    if [ -z "$v" ]; then warn "This one is required."; continue; fi
    if [ -z "$check" ] || "$check" "$v"; then ANS[$name]="$v"; return; fi
    warn "$msg"
  done
}

mask() {
  local v="${1:-}"
  if [ -z "$v" ]; then echo "(not set)"; else echo "${v:0:4}…(hidden)"; fi
}

# ── Validators ──────────────────────────────────────────────────────────────────
valid_domain()   { [[ "$1" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]]; }
valid_email()    { [[ "$1" =~ ^[^[:space:]@\']+@[^[:space:]@\']+\.[^[:space:]@\']+$ ]]; }
valid_email_or_empty() { [ -z "$1" ] || valid_email "$1"; }
valid_ipv4()     { [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] && \
                   (( BASH_REMATCH[1] <= 255 && BASH_REMATCH[2] <= 255 && BASH_REMATCH[3] <= 255 && BASH_REMATCH[4] <= 255 )); }
valid_rupees()   { [[ "$1" =~ ^[0-9]{1,6}(\.[0-9]{1,2})?$ ]]; }
valid_rate()     { valid_rupees "$1" && [ "$(to_paise "$1")" -ge 1 ] && [ "$(to_paise "$1")" -le 100000 ]; }
valid_whatsapp_or_empty() { local d; d=$(digits "$1"); [ -z "$1" ] || [[ "$d" =~ ^[0-9]{8,15}$ ]]; }
valid_phone_or_empty() { [ -z "$1" ] || [[ "$1" =~ ^\+?[0-9][0-9\ \(\)-]{5,22}$ ]]; }
valid_pincode_or_empty() { [ -z "$1" ] || [[ "$1" =~ ^[1-9][0-9]{5}$ ]]; }
valid_maps_or_empty() { [ -z "$1" ] || [[ "$1" =~ ^https://(www\.)?google\.com/maps/embed[?/][^\'[:space:]]*$ ]]; }
# Free text that ends up in .env or JSON: one line, no quotes that could break
# either format, sensible length.
valid_text()     { [ -n "$1" ] && valid_text_or_empty "$1"; }
valid_text_or_empty() { [ ${#1} -le 120 ] && [[ "$1" != *\'* ]] && [[ "$1" != *\"* ]] && [[ "$1" != *\\* ]]; }
valid_address_or_empty() { [ ${#1} -le 300 ] && [[ "$1" != *\"* ]] && [[ "$1" != *\\* ]]; }
valid_password() { local n; n=$(printf '%s' "$1" | wc -c); [ "$n" -ge 12 ] && [ "$n" -le 72 ]; }

digits() { printf '%s' "$1" | tr -cd '0-9'; }

# "2.5" → 250, "150" → 15000. Callers validate with valid_rupees first.
to_paise() {
  local whole frac
  whole="${1%%.*}"
  if [[ "$1" == *.* ]]; then frac="${1#*.}"; else frac=""; fi
  frac="${frac}00"; frac="${frac:0:2}"
  echo $(( 10#$whole * 100 + 10#$frac ))
}
# 250 → "2.50"
from_paise() { printf '%d.%02d' $(( $1 / 100 )) $(( $1 % 100 )); }

# ── JSON (no jq on a fresh server) ──────────────────────────────────────────────
json_str() {
  local s
  s=$(printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037')
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\t'/\\t}; s=${s//$'\n'/\\n}; s=${s//$'\r'/}
  printf '"%s"' "$s"
}

# ── .env ────────────────────────────────────────────────────────────────────────
declare -A CFG=()

# Parse without sourcing: KEY=value, KEY='literal value'.
load_env() {
  local file="${1:-$ENV_FILE}" line key val
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    if [[ "$val" == \'*\' ]]; then val="${val:1:${#val}-2}"; fi
    CFG[$key]="$val"
  done < "$file"
}

# Compose .env value: single-quoted (taken literally — no $ interpolation, so a
# bcrypt hash needs no doubling) unless it is plainly safe as-is.
env_value() {
  local v="$1"
  if [[ "$v" =~ ^[A-Za-z0-9_./:@,+-]*$ ]]; then printf '%s' "$v"; else printf "'%s'" "$v"; fi
}

# Ordered sections of every key install.sh manages. Keys found in an existing
# .env that are not listed here are kept, under "Other".
ENV_LAYOUT=(
  "# --- Install (managed by install.sh / update.sh) ---"
  SELFHOST SELFHOST_STATE SELFHOST_VERSION SELFHOST_BRANCH SELFHOST_MODE SELFHOST_DOMAIN SELFHOST_ACME_EMAIL SELFHOST_TLS_INTERNAL
  COMPOSE_FILE
  "# --- Edge / HTTPS ---"
  APP_ORIGIN PROXY_BIND TRUSTED_PROXY_CIDR EDGE_SUBNET EDGE_CADDY_IP
  TUNNEL_SUBNET TUNNEL_CADDY_IP TUNNEL_CLOUDFLARED_IP CLOUDFLARE_TUNNEL_TOKEN LOCAL_PORT
  "# --- Database and cache (generated secrets) ---"
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB
  MIGRATION_DATABASE_URL DATABASE_URL WORKER_DATABASE_URL REDIS_PASSWORD
  "# --- App secrets ---"
  SESSION_SECRET ADMIN_PASSWORD_HASH
  "# --- Integrations (optional) ---"
  GOOGLE_MAPS_EMBED_URL RESEND_API_KEY MAIL_TO CONTACT_FROM
  TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID SHIPROCKET_EMAIL SHIPROCKET_PASSWORD SHIPROCKET_PICKUP_PINCODE
  "# --- Sizing ---"
  MAX_UPLOAD_MB WORKER_CONCURRENCY SELFHOST_WEB_CPUS SELFHOST_WORKER_CPUS SELFHOST_DB_CPUS
  "# --- Printer (profiles generated into .selfhost/profiles) ---"
  PRINTER_MACHINE PRINTER_MULTI_MATERIAL PRINTER_ADVANCED PRINTER_DISPLAY_NAME
)

write_env() {
  local tmp key line
  local -A written=()
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  {
    echo "# Print shop configuration — written by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# Contains secrets: keep it private (chmod 600) and back it up."
    echo "# Shop name, contact details and rates live in the admin dashboard, not here."
    for line in "${ENV_LAYOUT[@]}"; do
      if [[ "$line" == \#* ]]; then echo; echo "$line"; continue; fi
      written[$line]=1
      [ -n "${CFG[$line]+x}" ] || continue
      printf '%s=%s\n' "$line" "$(env_value "${CFG[$line]}")"
    done
    local first=1
    for key in $(printf '%s\n' "${!CFG[@]}" | sort); do
      [ -n "${written[$key]+x}" ] && continue
      if [ "$first" = 1 ]; then echo; echo "# --- Other ---"; first=0; fi
      printf '%s=%s\n' "$key" "$(env_value "${CFG[$key]}")"
    done
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

rand_hex() { openssl rand -hex "${1:-32}"; }

# ── Docker ──────────────────────────────────────────────────────────────────────
# Compose reads COMPOSE_FILE and the project name from the process before .env,
# so clear anything inherited: this checkout's .env is what counts. Run from the
# install folder — relative COMPOSE_FILE entries resolve against the working
# directory, exactly as when the owner types `docker compose` there.
dc() {
  ( cd "$ROOT_DIR" && env -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME -u COMPOSE_PROFILES docker compose "$@" )
}

# The compose project name is pinned in docker-compose.yml ("print"), so any
# other checkout's stack on this machine would be the SAME project. Refuse to
# touch a stack that was started from a different directory.
assert_project_is_ours() {
  local dirs d
  dirs=$(docker ps -a --filter "label=com.docker.compose.project=print" \
    --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | sort -u)
  for d in $dirs; do
    if [ -n "$d" ] && [ "$(cd "$d" 2>/dev/null && pwd -P)" != "$(cd "$ROOT_DIR" && pwd -P)" ]; then
      die "Another print stack on this machine was started from $d.
  This installer manages exactly one stack per server and will not touch it."
    fi
  done
}

# Waits until web and worker report healthy and web answers through the stack.
wait_healthy() {
  local timeout="${1:-300}" waited=0 web worker
  printf '  waiting for the site to come up '
  while true; do
    web=$(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q web 2>/dev/null)" 2>/dev/null || echo starting)
    worker=$(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q worker 2>/dev/null)" 2>/dev/null || echo starting)
    if [ "$web" = healthy ] && [ "$worker" = healthy ] \
      && dc exec -T proxy wget -qO- http://web:3000/api/health 2>/dev/null | grep -q '"ok":true'; then
      echo; ok "Site is up"; return 0
    fi
    if [ "$waited" -ge "$timeout" ]; then
      echo; err "The site did not come up within ${timeout}s (web: $web, worker: $worker)."
      hint "See what went wrong with: cd $ROOT_DIR && docker compose logs --tail 80 migrate web worker"
      return 1
    fi
    printf '.'; sleep 5; waited=$((waited + 5))
  done
}

# A /24 in 172.30.0.0/16 not used by this host's routes or Docker networks.
pick_subnet() {
  local skip="${1:-}" n used
  # shellcheck disable=SC2046  # one argument per network id
  used="$(ip -4 route 2>/dev/null; docker network inspect $(docker network ls -q) \
    -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null || true)"
  for n in $(seq 10 250); do
    [ "172.30.$n.0/24" = "$skip" ] && continue
    grep -q "172\.30\.$n\." <<<"$used" && continue
    echo "172.30.$n.0/24"; return 0
  done
  die "Could not find a free private subnet for the stack's edge network."
}
subnet_host() { local s="${1%/*}"; echo "${s%.*}.$2"; }

# ── Rendered files (.selfhost/, git-ignored) ────────────────────────────────────
render_caddyfile() {
  local file="$ROOT_DIR/.selfhost/Caddyfile" max_mb
  mkdir -p "$ROOT_DIR/.selfhost"
  # One overall ceiling just above the app's own upload cap. Per-route body
  # limits stay in docker/proxy/nginx.conf alone (guarded by its test) — a
  # second copy here would be one more place for a new upload route to 413.
  max_mb=$(( ${CFG[MAX_UPLOAD_MB]:-300} + 1 ))
  case "${CFG[SELFHOST_MODE]}" in
    caddy)
      {
        echo "# Written by install.sh from .env — edits are overwritten on update."
        echo "{"
        echo "	admin off"
        [ -n "${CFG[SELFHOST_ACME_EMAIL]:-}" ] && echo "	email ${CFG[SELFHOST_ACME_EMAIL]}"
        echo "}"
        echo
        echo "${CFG[SELFHOST_DOMAIN]} {"
        [ "${PS_TLS_INTERNAL:-${CFG[SELFHOST_TLS_INTERNAL]:-0}}" = "1" ] && echo "	tls internal"
        cat <<EOF
	request_body {
		max_size ${max_mb}MB
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
	# Overwrite, never append: the compose nginx adopts X-Real-IP from this
	# one peer, and rate limits key off it.
	reverse_proxy proxy:8080 {
		header_up X-Real-IP {remote_host}
		header_up X-Forwarded-For {remote_host}
		header_up X-Forwarded-Proto https
		flush_interval -1
	}
}
EOF
      } > "$file" ;;
    tunnel)
      cat > "$file" <<EOF
# Written by install.sh from .env — edits are overwritten on update.
{
	admin off
	auto_https off
	servers :80 {
		# Only cloudflared can reach this port, so its CF-Connecting-IP is the
		# real visitor address.
		trusted_proxies static ${CFG[TUNNEL_CLOUDFLARED_IP]}/32
		client_ip_headers Cf-Connecting-Ip
	}
}

:80 {
	request_body {
		max_size ${max_mb}MB
	}
	header -Server
	reverse_proxy proxy:8080 {
		header_up X-Real-IP {client_ip}
		header_up X-Forwarded-For {client_ip}
		header_up X-Forwarded-Proto https
		flush_interval -1
	}
}
EOF
      ;;
    local)
      cat > "$file" <<EOF
# Written by install.sh from .env — edits are overwritten on update.
# Local test mode: plain HTTP on this computer only (published on 127.0.0.1).
{
	admin off
	auto_https off
}

:80 {
	request_body {
		max_size ${max_mb}MB
	}
	header -Server
	reverse_proxy proxy:8080 {
		header_up X-Real-IP {remote_host}
		header_up X-Forwarded-For {remote_host}
		header_up X-Forwarded-Proto http
		flush_interval -1
	}
}
EOF
      ;;
    *) rm -f "$file" ;;
  esac
}

# ── Printer profiles ────────────────────────────────────────────────────────────
A1_MACHINE="Bambu Lab A1 0.4 nozzle"

# (Re)generate the printer's profile set into .selfhost/profiles with the worker
# image's own OrcaSlicer presets — so an update that bumps OrcaSlicer also
# refreshes them. Pure JSON work: nothing is sliced, nothing is fetched.
generate_printer_profiles() {
  local machine="${CFG[PRINTER_MACHINE]:-$A1_MACHINE}" out="$ROOT_DIR/.selfhost/profiles" tmp flags=()
  [ "${CFG[PRINTER_MULTI_MATERIAL]:-0}" = "1" ] && flags+=(--multi-material)
  # Advanced mode names the printer itself (it may be starting from a generic preset).
  [ -n "${CFG[PRINTER_DISPLAY_NAME]:-}" ] && flags+=(--name "${CFG[PRINTER_DISPLAY_NAME]}")
  tmp="$ROOT_DIR/.selfhost/profiles.new"
  rm -rf "$tmp"; mkdir -p "$tmp"; chmod 755 "$ROOT_DIR/.selfhost" "$tmp"
  if ! dc run --rm --no-deps -T -v "$tmp:/out" --entrypoint node worker \
      /app/worker/dist/profile-gen.js generate "$machine" /out "${flags[@]}"; then
    rm -rf "$tmp"
    err "Could not build slicing profiles for: $machine"
    return 1
  fi
  chmod -R a+rX "$tmp"
  rm -rf "$out"; mv "$tmp" "$out"
  ok "Slicing profiles ready for ${CFG[PRINTER_DISPLAY_NAME]:-${machine% 0.4 nozzle}}"
}

compose_files_for_mode() {
  case "$1" in
    caddy)  echo "docker-compose.yml:docker/selfhost/compose.base.yml:docker/selfhost/compose.caddy.yml" ;;
    tunnel) echo "docker-compose.yml:docker/selfhost/compose.base.yml:docker/selfhost/compose.tunnel.yml" ;;
    proxy)  echo "docker-compose.yml:docker/selfhost/compose.base.yml" ;;
    local)  echo "docker-compose.yml:docker/selfhost/compose.base.yml:docker/selfhost/compose.local.yml" ;;
  esac
}

# Fill keys a newer version expects, without touching anything already set.
# Returns 0 if something was added.
apply_env_defaults() {
  local changed=1 cpus
  cpus=$(nproc 2>/dev/null || echo 2)
  _default() { if [ -z "${CFG[$1]+x}" ]; then CFG[$1]="$2"; changed=0; fi; }
  _default SELFHOST_BRANCH "main"
  _default POSTGRES_USER "print_owner"
  _default POSTGRES_DB "print"
  _default MAX_UPLOAD_MB "300"
  _default WORKER_CONCURRENCY "1"
  _default SHIPROCKET_PICKUP_PINCODE ""
  _default PRINTER_MACHINE "$A1_MACHINE"
  _default PRINTER_MULTI_MATERIAL "0"
  _default SELFHOST_WEB_CPUS "$(( cpus < 2 ? cpus : 2 ))"
  _default SELFHOST_WORKER_CPUS "$(( cpus < 4 ? cpus : 4 ))"
  _default SELFHOST_DB_CPUS "$(( cpus < 2 ? cpus : 2 ))"
  if [ -n "${CFG[SELFHOST_MODE]:-}" ]; then
    local files; files=$(compose_files_for_mode "${CFG[SELFHOST_MODE]}")
    if [ "${CFG[COMPOSE_FILE]:-}" != "$files" ]; then CFG[COMPOSE_FILE]="$files"; changed=0; fi
  fi
  return $changed
}
