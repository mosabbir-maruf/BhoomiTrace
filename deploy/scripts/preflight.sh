#!/usr/bin/env bash
# Refuses to deploy a production stack that is unsafe or ambiguous.
#
#   deploy/scripts/preflight.sh
#   BHOOMITRACE_VERIFY_MODE=true deploy/scripts/preflight.sh   # local harness only
#
# Run it before every deploy (deploy.sh calls it first). Everything checked here
# is a condition that would otherwise fail later, in a more confusing place, or
# silently succeed while being wrong.
#
# Secret values are never printed: the rendered Compose configuration is piped
# straight into jq and only verdicts are logged.
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="preflight"
FAILURES=0
WARNINGS=0

fail() {
  error "$@"
  FAILURES=$((FAILURES + 1))
}
warn_check() {
  warn "$@"
  WARNINGS=$((WARNINGS + 1))
}
ok() { info "ok: $*"; }

require_cmd docker jq awk
require_verify_mode_banner

# ---------------------------------------------------------------------------
# 1. Environment files
# ---------------------------------------------------------------------------
load_config
load_secrets
info "configuration loaded from $STACK_ENV_FILE and $SECRETS_ENV_FILE (values not echoed)"

require_var DOMAIN
require_var CORS_ALLOWED_ORIGINS
require_var BACKEND_IMAGE
require_var FRONTEND_IMAGE
require_var BHOOMITRACE_DATA_DIR
require_var POSTGRES_USER
require_var POSTGRES_DB
require_var POSTGRES_PASSWORD

SECRETS_MODE="$(stat -c '%a' "$SECRETS_ENV_FILE" 2>/dev/null || stat -f '%Lp' "$SECRETS_ENV_FILE")"
if [[ "$SECRETS_MODE" == "600" ]]; then
  ok "secrets file mode is 600"
else
  fail "secrets file mode is $SECRETS_MODE, expected 600"
fi

# A committed secrets file is a disclosure, not a style problem. The check only
# applies when the file is inside the repository; a harness that points the
# scripts at a throwaway file elsewhere is reported, not failed.
if git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  if git -C "$REPO_DIR" check-ignore -q "$SECRETS_ENV_FILE"; then
    ok "secrets file is git-ignored"
  elif [[ "$SECRETS_ENV_FILE" != "$REPO_DIR"/* ]]; then
    warn_check "secrets file is outside the repository; the git-ignore check does not apply"
  else
    fail "secrets file is NOT git-ignored: $SECRETS_ENV_FILE"
  fi
  if git -C "$REPO_DIR" ls-files --error-unmatch "$SECRETS_ENV_FILE" >/dev/null 2>&1; then
    fail "secrets file is tracked by git"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Immutable images
# ---------------------------------------------------------------------------
check_image_reference() {
  local label="$1" ref="$2"
  local digest_tag_ok=false

  if [[ "$ref" =~ @sha256:[0-9a-f]{64}$ ]]; then
    digest_tag_ok=true
  elif [[ "$ref" =~ :sha-[0-9a-f]{40}$ ]]; then
    digest_tag_ok=true
  fi

  if [[ "$ref" == *":latest" ]]; then
    fail "$label must not use the 'latest' tag: $ref"
    return
  fi

  if [[ "$digest_tag_ok" == "true" ]]; then
    ok "$label is immutable: ${ref##*/}"
    return
  fi

  if verify_mode_enabled || [[ "${BHOOMITRACE_ALLOW_MUTABLE_IMAGES:-false}" == "true" ]]; then
    warn_check "$label is a mutable reference (allowed only outside production): $ref"
  else
    fail "$label must be pinned to a full-SHA tag (:sha-<40 hex>) or a digest (@sha256:<64 hex>); got: $ref"
  fi
}

check_image_reference BACKEND_IMAGE "$BACKEND_IMAGE"
check_image_reference FRONTEND_IMAGE "$FRONTEND_IMAGE"

