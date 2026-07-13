#!/bin/sh

# Fail before nginx template expansion if the trusted real-IP source is missing,
# broad, malformed, or capable of injecting nginx configuration. This variable
# deliberately accepts one host only; despite its historical CIDR name, network
# prefixes broader than /32 or /128 are not valid here.
set -eu

fail() {
  echo "[proxy] TRUSTED_PROXY_CIDR must be exactly one IPv4 host (optionally /32) or unbracketed IPv6 host (optionally /128)" >&2
  exit 1
}

value=${TRUSTED_PROXY_CIDR:-}
[ -n "$value" ] || fail

# Whitelist the complete grammar before the value is substituted into nginx.conf.
# This rejects whitespace, separators, shell/nginx metacharacters and hostnames.
case "$value" in
  *[!0-9A-Fa-f:./]* | */*/*) fail ;;
esac

address=$value
prefix=
has_prefix=0
case "$value" in
  */*)
    address=${value%/*}
    prefix=${value##*/}
    has_prefix=1
    ;;
esac
[ -n "$address" ] || fail

case "$address" in
  *:*)
    # Brackets and zone identifiers are intentionally unsupported. `getent`
    # delegates the hard IPv6 grammar (including embedded IPv4) to inet_pton.
    if [ "$has_prefix" -eq 1 ] && [ "$prefix" != "128" ]; then
      fail
    fi
    getent ahosts "$address" 2>/dev/null \
      | awk '$1 ~ /:/ { valid = 1 } END { exit valid ? 0 : 1 }' \
      >/dev/null || fail
    ;;
  *)
    if [ "$has_prefix" -eq 1 ] && [ "$prefix" != "32" ]; then
      fail
    fi
    printf '%s\n' "$address" | awk -F. '
      NF != 4 { exit 1 }
      {
        for (i = 1; i <= 4; i++) {
          if ($i !~ /^[0-9]+$/ || length($i) > 3 || ($i + 0) > 255) exit 1
        }
      }
    ' >/dev/null || fail
    ;;
esac

echo "[proxy] Trusted forwarder validated: $value"
