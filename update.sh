#!/usr/bin/env bash
#
# Update this print shop to the latest version: new code, new dependencies,
# rebuilt images and database migrations — with a database backup first and an
# automatic way back if the new version doesn't come up.
#
#   sudo ./update.sh              update, if there is anything new
#   sudo ./update.sh --yes        same, without asking (for cron)
#   sudo ./update.sh --rebuild    rebuild even when already up to date
#   sudo ./update.sh --full       rebuild without Docker's cache (also refreshes OS packages)
#   sudo ./update.sh --rollback   go back to the version before the last update
#
# Your settings, rates, colours and quotations are kept: they live in .env and
# the database, which an update never replaces.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
ROOT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
# shellcheck source=scripts/selfhost/lib.sh
. "$ROOT_DIR/scripts/selfhost/lib.sh"

BACKUP_DIR="$ROOT_DIR/backups"
KEEP_BACKUPS=5
STATE_FILE="$ROOT_DIR/.selfhost/last-update"
SERVICES_BUILT=(web worker migrate)

YES=0; REBUILD=0; FULL=0; ROLLBACK=0; AFTER_PULL=0

usage() { sed -n '2,15p' "$SELF"; }

preflight() {
  [ "$(id -u)" -eq 0 ] || die "Please run with sudo: sudo $ROOT_DIR/update.sh"
  [ -f "$ENV_FILE" ] || die "No .env in $ROOT_DIR — install first with install.sh."
  load_env
  # The one guard that keeps this script away from any deployment it did not
  # create (print.rish.pw's own server included).
  [ "${CFG[SELFHOST]:-}" = "1" ] || die "$ENV_FILE was not written by install.sh — update.sh only manages installs it created."
  [ "${CFG[SELFHOST_STATE]:-}" = "installed" ] || die "The install never finished. Run: sudo $ROOT_DIR/install.sh"
  docker info >/dev/null 2>&1 || die "Docker is not running (try: systemctl start docker)."
  assert_project_is_ours
  if ! git -C "$ROOT_DIR" diff --quiet || ! git -C "$ROOT_DIR" diff --cached --quiet; then
    err "Files in $ROOT_DIR were edited by hand:"
    git -C "$ROOT_DIR" status --short --untracked-files=no | sed 's/^/    /' >&2
    die "Updating would overwrite them. Undo them with: cd $ROOT_DIR && git checkout -- ."
  fi
}

short() { git -C "$ROOT_DIR" rev-parse --short "${1:-HEAD}"; }