# ---------------------------------------------------------------------------
# 3. Exact HTTPS origin
# ---------------------------------------------------------------------------
EXTERNAL_ORIGINS="${CORS_ALLOWED_ORIGINS//,/ }"
read -r -a ORIGIN_ARRAY <<<"$EXTERNAL_ORIGINS"

# A browser origin is scheme + hostname + port, and the browser omits the port
# only when it is the scheme default. So the expected origin depends on the port
# the edge actually publishes: https://domain on 443, https://domain:PORT
# otherwise. Getting this wrong is exactly how a same-origin SPA ends up
# blocked by CORS, so the check follows the published port rather than assuming
# 443.
EXPECTED_ORIGIN="https://$DOMAIN"
if [[ "${EDGE_HTTPS_PORT:-443}" != "443" ]]; then
  EXPECTED_ORIGIN="https://$DOMAIN:${EDGE_HTTPS_PORT}"
fi

if [[ ${#ORIGIN_ARRAY[@]} -ne 1 ]]; then
  fail "CORS_ALLOWED_ORIGINS must contain exactly one origin in production (found ${#ORIGIN_ARRAY[@]})"
fi
for origin in "${ORIGIN_ARRAY[@]}"; do
  if [[ "$origin" == "*" ]]; then
    fail "CORS_ALLOWED_ORIGINS must not contain a wildcard"
  fi
  if [[ "$origin" != https://* ]]; then
    fail "CORS_ALLOWED_ORIGINS entry is not HTTPS: $origin"
  fi
  if [[ "$origin" == */ ]]; then
    fail "CORS_ALLOWED_ORIGINS entry must not have a trailing slash: $origin"
  fi
  if [[ "$origin" != "$EXPECTED_ORIGIN" ]]; then
    fail "CORS_ALLOWED_ORIGINS entry ($origin) must be exactly $EXPECTED_ORIGIN for DOMAIN=$DOMAIN with EDGE_HTTPS_PORT=${EDGE_HTTPS_PORT:-443}"
  fi
done

if [[ "$DOMAIN" == "bhoomitrace.example.org" || "$DOMAIN" == *"example."* ]]; then
  if verify_mode_enabled; then
    warn_check "DOMAIN is a placeholder ($DOMAIN); allowed in verification mode"
  else
    fail "DOMAIN is still the placeholder value: $DOMAIN"
  fi
fi
if [[ "$DOMAIN" == "localhost" || "$DOMAIN" == 127.0.0.1 ]] && ! verify_mode_enabled; then
  fail "DOMAIN must be a public hostname for a production deployment: $DOMAIN"
fi

# ---------------------------------------------------------------------------
# 4. TLS material
# ---------------------------------------------------------------------------
TLS_DIR="${BHOOMITRACE_TLS_DIR:-$BHOOMITRACE_DATA_DIR/tls}"
FULLCHAIN="$TLS_DIR/fullchain.pem"
PRIVKEY="$TLS_DIR/privkey.pem"

if [[ ! -f "$FULLCHAIN" || ! -f "$PRIVKEY" ]]; then
  fail "no TLS certificate pair at $TLS_DIR/fullchain.pem + privkey.pem — run scripts/issue-certificate.sh first"
else
  require_cmd openssl
  if openssl x509 -in "$FULLCHAIN" -noout -checkend 0 >/dev/null 2>&1; then
    ok "certificate is currently valid (not expired)"
  else
    fail "certificate at $FULLCHAIN is expired or unreadable"
  fi

  if openssl x509 -in "$FULLCHAIN" -noout -checkend 1209600 >/dev/null 2>&1; then
    :
  else
    warn_check "certificate expires within 14 days; renew it before the demo"
  fi

  SAN="$(certificate_san "$FULLCHAIN")"
  CN="$(openssl x509 -in "$FULLCHAIN" -noout -subject 2>/dev/null | sed -n 's/.*CN *= *//p' || true)"
  if printf '%s' "$SAN" | grep -qF "DNS:$DOMAIN"; then
    ok "certificate SAN covers $DOMAIN"
  elif [[ "$CN" == "$DOMAIN" && -z "$SAN" ]]; then
    warn_check "certificate has CN=$DOMAIN but no subjectAltName; modern clients require a SAN"
  else
    fail "certificate does not cover $DOMAIN (SAN: ${SAN:-none}, CN: ${CN:-none})"
  fi

  # Key/certificate pairing. Both reads are root-only by design.
  CERT_PUB="$(openssl x509 -in "$FULLCHAIN" -noout -pubkey 2>/dev/null | public_key_digest || true)"
  KEY_PUB="$(openssl pkey -in "$PRIVKEY" -pubout 2>/dev/null | public_key_digest || true)"
  if [[ -n "$CERT_PUB" && "$CERT_PUB" == "$KEY_PUB" ]]; then
    ok "private key matches the certificate"
  else
    fail "private key does not match the certificate (or one of them is unreadable)"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Persistent directories
# ---------------------------------------------------------------------------
for dir in postgres uploads; do
  path="$BHOOMITRACE_DATA_DIR/$dir"
  if [[ -d "$path" ]]; then
    ok "data directory present: $path"
  else
    fail "missing data directory $path — run deploy/scripts/prepare-host.sh"
  fi
done

if [[ -d "$BHOOMITRACE_DATA_DIR" ]]; then
  DATA_FS="$(df -PT "$BHOOMITRACE_DATA_DIR" | awk 'NR==2 {print $1}')"
  ROOT_FS="$(df -PT / | awk 'NR==2 {print $1}')"
  if [[ "$DATA_FS" == "$ROOT_FS" ]]; then
    if verify_mode_enabled || [[ "${BHOOMITRACE_ALLOW_ROOT_FS:-false}" == "true" ]]; then
      warn_check "$BHOOMITRACE_DATA_DIR is on the root filesystem ($DATA_FS)"
    else
      fail "$BHOOMITRACE_DATA_DIR is on the root filesystem ($DATA_FS); mount the EBS data volume there"
    fi
  else
    ok "$BHOOMITRACE_DATA_DIR is on a dedicated filesystem ($DATA_FS)"
  fi
fi

# ---------------------------------------------------------------------------
# 6. Rendered Compose configuration
# ---------------------------------------------------------------------------
CONFIG_JSON="$(compose config --format json 2>/dev/null)" || fail "docker compose config failed; run scripts/compose.sh config to see why"

if [[ -n "$CONFIG_JSON" ]]; then
  # Only edge publishes ports. This is the guard that keeps PostgreSQL and the
  # API off the public internet.
  PUBLISHING="$(printf '%s' "$CONFIG_JSON" | jq -r '[.services | to_entries[] | select((.value.ports // []) | length > 0) | .key] | sort | join(",")')"
  if [[ "$PUBLISHING" == "edge" ]]; then
    ok "only the edge proxy publishes ports"
  else
    fail "services publishing ports must be exactly [edge]; found [$PUBLISHING]"
  fi

  for service in api worker migrate; do
    for pair in NODE_ENV=production COOKIE_SECURE=true TRUST_PROXY=true UPLOAD_DIR=/data/uploads; do
      key="${pair%%=*}"
      want="${pair#*=}"
      got="$(printf '%s' "$CONFIG_JSON" | jq -r --arg s "$service" --arg k "$key" '.services[$s].environment[$k] // ""')"
      if [[ "$got" == "$want" ]]; then
        ok "$service $key=$want"
      else
        fail "$service $key is '$got', must be '$want'"
      fi
    done
  done

  # The API and worker must read and write the very same host directory.
  API_UPLOAD_SRC="$(printf '%s' "$CONFIG_JSON" | jq -r '[.services.api.volumes[] | select(.target == "/data/uploads") | .source] | first // ""')"
  WORKER_UPLOAD_SRC="$(printf '%s' "$CONFIG_JSON" | jq -r '[.services.worker.volumes[] | select(.target == "/data/uploads") | .source] | first // ""')"
  if [[ -n "$API_UPLOAD_SRC" && "$API_UPLOAD_SRC" == "$WORKER_UPLOAD_SRC" ]]; then
    ok "api and worker share the upload directory ($API_UPLOAD_SRC)"
  else
    fail "api and worker upload mounts differ (api='$API_UPLOAD_SRC' worker='$WORKER_UPLOAD_SRC')"
  fi

  # Rendered images must match the configured immutable references.
  RENDERED_BACKEND="$(printf '%s' "$CONFIG_JSON" | jq -r '.services.api.image // ""')"
  RENDERED_FRONTEND="$(printf '%s' "$CONFIG_JSON" | jq -r '.services.frontend.image // ""')"
  [[ "$RENDERED_BACKEND" == "$BACKEND_IMAGE" ]] || fail "rendered backend image ($RENDERED_BACKEND) does not match BACKEND_IMAGE"
  [[ "$RENDERED_FRONTEND" == "$FRONTEND_IMAGE" ]] || fail "rendered frontend image ($RENDERED_FRONTEND) does not match FRONTEND_IMAGE"

  RENDERED_CORS="$(printf '%s' "$CONFIG_JSON" | jq -r '.services.api.environment.CORS_ALLOWED_ORIGINS // ""')"
  [[ "$RENDERED_CORS" == "$CORS_ALLOWED_ORIGINS" ]] || fail "api CORS_ALLOWED_ORIGINS ('$RENDERED_CORS') does not match stack.env ('$CORS_ALLOWED_ORIGINS')"

  RENDERED_DOMAIN="$(printf '%s' "$CONFIG_JSON" | jq -r '.services.edge.environment.DOMAIN // ""')"
  [[ "$RENDERED_DOMAIN" == "$DOMAIN" ]] || fail "edge DOMAIN ('$RENDERED_DOMAIN') does not match stack.env ('$DOMAIN')"

  # Secrets must not appear in a rendered env var we did not intend, and the
  # database URL must never be a development default.
  if printf '%s' "$CONFIG_JSON" | jq -r '.services.api.environment.DATABASE_URL // ""' | grep -q "bhoomitrace:bhoomitrace@"; then
    fail "api DATABASE_URL is using the example development credentials"
  fi

  # The synthetic-data seed service must stay behind the demo profile. Rendered
  # with the profile enabled, because Compose hides profiled services otherwise.
  SEED_PROFILES="$(compose --profile demo config --format json 2>/dev/null | jq -r '.services.seed.profiles // [] | join(",")' 2>/dev/null || echo '')"
  if [[ "$SEED_PROFILES" == "demo" ]]; then
    ok "seed service is confined to the 'demo' profile"
  else
    fail "seed service must declare profiles: [demo] (found: '$SEED_PROFILES')"
  fi
fi

# ---------------------------------------------------------------------------
# 7. Docker availability
# ---------------------------------------------------------------------------
if docker info >/dev/null 2>&1; then
  ok "docker daemon reachable"
else
  fail "docker daemon is not reachable"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [[ "$FAILURES" -gt 0 ]]; then
  die "preflight failed with $FAILURES error(s) and $WARNINGS warning(s)"
fi

info "preflight passed with $WARNINGS warning(s)"

# Non-fatal but worth saying out loud on every production run.
if verify_mode_enabled; then
  banner "PREFLIGHT PASSED IN VERIFICATION MODE — this is NOT a production acceptance."
else
  info "single-host deployment: no high availability. EBS is not a backup. Confirm the backup timer and S3 lifecycle are in place."
fi
