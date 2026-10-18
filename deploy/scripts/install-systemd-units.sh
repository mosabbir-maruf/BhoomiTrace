#!/usr/bin/env bash
# Installs the systemd units and timers on the host.
#
#   sudo deploy/scripts/install-systemd-units.sh
#   sudo deploy/scripts/install-systemd-units.sh --enable      # also start timers
#   sudo deploy/scripts/install-systemd-units.sh --uninstall
#
# Copying units and enabling timers are separate steps on purpose: a first-time
# install should be inspectable (`systemctl list-timers`) before anything runs
# unattended.
#
# The units assume the repository is at /opt/bhoomitrace and the data directory is
# /srv/bhoomitrace. Override per host without editing the units:
#
#   sudo install -d -m 755 /etc/bhoomitrace
#   printf 'BHOOMITRACE_DATA_DIR=/srv/bhoomitrace\n' | sudo tee /etc/bhoomitrace/deploy.env
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="install-systemd-units"

ENABLE=false
UNINSTALL=false
UNITS_DIR="/etc/systemd/system"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --enable) ENABLE=true; shift ;;
    --uninstall) UNINSTALL=true; shift ;;
    -h | --help)
      echo "Usage: install-systemd-units.sh [--enable] [--uninstall]" >&2
      exit 0
      ;;
    *) die "unexpected argument: $1" ;;
  esac
done

require_cmd systemctl
require_root

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../systemd" && pwd)"
UNITS=(
  bhoomitrace-backup.service
  bhoomitrace-backup.timer
  bhoomitrace-health.service
  bhoomitrace-health.timer
  bhoomitrace-cert-renew.service
  bhoomitrace-cert-renew.timer
)
TIMERS=(bhoomitrace-backup.timer bhoomitrace-health.timer bhoomitrace-cert-renew.timer)

if [[ "$UNINSTALL" == "true" ]]; then
  for timer in "${TIMERS[@]}"; do
    systemctl disable --now "$timer" 2>/dev/null || true
  done
  for unit in "${UNITS[@]}"; do
    rm -f "$UNITS_DIR/$unit"
  done
  systemctl daemon-reload
  info "systemd units removed"
  exit 0
fi

if [[ "$REPO_DIR" != "/opt/bhoomitrace" ]]; then
  warn "this checkout is at $REPO_DIR but the units point at /opt/bhoomitrace; move the checkout or edit the units before enabling the timers"
fi

for unit in "${UNITS[@]}"; do
  install -m 644 "$SOURCE_DIR/$unit" "$UNITS_DIR/$unit"
  info "installed $UNITS_DIR/$unit"
done

systemctl daemon-reload
info "systemd reloaded"

if [[ "$ENABLE" == "true" ]]; then
  for timer in "${TIMERS[@]}"; do
    systemctl enable --now "$timer"
    info "enabled $timer"
  done
  systemctl list-timers 'bhoomitrace-*' --no-pager || true
else
  warn "timers installed but NOT enabled. Review them, then: systemctl enable --now ${TIMERS[*]}"
fi

info "SYSTEMD INSTALL RESULT: SUCCESS enabled=$ENABLE"
