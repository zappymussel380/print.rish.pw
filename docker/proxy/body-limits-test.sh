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

for _ in $(seq 1 30); do
  docker exec "proxy-$$" sh -c 'nginx -t' >/dev/null 2>&1 && break
  sleep 1
done

# path <kib> <expected: pass|reject>
check() {
  local path="$1" kib="$2" expect="$3"
  local code
  code=$(docker run --rm --network "$NET" --ip "$CLIENT_IP" "$NGINX_IMAGE" sh -c "
    head -c $((kib * 1024)) /dev/zero > /tmp/body
    curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary @/tmp/body \
      -H 'Content-Type: application/octet-stream' http://proxy-$$:8080$path
  " 2>/dev/null)

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
