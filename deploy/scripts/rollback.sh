#!/usr/bin/env bash
# Rolls the application images back to a previously recorded release.
#
#   sudo deploy/scripts/rollback.sh                     # to state/previous.env
#   sudo deploy/scripts/rollback.sh --list              # show recorded releases
#   sudo deploy/scripts/rollback.sh --to state/deployed.env
#   sudo deploy/scripts/rollback.sh --to history/2026....env --yes
#
# WHAT THIS DOES: swaps BACKEND_IMAGE / FRONTEND_IMAGE in deploy/env/stack.env to
# the recorded references, pulls them, recreates api/worker/frontend/edge, and
# re-runs the health check.
#
# WHAT THIS DOES NOT DO: it does not run migrations, and it does not reverse a
# schema change. Migrations are forward-only by design. If a release applied a
# migration and the older image cannot read the newer schema, restoring the
# database (scripts/restore.sh --mode production, or the pre-deploy backup that
# deploy.sh takes) is the recovery path — not this script. See deploy/README.md
# ("Rollback" and "Restore-first decision") before using this on a schema release.
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="rollback"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGET_FILE=""
ASSUME_YES=false
LIST_ONLY=false
SKIP_HEALTH=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)
      [[ $# -ge 2 ]] || die "--to needs a value"
      TARGET_FILE="$2"
      shift 2
      ;;
    --list) LIST_ONLY=true; shift ;;
    --yes) ASSUME_YES=true; shift ;;
    --skip-health) SKIP_HEALTH=true; shift ;;
    -h | --help)
      echo "Usage: rollback.sh [--to FILE | --list] [--yes] [--skip-health]" >&2
      exit 0
      ;;
    *) die "unexpected argument: $1" ;;
  esac
done

require_cmd docker jq
load_config

STATE_DIR="$(state_dir)"
mkdir -p "$STATE_DIR"

if [[ "$LIST_ONLY" == "true" ]]; then
  echo "Recorded releases in $STATE_DIR:" >&2
  for f in previous.env deployed.env current.env; do
    if [[ -f "$STATE_DIR/$f" ]]; then
      printf '  %-16s backend=%s frontend=%s deployed_at=%s\n' \
        "$f" \
        "$(sed -n 's/^BACKEND_IMAGE=//p' "$STATE_DIR/$f")" \
        "$(sed -n 's/^FRONTEND_IMAGE=//p' "$STATE_DIR/$f")" \
        "$(sed -n 's/^DEPLOYED_AT=\(.*\)/DEPLOYED_AT=\1/p' "$STATE_DIR/$f")" >&2
    fi
  done
  if [[ -d "$STATE_DIR/history" ]]; then
    echo "  history/:" >&2
    find "$STATE_DIR/history" -maxdepth 1 -type f -name '*.env' 2>/dev/null | sort | while read -r h; do
      printf '    %s backend=%s\n' "$(basename "$h")" "$(sed -n 's/^BACKEND_IMAGE=//p' "$h")" >&2
    done
  fi
  exit 0
fi

TARGET_FILE="${TARGET_FILE:-$STATE_DIR/previous.env}"
require_file "$TARGET_FILE" "recorded release file"

# shellcheck disable=SC1090
TARGET_BACKEND="$(sed -n 's/^BACKEND_IMAGE=//p' "$TARGET_FILE" | head -1)"
TARGET_FRONTEND="$(sed -n 's/^FRONTEND_IMAGE=//p' "$TARGET_FILE" | head -1)"
[[ -n "$TARGET_BACKEND" ]] || die "$TARGET_FILE has no BACKEND_IMAGE"
[[ -n "$TARGET_FRONTEND" ]] || die "$TARGET_FILE has no FRONTEND_IMAGE"

banner "ROLLBACK to $(basename "$TARGET_FILE") — images only, schema is NOT reverted"

info "current : ${BACKEND_IMAGE:-unset}"
info "target  : $TARGET_BACKEND"
info "target  : $TARGET_FRONTEND"

if [[ "$BACKEND_IMAGE" == "$TARGET_BACKEND" && "$FRONTEND_IMAGE" == "$TARGET_FRONTEND" ]]; then
  info "stack.env already points at the target release; nothing to change"
fi

# Pull first: a rollback that cannot fetch its images must not half-apply.
info "pulling the target images before changing anything"
if ! docker pull "$TARGET_BACKEND" >/dev/null; then
  die "could not pull $TARGET_BACKEND; abandoning rollback with the current release untouched"
fi
if ! docker pull "$TARGET_FRONTEND" >/dev/null; then
  die "could not pull $TARGET_FRONTEND; abandoning rollback with the current release untouched"
fi

if [[ "$ASSUME_YES" != "true" && -t 0 ]]; then
  printf 'Replace the running images with the target release? [y/N] ' >&2
  read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || die "aborted by operator"
fi

# --- Rewrite stack.env atomically, keeping a dated copy ---------------------
STACK_BACKUP="$STATE_DIR/stack.env.$(date -u +%Y%m%dT%H%M%SZ).bak"
cp -p "$STACK_ENV_FILE" "$STACK_BACKUP"
info "stack.env preserved at $STACK_BACKUP"

TMP="$(mktemp "$(dirname "$STACK_ENV_FILE")/.stack.env.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
sed \
  -e "s|^BACKEND_IMAGE=.*|BACKEND_IMAGE=$TARGET_BACKEND|" \
  -e "s|^FRONTEND_IMAGE=.*|FRONTEND_IMAGE=$TARGET_FRONTEND|" \
  "$STACK_ENV_FILE" >"$TMP"
install -m 600 "$TMP" "$STACK_ENV_FILE"
rm -f "$TMP"
trap - EXIT

# Re-read so later steps use the rolled-back references
load_config

# --- Recreate the application containers only -------------------------------
# postgres and the migration job are deliberately excluded: this is an image
# rollback, not a schema or data change.
info "recreating api, worker, frontend, edge with the target images"
if ! compose up -d --no-deps api worker frontend edge; then
  die "compose up failed during rollback; stack.env now points at the target release, re-run: scripts/compose.sh up -d"
fi

if [[ "$SKIP_HEALTH" == "true" ]]; then
  warn "--skip-health: verify manually with scripts/health-check.sh"
else
  if "$SCRIPTS_DIR/health-check.sh"; then
    info "rollback health check passed"
  else
    warn "rollback completed but the health check failed; inspect scripts/compose.sh logs"
    exit 1
  fi
fi

# Record what is now running so a second rollback has a correct starting point.
"$SCRIPTS_DIR/record-release.sh" --from-running --note "rollback to $(basename "$TARGET_FILE")" || \
  warn "could not record the rolled-back release"

info "ROLLBACK RESULT: SUCCESS target=$(basename "$TARGET_FILE") backend=${TARGET_BACKEND##*/} frontend=${TARGET_FRONTEND##*/}"
warn "the database schema was NOT reverted. If the release that this replaces applied a migration, restore a pre-deploy backup and deploy the matching image pair."
