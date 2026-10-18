#!/usr/bin/env bash
# Health and capacity check for the running production stack.
#
#   deploy/scripts/health-check.sh
#   deploy/scripts/health-check.sh --skip-public          # skip DNS/TLS checks
#   deploy/scripts/health-check.sh --insecure --base-url https://localhost:8443
#
# Exit status is 0 only when every check that ran passed. Checks that could not
# run (no public DNS yet, for example) are reported as SKIP, never as PASS.
#
# Checks performed:
#   * container health, including the one-shot migration container's exit code
#   * API readiness  GET /health        (database connectivity included)
#   * API liveness   GET /health/live   (process only)
#   * worker process liveness
#   * frontend reachability (inside the network, and through the edge over TLS)
#   * API reachability through the edge (unauthenticated 401, not a 404/502)
#   * HTTP -> HTTPS redirect on port 80
#   * disk space on the data volume and on /
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="health-check"

SKIP_PUBLIC=false
INSECURE=false
BASE_URL=""
WARN_DISK_PCT="${HEALTH_WARN_DISK_PCT:-80}"
FAIL_DISK_PCT="${HEALTH_FAIL_DISK_PCT:-92}"
FAILURES=0
SKIPS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-public) SKIP_PUBLIC=true; shift ;;
    --insecure) INSECURE=true; shift ;;
    --base-url)
      [[ $# -ge 2 ]] || die "--base-url needs a value"
      BASE_URL="$2"
      shift 2
      ;;
    --warn-disk-pct)
      [[ $# -ge 2 ]] || die "--warn-disk-pct needs a value"
      WARN_DISK_PCT="$2"
      shift 2
      ;;
    --fail-disk-pct)
      [[ $# -ge 2 ]] || die "--fail-disk-pct needs a value"
      FAIL_DISK_PCT="$2"
      shift 2
      ;;
    -h | --help)
      echo "Usage: health-check.sh [--skip-public] [--insecure] [--base-url URL]" >&2
      exit 0
      ;;
    *) die "unexpected argument: $1" ;;
  esac
done

require_cmd docker jq
load_config
require_var DOMAIN

BASE_URL="${BASE_URL:-https://${DOMAIN}}"
if verify_mode_enabled && [[ "$BASE_URL" == "https://$DOMAIN" ]]; then
  BASE_URL="https://${DOMAIN}:${EDGE_HTTPS_PORT:-443}"
fi

pass() { info "PASS  $*"; }
failed() {
  error "FAIL  $*"
  FAILURES=$((FAILURES + 1))
}
skipped() {
  warn "SKIP  $*"
  SKIPS=$((SKIPS + 1))
}

info "health check start (base_url=$BASE_URL)"
require_verify_mode_banner

# A verification run has no real hostname, so its certificate is necessarily
# self-signed and chain verification cannot succeed. That is a host property
# and is the only thing relaxed here: the edge must still answer over HTTPS.
# Production (no verification mode) requires a certificate that verifies.
if [[ "$INSECURE" != "true" ]] && verify_mode_enabled; then
  INSECURE=true
  warn "verification mode: certificate chain verification is skipped (self-signed certificate)"
fi

# ---------------------------------------------------------------------------
# 1. Container state and health
# ---------------------------------------------------------------------------
PS_JSON="$(compose_ps_json 2>/dev/null || true)"
if [[ -z "$PS_JSON" || "$PS_JSON" == "[]" ]]; then
  failed "docker compose ps returned nothing; is the stack running?"
else
  for service in postgres api worker frontend edge; do
    LINE="$(printf '%s' "$PS_JSON" | jq -c --arg s "$service" '[.[] | select(.Service == $s)] | first // empty' 2>/dev/null || true)"
    if [[ -z "$LINE" ]]; then
      failed "service $service is not present in the stack"
      continue
    fi
    STATE="$(printf '%s' "$LINE" | jq -r '.State // ""')"
    HEALTH="$(printf '%s' "$LINE" | jq -r '.Health // ""')"
    if [[ "$STATE" != "running" ]]; then
      failed "service $service state=$STATE (expected running)"
    elif [[ -n "$HEALTH" && "$HEALTH" != "healthy" ]]; then
      failed "service $service health=$HEALTH (expected healthy)"
    else
      pass "service $service running${HEALTH:+, health=$HEALTH}"
    fi
  done

  MIGRATE="$(printf '%s' "$PS_JSON" | jq -c '[.[] | select(.Service == "migrate")] | first // empty' 2>/dev/null || true)"
  if [[ -z "$MIGRATE" ]]; then
    skipped "migration container not present (already removed); run scripts/compose.sh run --rm migrate to verify"
  else
    M_STATE="$(printf '%s' "$MIGRATE" | jq -r '.State // ""')"
    M_EXIT="$(printf '%s' "$MIGRATE" | jq -r '.ExitCode // ""')"
    if [[ "$M_STATE" == "exited" && "$M_EXIT" == "0" ]]; then
      pass "migration container exited 0"
    else
      failed "migration container state=$M_STATE exit=$M_EXIT (expected exited 0)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 2. API readiness and liveness (from inside the network)
# ---------------------------------------------------------------------------
api_probe() {
  local path="$1"
  compose exec -T api node -e "
    fetch('http://127.0.0.1:3000${path}')
      .then(async (r) => { const body = await r.text(); process.stdout.write(r.status + ' ' + body) })
      .catch((e) => { process.stdout.write('error ' + e.message) })
  " 2>/dev/null
}

READINESS="$(api_probe /health || true)"
if [[ "$READINESS" == 200*'{"status":"ok"'* ]]; then
  pass "API readiness /health -> 200 ($(printf '%s' "$READINESS" | cut -c5-120))"
elif [[ "$READINESS" == 503* ]]; then
  failed "API readiness /health -> 503 (database unreachable): $(printf '%s' "$READINESS" | cut -c5-160)"
else
  failed "API readiness /health returned: ${READINESS:-no response}"
fi

LIVENESS="$(api_probe /health/live || true)"
if [[ "$LIVENESS" == 200* ]]; then
  pass "API liveness /health/live -> 200"
else
  failed "API liveness /health/live returned: ${LIVENESS:-no response}"
fi

# ---------------------------------------------------------------------------
# 3. Worker process liveness
# ---------------------------------------------------------------------------
if compose exec -T worker node -e "
  const fs = process.getBuiltinModule('node:fs');
  const alive = fs.readdirSync('/proc')
    .filter((e) => /^[0-9]+$/.test(e))
    .some((pid) => { try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').includes('worker/main.js') } catch { return false } });
  process.exit(alive ? 0 : 1)
" >/dev/null 2>&1; then
  pass "worker process is alive"
else
  failed "worker process is not running inside its container"
fi

# ---------------------------------------------------------------------------
# 4. Frontend reachability inside the network
# ---------------------------------------------------------------------------
FRONTEND_BODY="$(compose exec -T frontend wget -q -O- http://127.0.0.1:8080/ 2>/dev/null || true)"
if printf '%s' "$FRONTEND_BODY" | grep -q '<div id="root"'; then
  pass "frontend serves the SPA on :8080 inside the network"
else
  failed "frontend did not return the SPA document from :8080"
fi

# ---------------------------------------------------------------------------
# 5. Public path through the edge (TLS)
# ---------------------------------------------------------------------------
if [[ "$SKIP_PUBLIC" == "true" ]]; then
  skipped "public TLS path checks (--skip-public)"
else
  require_cmd curl
  CURL_TLS=(-sS)
  [[ "$INSECURE" == "true" ]] && CURL_TLS+=(-k)

  EDGE_CODE="$(curl "${CURL_TLS[@]}" -o /dev/null -w '%{http_code}' --max-time 15 "$BASE_URL/healthz" || echo 000)"
  if [[ "$EDGE_CODE" == "200" ]]; then
    pass "edge /healthz -> 200 over TLS"
  else
    failed "edge /healthz -> $EDGE_CODE (expected 200 at $BASE_URL)"
  fi

  SPA_CODE="$(curl "${CURL_TLS[@]}" -o /dev/null -w '%{http_code}' --max-time 20 "$BASE_URL/" || echo 000)"
  if [[ "$SPA_CODE" == "200" ]]; then
    pass "edge serves the SPA at $BASE_URL/"
  else
    failed "edge / -> $SPA_CODE (expected 200)"
  fi

  API_CODE="$(curl "${CURL_TLS[@]}" -o /dev/null -w '%{http_code}' --max-time 20 "$BASE_URL/api/v1/auth/me" || echo 000)"
  if [[ "$API_CODE" == "401" ]]; then
    pass "edge proxies /api/ to the API (unauthenticated -> 401)"
  else
    failed "edge /api/v1/auth/me -> $API_CODE (expected 401; 404/502 means the proxy is broken)"
  fi

  HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "http://${DOMAIN}:${EDGE_HTTP_PORT:-80}/" || echo 000)"
  if [[ "$HTTP_CODE" == "301" || "$HTTP_CODE" == "308" ]]; then
    pass "plain HTTP redirects to HTTPS ($HTTP_CODE)"
  else
    failed "http://${DOMAIN}/ -> $HTTP_CODE (expected a 301 redirect)"
  fi
fi

# ---------------------------------------------------------------------------
# 6. Disk space
# ---------------------------------------------------------------------------
check_disk() {
  local path="$1" label="$2"
  [[ -e "$path" ]] || { skipped "disk $label: $path does not exist"; return 0; }
  local pct avail
  pct="$(disk_usage_percent "$path")"
  avail="$(disk_available_kib "$path")"
  local avail_h

  avail_h="$(human_avail "$avail")"
  if [[ "$pct" -ge "$FAIL_DISK_PCT" ]]; then
    failed "disk $label ($path) is ${pct}% full (>= ${FAIL_DISK_PCT}%), ${avail_h} free"
  elif [[ "$pct" -ge "$WARN_DISK_PCT" ]]; then
    warn "WARN  disk $label ($path) is ${pct}% full, ${avail_h} free"
  else
    pass "disk $label ($path) is ${pct}% full, ${avail_h} free"
  fi
}

human_avail() {
  awk -v k="$1" 'BEGIN { printf "%.1f GiB", k / 1048576 }'
}

check_disk "${BHOOMITRACE_DATA_DIR:-/}" "data volume"
check_disk "/" "root filesystem"
# The Docker data root is where images and container layers live. It is often on
# /, but when it is not, it has its own pressure to watch.
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo '')"
if [[ -n "$DOCKER_ROOT" && "$DOCKER_ROOT" != /* ]]; then
  DOCKER_ROOT=""
fi
if [[ -n "$DOCKER_ROOT" && "$DOCKER_ROOT" != "${BHOOMITRACE_DATA_DIR:-/nonexistent}" ]]; then
  check_disk "$DOCKER_ROOT" "docker data root"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
info "health check finished: failures=$FAILURES skips=$SKIPS"
if [[ "$FAILURES" -gt 0 ]]; then
  error "HEALTH RESULT: FAILURE failures=$FAILURES skips=$SKIPS"
  publish_metric HealthCheckFailure "$FAILURES"
  exit 1
fi

publish_metric HealthCheckFailure 0
info "HEALTH RESULT: SUCCESS skips=$SKIPS"