backup_database() {
  local file
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  file="$BACKUP_DIR/$(date +%Y%m%d-%H%M%S)-$(short).pgdump"
  say "  Backing up the database…"
  ( umask 077
    dc exec -T postgres pg_dump -U "${CFG[POSTGRES_USER]}" -d "${CFG[POSTGRES_DB]}" --format=custom > "$file" ) \
    || { rm -f "$file"; die "The database backup failed, so nothing was updated."; }
  [ -s "$file" ] || { rm -f "$file"; die "The database backup came out empty, so nothing was updated."; }
  ls -1t "$BACKUP_DIR"/*.pgdump 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
  ok "Backup: $file"
  BACKUP_FILE=$file
}

# Tag the images running now BEFORE building: the build moves :latest, and the
# old images would otherwise be left untagged and unreachable.
tag_rollback_images() {
  local sha=$1 svc img tag
  for svc in "${SERVICES_BUILT[@]}"; do
    img="print-$svc"
    docker image inspect "$img:latest" >/dev/null 2>&1 || continue
    docker tag "$img:latest" "$img:rollback-$sha"
    for tag in $(docker images "$img" --format '{{.Tag}}' | grep '^rollback-' | grep -v "^rollback-$sha$" || true); do
      docker rmi "$img:$tag" >/dev/null 2>&1 || true
    done
  done
  ok "Current version kept for rollback ($sha)"
}

record_state() {
  mkdir -p "$ROOT_DIR/.selfhost"
  printf 'PREV_SHA=%s\nBACKUP_FILE=%s\nUPDATED_AT=%s\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE"
  chmod 600 "$STATE_FILE"
}

# ── Stage 1: this (old) script decides and fetches ────────────────────────────
stage_fetch() {
  local branch current latest
  branch=${CFG[SELFHOST_BRANCH]:-main}
  head_line "Checking for updates"
  git -C "$ROOT_DIR" fetch --quiet origin "$branch" || die "Could not reach GitHub to check for updates."
  current=$(git -C "$ROOT_DIR" rev-parse HEAD)
  latest=$(git -C "$ROOT_DIR" rev-parse "origin/$branch")
  if [ "$current" = "$latest" ]; then
    ok "Already up to date ($(short))"
    [ "$REBUILD" = 1 ] || [ "$FULL" = 1 ] || exit 0
    say "  Rebuilding anyway."
  else
    say "  New changes since your version ($(short)):"
    git -C "$ROOT_DIR" log --oneline --no-decorate "HEAD..origin/$branch" | head -25 | sed 's/^/    /'
  fi
  [ "$YES" = 1 ] || confirm "Update now? The site is briefly unavailable while it restarts." Y UPDATE || exit 0

  backup_database
  tag_rollback_images "$(short)"
  record_state "$current" "$BACKUP_FILE"

  if [ "$current" != "$latest" ]; then
    if ! git -C "$ROOT_DIR" merge --quiet --ff-only "origin/$branch" 2>/dev/null; then
      # The tree is clean (checked above), so nothing of the owner's is lost.
      warn "The upstream history was rewritten; resetting to it."
      git -C "$ROOT_DIR" reset --quiet --hard "origin/$branch"
    fi
    ok "Code updated to $(short)"
  fi
  # Hand over to the NEW update.sh, so each release's own build and migration
  # steps are what run. --after-pull is a stable interface between versions.
  local args=(--after-pull)
  [ "$FULL" = 1 ] && args+=(--full)
  [ "$YES" = 1 ] && args+=(--yes)
  exec bash "$ROOT_DIR/update.sh" "${args[@]}"
}

# ── Stage 2: the new script builds, starts and verifies ───────────────────────
stage_apply() {
  local prev
  prev=$(state_value PREV_SHA)
  apply_env_defaults || true
  CFG[SELFHOST_VERSION]=$(short)
  write_env
  render_caddyfile

  head_line "Building the new version"
  local build_args=(--pull)
  [ "$FULL" = 1 ] && build_args+=(--no-cache)
  if ! dc build "${build_args[@]}"; then
    err "The build failed. The site is still running the previous version."
    restore_previous_code "$prev"
    exit 1
  fi
  # The printer's slicing profiles come from the new image's OrcaSlicer presets
  # (and installs from before printer choice get their Bambu Lab A1 set here).
  if ! generate_printer_profiles; then
    err "The site is still running the previous version."
    restore_previous_code "$prev"
    exit 1
  fi

  head_line "Restarting"
  # migrate runs first (web and worker depend on it), applying any new
  # database migrations before the new code starts. `up` itself fails when a
  # container a dependency waits on turns unhealthy — that is the same verdict
  # as a failed health check, and must reach the rollback below, not end here.
  if dc up -d --remove-orphans && wait_healthy 420; then
    docker image prune -f >/dev/null 2>&1 || true
    ok "Updated to $(short)"
    say "  If anything looks wrong: sudo $ROOT_DIR/update.sh --rollback"
    return 0
  fi

  err "The new version did not come up."
  if [ "$YES" = 1 ] || confirm "Roll back to the previous version now?" Y ROLLBACK; then
    rollback
  else
    say "  Left as is. Roll back later with: sudo $ROOT_DIR/update.sh --rollback"
  fi
  exit 1
}

state_value() { sed -n "s/^$1=//p" "$STATE_FILE" 2>/dev/null | head -n1; }

# After a failed build nothing was restarted: only the code needs to go back.
restore_previous_code() {
  [ -n "${1:-}" ] || return 0
  git -C "$ROOT_DIR" reset --quiet --hard "$1"
  say "  Code put back to $(short)."
}

rollback() {
  local prev sha backup svc
  [ -f "$STATE_FILE" ] || die "There is no earlier version to roll back to."
  prev=$(state_value PREV_SHA)
  backup=$(state_value BACKUP_FILE)
  sha=$(git -C "$ROOT_DIR" rev-parse --short "$prev")
  head_line "Rolling back to $sha"
  for svc in "${SERVICES_BUILT[@]}"; do
    docker image inspect "print-$svc:rollback-$sha" >/dev/null 2>&1 \
      || die "The saved images for $sha are gone (print-$svc:rollback-$sha); can't roll back automatically."
  done
  git -C "$ROOT_DIR" reset --quiet --hard "$prev"
  for svc in "${SERVICES_BUILT[@]}"; do docker tag "print-$svc:rollback-$sha" "print-$svc:latest"; done
  load_env
  CFG[SELFHOST_VERSION]=$sha
  write_env
  render_caddyfile
  dc up -d --remove-orphans --no-build || true
  if wait_healthy 420; then
    ok "Back on $sha"
  else
    err "The previous version didn't come up either."
  fi
  warn "Database changes made by the newer version were NOT undone."
  if [ -n "$backup" ] && [ -f "$backup" ]; then
    say "  If the site misbehaves, restore the backup taken just before the update:"
    say "    cd $ROOT_DIR && docker compose exec -T postgres pg_restore -U ${CFG[POSTGRES_USER]} -d ${CFG[POSTGRES_DB]} --clean --if-exists < $backup"
  fi
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes|-y) YES=1 ;;
      --rebuild) REBUILD=1 ;;
      --full) FULL=1 ;;
      --rollback) ROLLBACK=1 ;;
      --after-pull) AFTER_PULL=1 ;;
      --help|-h) usage; exit 0 ;;
      *) die "Unknown option $1 (try --help)" ;;
    esac
    shift
  done
  [ "$YES" = 1 ] && export PS_UNATTENDED=1
  preflight
  if [ "$ROLLBACK" = 1 ]; then
    [ "$YES" = 1 ] || confirm "Go back to the version before the last update?" N ROLLBACK || exit 0
    rollback
  elif [ "$AFTER_PULL" = 1 ]; then
    stage_apply
  else
    stage_fetch
  fi
}

# Everything above is only definitions, so bash has read the whole file before
# anything runs — the update replacing this file mid-run can't corrupt it.
main "$@"; exit
