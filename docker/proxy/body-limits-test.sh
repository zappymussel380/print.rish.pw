#!/usr/bin/env bash
# Assert the proxy's per-route request-body policy.
#
# The server block caps bodies at 64k on purpose, and each route that legitimately
# accepts more must opt in. A route that forgets to is not a syntax error and
# nginx -t cannot see it: the endpoint simply returns 413 for every real payload,
# with no application log line to explain it, because the request never reaches
# the app. That is exactly how the showcase photo upload shipped broken.
#
# Runs the REAL docker/proxy/nginx.conf against a stub upstream, so what is
# asserted is the shipped configuration rather than a copy of it.
set -euo pipefail

NGINX_IMAGE="${NGINX_IMAGE:-nginx:alpine}"
NET="proxy-body-limits-$$"
SUBNET="172.31.240.0/24"
CLIENT_IP="172.31.240.10"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
failures=0

cleanup() {
  docker rm -f "stub-$$" "proxy-$$" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create --subnet "$SUBNET" "$NET" >/dev/null

# Any response that is not nginx's own 413 proves the body reached the upstream.
# The stub must not impose a limit of its own: nginx defaults to 1 MiB, which
# would masquerade as the proxy rejecting a large-but-allowed body.
docker run -d --name "stub-$$" --network "$NET" --network-alias web "$NGINX_IMAGE" \
  sh -c 'printf "server{listen 3000;client_max_body_size 0;location /{return 204;}}" > /etc/nginx/conf.d/default.conf; exec nginx -g "daemon off;"' >/dev/null

docker run -d --name "proxy-$$" --network "$NET" \
  -e TRUSTED_PROXY_CIDR="$CLIENT_IP/32" \
  -v "$repo/docker/proxy/05-validate-trusted-proxy.sh:/docker-entrypoint.d/05-validate-trusted-proxy.sh:ro" \
  -v "$repo/docker/proxy/nginx.conf:/etc/nginx/templates/default.conf.template:ro" \
  "$NGINX_IMAGE" >/dev/null

# Wait for the listener, not for the config.
#
# `nginx -t` only proves the template rendered — it runs a throwaway process and
# says nothing about whether the master has bound :8080, or whether the stub
# upstream is answering yet. Breaking on it raced the real thing into being, and
# the first check then died on a bare "connection refused" with nothing to say
# why. Probe both hops for an actual HTTP status line instead.
probe() { # container url
  docker exec "$1" sh -c "wget -q -S -O /dev/null -T 2 -t 1 '$2' 2>&1 | grep -q 'HTTP/'"
}

ready=""
for _ in $(seq 1 60); do
  if probe "stub-$$" http://127.0.0.1:3000/ && probe "proxy-$$" http://127.0.0.1:8080/; then
    ready=yes
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "proxy or stub never came up; logs follow" >&2
  docker logs "stub-$$" 2>&1 | tail -20 >&2
  docker logs "proxy-$$" 2>&1 | tail -20 >&2
  exit 1
fi

# path <kib> <expected: pass|reject>
check() {
  local path="$1" kib="$2" expect="$3"
  local code
  # `|| true` so a transport failure is reported as a failed expectation with
  # the code it got, rather than tripping `set -e` and ending the run on a bare
  # exit status with no indication of which check died.
  code=$(docker run --rm --network "$NET" --ip "$CLIENT_IP" "$NGINX_IMAGE" sh -c "
    head -c $((kib * 1024)) /dev/zero > /tmp/body
    curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary @/tmp/body \
      -H 'Content-Type: application/octet-stream' http://proxy-$$:8080$path
  " 2>/dev/null || true)

  if [ -z "$code" ] || [ "$code" = "000" ]; then
    printf '  FAIL  %-28s %5sKiB -> no response from the proxy\n' "$path" "$kib"
    failures=$((failures + 1))
    return
  fi

  local got="pass"
  [ "$code" = "413" ] && got="reject"
  if [ "$got" = "$expect" ]; then
    printf '  ok    %-28s %5sKiB -> %s (%s)\n' "$path" "$kib" "$code" "$expect"
  else
    printf '  FAIL  %-28s %5sKiB -> %s (wanted %s)\n' "$path" "$kib" "$code" "$expect"
    failures=$((failures + 1))
  fi
}

echo "proxy request-body policy:"
# Ordinary JSON endpoints stay clamped to the tight server default.
check /api/quotations 10 pass
check /api/quotations 200 reject
# Model uploads carry the large transport allowance.
check /api/uploads 200 pass
# Admin showcase photos: the app caps these at 8 MiB and returns its own JSON
# error, so the proxy must let a real photo through to reach that check.
check /api/admin/showcase 10 pass
check /api/admin/showcase 200 pass
check /api/admin/showcase 4096 pass
# ...but not without limit.
check /api/admin/showcase 20480 reject

if [ "$failures" -ne 0 ]; then
  echo "$failures body-limit expectation(s) failed" >&2
  exit 1
fi
echo "all body-limit expectations hold"
