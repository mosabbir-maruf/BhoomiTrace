#!/usr/bin/env bash
# Obtains a Let's Encrypt certificate for DOMAIN and installs it for the edge
# proxy.
#
#   sudo deploy/scripts/issue-certificate.sh --email ops@example.org
#   sudo deploy/scripts/issue-certificate.sh --email ops@example.org --staging
#
# Preconditions this script checks instead of assuming:
#   * DOMAIN resolves to this host's public address
#   * port 80 is reachable from the internet (HTTP-01 challenge)
#   * the edge proxy is up, publishing a placeholder certificate if none exists
#     yet, so the challenge can actually be served
#
# If any precondition is unmet the script stops and says which one. It never
# leaves the system claiming to serve HTTPS with a certificate it did not verify.
#
# This is a one-time bootstrap plus an annual renewal. Renewal is automated by
# deploy/systemd/bhoomitrace-cert-renew.timer.
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="issue-certificate"

EMAIL=""
STAGING=false
SKIP_DNS_CHECK=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)
      [[ $# -ge 2 ]] || die "--email needs a value"
      EMAIL="$2"
      shift 2
      ;;
    --staging) STAGING=true; shift ;;
    --skip-dns-check) SKIP_DNS_CHECK=true; shift ;;
    -h | --help)
      cat >&2 <<'EOF'
Usage: issue-certificate.sh --email ADDRESS [--staging] [--skip-dns-check]

  --staging         use the Let's Encrypt staging endpoint (untrusted certificate,
                    for rehearsing the flow without burning rate limits)
  --skip-dns-check  skip the DNS resolution precondition

Requires: certbot on the host, port 80 open to the internet, DOMAIN in stack.env.
EOF
      exit 0
      ;;
    *) die "unexpected argument: $1" ;;
  esac
done

require_cmd openssl docker
load_config
require_var DOMAIN
require_var BHOOMITRACE_TLS_DIR

TLS_DIR="$BHOOMITRACE_TLS_DIR"
ACME_DIR="${BHOOMITRACE_DATA_DIR}/acme"

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
if [[ -z "$EMAIL" ]]; then
  die "--email is required (Let's Encrypt needs a contact address for expiry notices)"
fi

if ! command -v certbot >/dev/null 2>&1; then
  if verify_mode_enabled; then
    warn "certbot is not installed (verification mode: expected; no real certificate can be issued here)"
  else
    die "certbot is not installed. Install it first (Debian/Ubuntu: apt-get install certbot; Amazon Linux: dnf install certbot)"
  fi
fi

if [[ "$STAGING" != "true" && "$DOMAIN" == *"example."* ]] && ! verify_mode_enabled; then
  die "DOMAIN is still the placeholder '$DOMAIN'; set the real hostname in stack.env before requesting a certificate"
fi

if [[ "$SKIP_DNS_CHECK" != "true" ]]; then
  RESOLVED="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)"
  if [[ -z "$RESOLVED" ]]; then
    if verify_mode_enabled; then
      warn "$DOMAIN does not resolve from this host (verification mode)"
    else
      die "$DOMAIN does not resolve. Create the DNS A (or AAAA) record pointing at this host's Elastic IP before requesting a certificate."
    fi
  else
    info "$DOMAIN resolves to $RESOLVED"
    if [[ "$RESOLVED" == 127.* || "$RESOLVED" == "::1" ]]; then
      warn "$DOMAIN resolves to loopback; Let's Encrypt will not be able to reach this host"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Placeholder certificate so the proxy can start and serve the challenge
