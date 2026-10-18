#!/usr/bin/env bash
# certbot deploy hook: publishes the renewed certificate where the edge proxy
# expects it, then reloads nginx.
#
# certbot calls this after a successful issuance or renewal, with
# RENEWED_LINEAGE pointing at /etc/letsencrypt/live/<domain>. It is also safe to
# run by hand:
#
#   sudo RENEWED_LINEAGE=/etc/letsencrypt/live/example.org deploy/scripts/tls-deploy-hook.sh
#
# Why a flat copy instead of mounting /etc/letsencrypt into the proxy: the
# container then depends on certbot's directory layout, symlink farm, and
# renewal timing. A flat pair (fullchain.pem + privkey.pem) is the smallest
# possible contract between the two, and it is read-only inside the container.
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="tls-deploy-hook"

load_config
require_var BHOOMITRACE_TLS_DIR

LINEAGE="${RENEWED_LINEAGE:-}"
if [[ -z "$LINEAGE" ]]; then
  # Allow a manual run: newest lineage wins.
  LINEAGE="$(find /etc/letsencrypt/live -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1 || true)"
fi
[[ -n "$LINEAGE" ]] || die "no certificate lineage found (set RENEWED_LINEAGE or issue a certificate first)"

require_file "$LINEAGE/fullchain.pem" "certificate chain"
require_file "$LINEAGE/privkey.pem" "private key"

install -d -m 700 "$BHOOMITRACE_TLS_DIR"
# Copy rather than symlink: a symlink into /etc/letsencrypt would dangle inside
# the container, which mounts only the destination directory.
install -m 644 "$LINEAGE/fullchain.pem" "$BHOOMITRACE_TLS_DIR/fullchain.pem"
install -m 600 "$LINEAGE/privkey.pem" "$BHOOMITRACE_TLS_DIR/privkey.pem"
chown root:root "$BHOOMITRACE_TLS_DIR/fullchain.pem" "$BHOOMITRACE_TLS_DIR/privkey.pem" 2>/dev/null || true

DOMAIN_TO_CHECK="${DOMAIN:-}"
if [[ -n "$DOMAIN_TO_CHECK" ]]; then
  if certificate_san "$BHOOMITRACE_TLS_DIR/fullchain.pem" | grep -qF "DNS:$DOMAIN_TO_CHECK"; then
    info "published certificate covers $DOMAIN_TO_CHECK"
  else
    warn "published certificate does not list $DOMAIN_TO_CHECK in its SAN"
  fi
fi

# Reload rather than restart: a reload picks up the new certificate without
# dropping in-flight requests.
if compose exec -T edge nginx -s reload >/dev/null 2>&1; then
  info "edge proxy reloaded with the new certificate"
else
  warn "could not reload the edge proxy (it may not be running yet); run: scripts/compose.sh exec edge nginx -s reload"
fi

info "TLS DEPLOY RESULT: SUCCESS lineage=$LINEAGE dest=$BHOOMITRACE_TLS_DIR"
