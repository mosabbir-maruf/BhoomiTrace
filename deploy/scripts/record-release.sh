#!/usr/bin/env bash
# Records which application images are deployed, so rollback has something exact
# to restore. Writes:
#
#   $BHOOMITRACE_STATE_DIR/current.env      what is deployed right now
#   $BHOOMITRACE_STATE_DIR/previous.env     what was deployed before
#   $BHOOMITRACE_STATE_DIR/history/<ts>.env append-only archive
#
# deploy.sh calls this before it changes anything. It is also safe to run by hand
# to snapshot a running stack.
#
#   deploy/scripts/record-release.sh --note "phase5b baseline"
#   deploy/scripts/record-release.sh --note "recovered" --keep-current
#
# --keep-current: record the running images but do NOT overwrite previous.env
# (used when re-recording after a rollback).
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="record-release"
NOTE=""
KEEP_CURRENT=false
FROM_RUNNING=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --note)
      [[ $# -ge 2 ]] || die "--note needs a value"
      NOTE="$2"
      shift 2
      ;;
    --keep-current) KEEP_CURRENT=true; shift ;;
    --from-running) FROM_RUNNING=true; shift ;;
    -h | --help)
      echo "Usage: record-release.sh [--note TEXT] [--keep-current] [--from-running]" >&2
      exit 0
      ;;
    *) die "unexpected argument: $1" ;;
  esac
done

load_config

STATE_DIR="$(state_dir)"
mkdir -p "$STATE_DIR/history"
chmod 700 "$STATE_DIR" 2>/dev/null || true

# ---------------------------------------------------------------------------
# --from-running: record what the containers are actually running, which is the
# only trustworthy answer to "what is deployed right now". Deploy runs this
# before it changes anything, so rollback has an exact target.
# ---------------------------------------------------------------------------
if [[ "$FROM_RUNNING" == "true" ]]; then
  require_cmd docker
  RUNNING_BACKEND="$(compose ps -q api 2>/dev/null | head -1)"
  RUNNING_FRONTEND="$(compose ps -q frontend 2>/dev/null | head -1)"

  if [[ -z "$RUNNING_BACKEND" || -z "$RUNNING_FRONTEND" ]]; then
    warn "no running api/frontend containers found; nothing recorded from the running stack"
    exit 0
  fi

  RUNNING_BACKEND_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$RUNNING_BACKEND")"
  RUNNING_FRONTEND_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$RUNNING_FRONTEND")"
  RUNNING_STAMP="$(_timestamp)"

  # Keep the outgoing deployed release so a rollback still has a target after a
  # rollback has already been recorded.
  if [[ -f "$STATE_DIR/deployed.env" ]]; then
    cp -p "$STATE_DIR/deployed.env" "$STATE_DIR/previously-deployed.env" 2>/dev/null || true
  fi

  TMP="$(mktemp "$STATE_DIR/.deployed.XXXXXX")"
  trap 'rm -f "$TMP"' EXIT
  {
    printf 'DEPLOYED_AT=%s\n' "$RUNNING_STAMP"
    printf 'BACKEND_IMAGE=%s\n' "$RUNNING_BACKEND_IMAGE"
    printf 'FRONTEND_IMAGE=%s\n' "$RUNNING_FRONTEND_IMAGE"
    printf 'NOTE=%s\n' "$NOTE"
    printf 'SOURCE=running-containers\n'
    printf 'HOST=%s\n' "$(hostname)"
  } >"$TMP"
  install -m 600 "$TMP" "$STATE_DIR/deployed.env"
  install -m 600 "$TMP" "$STATE_DIR/history/${RUNNING_STAMP}-deployed.env"
  rm -f "$TMP"
  trap - EXIT

  info "recorded running release: backend=${RUNNING_BACKEND_IMAGE##*/} frontend=${RUNNING_FRONTEND_IMAGE##*/}"
  exit 0
fi

require_var BACKEND_IMAGE
require_var FRONTEND_IMAGE


CURRENT="$STATE_DIR/current.env"
PREVIOUS="$STATE_DIR/previous.env"
STAMP="$(_timestamp)"
RELEASE_ID="$(printf '%s' "${BACKEND_IMAGE}${FRONTEND_IMAGE}${STAMP}" | sha256sum 2>/dev/null | cut -c1-12 || printf '%s' "${BACKEND_IMAGE}${FRONTEND_IMAGE}${STAMP}" | shasum -a 256 | cut -c1-12)"

# The previous release is only displaced by a real change of image references.
DISPLACE_PREVIOUS=true
if [[ "$KEEP_CURRENT" == "true" ]]; then
  DISPLACE_PREVIOUS=false
elif [[ -f "$CURRENT" ]] && grep -qF "BACKEND_IMAGE=$BACKEND_IMAGE" "$CURRENT" && grep -qF "FRONTEND_IMAGE=$FRONTEND_IMAGE" "$CURRENT"; then
  info "recorded images are unchanged; not displacing previous.env"
  DISPLACE_PREVIOUS=false
fi

if [[ "$DISPLACE_PREVIOUS" == "true" && -f "$CURRENT" ]]; then
  cp -p "$CURRENT" "$PREVIOUS"
  chmod 600 "$PREVIOUS" 2>/dev/null || true
  info "previous release preserved at $PREVIOUS"
fi

TMP="$(mktemp "$STATE_DIR/.current.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
{
  printf 'RELEASE_ID=%s\n' "$RELEASE_ID"
  printf 'DEPLOYED_AT=%s\n' "$STAMP"
  printf 'BACKEND_IMAGE=%s\n' "$BACKEND_IMAGE"
  printf 'FRONTEND_IMAGE=%s\n' "$FRONTEND_IMAGE"
  printf 'POSTGRES_IMAGE=%s\n' "${POSTGRES_IMAGE:-}"
  printf 'DOMAIN=%s\n' "${DOMAIN:-}"
  printf 'NOTE=%s\n' "$NOTE"
  printf 'HOST=%s\n' "$(hostname)"
} >"$TMP"
install -m 600 "$TMP" "$CURRENT"
install -m 600 "$TMP" "$STATE_DIR/history/${STAMP}-${RELEASE_ID}.env"
rm -f "$TMP"
trap - EXIT

info "recorded release $RELEASE_ID (backend=${BACKEND_IMAGE##*/} frontend=${FRONTEND_IMAGE##*/})"