# ---------------------------------------------------------------------------
# The HTTP-01 challenge needs the edge proxy listening on port 80, but the proxy
# cannot start without a certificate. A short-lived self-signed placeholder
# breaks that cycle. It is clearly not a public certificate: browsers will warn
# until a real one replaces it.
if [[ ! -f "$TLS_DIR/fullchain.pem" || ! -f "$TLS_DIR/privkey.pem" ]]; then
  info "no certificate present; installing a self-signed placeholder so the proxy can serve the ACME challenge"
  install -d -m 700 "$TLS_DIR"
  umask 077
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$TLS_DIR/privkey.pem" \
    -out "$TLS_DIR/fullchain.pem" \
    -days 7 \
    -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN" >/dev/null 2>&1
  chmod 600 "$TLS_DIR/privkey.pem"
  chmod 644 "$TLS_DIR/fullchain.pem"
  warn "PLACEHOLDER CERTIFICATE IN USE — HTTPS is not publicly trusted yet"
else
  info "an existing certificate is present and will be kept until renewal succeeds"
fi

install -d -m 755 "$ACME_DIR"
info "starting the stack so the HTTP challenge can be served on port 80"
compose up -d --no-deps edge || die "could not start the edge proxy; check scripts/compose.sh logs edge"

# Prove the challenge path is actually reachable before asking Let's Encrypt.
info "probing the ACME challenge path"
PROBE_FILE="$ACME_DIR/.probe-$$"
printf 'ok' >"$PROBE_FILE"
chmod 644 "$PROBE_FILE"
PROBE_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://$DOMAIN/.well-known/acme-challenge/$(basename "$PROBE_FILE")" || echo 000)"
rm -f "$PROBE_FILE"
if [[ "$PROBE_CODE" == "200" ]]; then
  info "ACME challenge path is reachable over HTTP"
else
  warn "ACME challenge probe returned $PROBE_CODE (expected 200); issuance will probably fail. Check that port 80 is open in the EC2 security group and that DNS points here."
fi

# ---------------------------------------------------------------------------
# Issue
# ---------------------------------------------------------------------------
if ! command -v certbot >/dev/null 2>&1; then
  warn "certbot unavailable; stopping before issuance"
  info "TLS BOOTSTRAP RESULT: INCOMPLETE (placeholder certificate installed, no real certificate obtained)"
  exit 1
fi

CERTBOT_ARGS=(
  certonly
  --webroot
  --webroot-path "$ACME_DIR"
  --domain "$DOMAIN"
  --email "$EMAIL"
  --agree-tos
  --no-eff-email
  --non-interactive
  --keep-until-expiring
  --deploy-hook "$(dirname "${BASH_SOURCE[0]}")/tls-deploy-hook.sh"
)
[[ "$STAGING" == "true" ]] && CERTBOT_ARGS+=(--staging)

info "requesting a certificate for $DOMAIN${STAGING:+ (staging)}"
if ! certbot "${CERTBOT_ARGS[@]}"; then
  die "certbot failed. The placeholder certificate is still in place; HTTPS is NOT publicly trusted. Fix the reported problem and re-run."
fi

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
require_file "$TLS_DIR/fullchain.pem" "installed certificate"
if openssl x509 -in "$TLS_DIR/fullchain.pem" -noout -checkend 0 >/dev/null 2>&1; then
  info "installed certificate is valid"
else
  die "the published certificate is not valid; do not treat this deployment as securely served"
fi

SAN="$(certificate_san "$TLS_DIR/fullchain.pem")"
if printf '%s' "$SAN" | grep -qF "DNS:$DOMAIN"; then
  info "certificate covers $DOMAIN"
else
  warn "certificate does not list $DOMAIN in its SAN: ${SAN:-none}"
fi

ISSUER="$(openssl x509 -in "$TLS_DIR/fullchain.pem" -noout -issuer 2>/dev/null || true)"
if printf '%s' "$ISSUER" | grep -qi "fake\|staging\|self"; then
  warn "issuer looks non-production: $ISSUER"
  info "TLS BOOTSTRAP RESULT: INCOMPLETE (staging or self-signed certificate in use)"
  exit 1
fi

info "TLS BOOTSTRAP RESULT: SUCCESS issuer=$ISSUER"
info "next: scripts/health-check.sh  (it checks the certificate, the redirect, and the API path)"
