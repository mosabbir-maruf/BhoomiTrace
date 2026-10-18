#!/usr/bin/env bash
# Releases a new application image pair onto the running production stack.
#
#   sudo deploy/scripts/deploy.sh --note "phase5b production baseline"
#   sudo deploy/scripts/deploy.sh --skip-backup          # NOT recommended
#   sudo deploy/scripts/deploy.sh --rollback-on-failure  # only for non-schema releases
#
# Order of operations, each one a deliberate gate:
#   1. preflight            refuse an unsafe or ambiguous configuration
#   2. record the running release   so rollback has an exact target
#   3. back up database + evidence  before anything changes
#   4. pull the new images          fail before downtime if a tag is missing
#   5. record the current schema migration count
#   6. compose up -d                migrate (one-shot) completes, then api/worker
#   7. wait for healthy, then full health check
#   8. record the new release, and state clearly whether the schema changed
#
# The database is backed up on every release, including releases that turn out
# not to change the schema. That is intentional: the cost of a needless dump is
# far below the cost of a missing one.
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="deploy"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NOTE=""
SKIP_BACKUP=false
ROLLBACK_ON_FAILURE=false
WAIT_SECONDS="${DEPLOY_WAIT_SECONDS:-180}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --note)
      [[ $# -ge 2 ]] || die "--note needs a value"
      NOTE="$2"
      shift 2
      ;;
    --skip-backup) SKIP_BACKUP=true; shift ;;
    --rollback-on-failure) ROLLBACK_ON_FAILURE=true; shift ;;
    --wait-seconds)
      [[ $# -ge 2 ]] || die "--wait-seconds needs a value"
      WAIT_SECONDS="$2"
      shift 2
      ;;
    -h | --help)
      echo "Usage: deploy.sh [--note TEXT] [--skip-backup] [--rollback-on-failure] [--wait-seconds N]" >&2
      exit 0
      ;;
    *) die "unexpected argument: $1" ;;
  esac
done

require_cmd docker jq
load_config
load_secrets
require_verify_mode_banner

BHOOMITRACE_BACKUP_DIR="${BHOOMITRACE_BACKUP_DIR:-$(backup_dir)}"
STATE_DIR="$(state_dir)"
log_file_init "${BHOOMITRACE_LOG_FILE:-$BHOOMITRACE_BACKUP_DIR/../logs/deploy.log}"
mkdir -p "$STATE_DIR"

banner "DEPLOY ${BACKEND_IMAGE##*/} + ${FRONTEND_IMAGE##*/}"

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
info "step 1/8 preflight"
"$SCRIPTS_DIR/preflight.sh" || die "preflight failed; nothing was changed"

# ---------------------------------------------------------------------------
# 2. Record what is running now
# ---------------------------------------------------------------------------
info "step 2/8 recording the currently deployed release"
"$SCRIPTS_DIR/record-release.sh" --from-running --note "pre-deploy snapshot" || \
  warn "could not snapshot the running release (stack may not be running yet)"

# ---------------------------------------------------------------------------
# 3. Back up
# ---------------------------------------------------------------------------
PREVIOUS_MIGRATIONS=""
if [[ "$SKIP_BACKUP" == "true" ]]; then
  warn "step 3/8 SKIPPED: --skip-backup. There is no recovery point for this release."
else
  info "step 3/8 backing up database and evidence"
  if ! "$SCRIPTS_DIR/backup-all.sh" --label "pre-deploy"; then
    die "backup failed; refusing to deploy without a recovery point (use --skip-backup only if you accept that)"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Pull
# ---------------------------------------------------------------------------
info "step 4/8 pulling images"
docker pull "$BACKEND_IMAGE" >/dev/null || die "could not pull $BACKEND_IMAGE"
docker pull "$FRONTEND_IMAGE" >/dev/null || die "could not pull $FRONTEND_IMAGE"
info "images available locally"

# ---------------------------------------------------------------------------
# 5. Current schema position
# ---------------------------------------------------------------------------
MIGRATIONS_BEFORE="$(compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT CASE WHEN to_regclass('drizzle.__drizzle_migrations') IS NULL THEN 'missing' ELSE (SELECT count(*)::text FROM drizzle.__drizzle_migrations) END;" 2>/dev/null | tr -d '[:space:]' || echo unknown)"
info "step 5/8 migrations applied before this release: ${MIGRATIONS_BEFORE:-unknown}"

# ---------------------------------------------------------------------------
# 6. Release
# ---------------------------------------------------------------------------
info "step 6/8 recreating the stack (migrate runs first and must exit 0)"
if ! compose up -d --remove-orphans; then
  error "compose up failed"
  if [[ "$ROLLBACK_ON_FAILURE" == "true" ]]; then
    warn "attempting rollback (image only; the schema is NOT reverted)"
    "$SCRIPTS_DIR/rollback.sh" --yes || warn "rollback also failed; manual intervention required"
  else
    warn "no images were replaced if this failed before 'up' completed; check: scripts/compose.sh ps"
  fi
  die "deployment failed"
fi

# ---------------------------------------------------------------------------
# 7. Wait for health
# ---------------------------------------------------------------------------
info "step 7/8 waiting up to ${WAIT_SECONDS}s for the stack to become healthy"
DEADLINE=$((SECONDS + WAIT_SECONDS))
HEALTHY=false
while [[ "$SECONDS" -lt "$DEADLINE" ]]; do
  PS="$(compose_ps_json 2>/dev/null || true)"
  if [[ -n "$PS" && "$PS" != "[]" ]]; then
    UNHEALTHY="$(printf '%s\n' "$PS" | jq -r '
      [ .[]
        | select(.Service == "api" or .Service == "worker" or .Service == "frontend" or .Service == "edge" or .Service == "postgres")
        | select(.State != "running" or (.Health != null and .Health != "" and .Health != "healthy"))
        | .Service
      ] | join(",")' 2>/dev/null || echo parse-error)"
    MIGRATE_STATE="$(printf '%s\n' "$PS" | jq -r '[.[] | select(.Service == "migrate")] | first | if . == null then "" else (.State + ":" + (.ExitCode|tostring)) end' 2>/dev/null || echo '')"
    if [[ -z "$UNHEALTHY" && "$MIGRATE_STATE" == "exited:0" ]]; then
      HEALTHY=true
      break
    fi
  fi
  sleep 5
done

if [[ "$HEALTHY" != "true" ]]; then
  error "stack did not become healthy within ${WAIT_SECONDS}s"
  compose ps >&2 || true
  compose logs --tail 40 api worker migrate >&2 || true
  if [[ "$ROLLBACK_ON_FAILURE" == "true" ]]; then
    warn "attempting rollback (image only; the schema is NOT reverted)"
    "$SCRIPTS_DIR/rollback.sh" --yes --skip-health || warn "rollback failed; manual intervention required"
  else
    warn "recover with: scripts/rollback.sh  (images only — see the restore-first note in deploy/README.md)"
  fi
  die "deployment failed the health gate"
fi

info "containers report healthy; running the full health check"
if ! "$SCRIPTS_DIR/health-check.sh"; then
  error "full health check failed"
  if [[ "$ROLLBACK_ON_FAILURE" == "true" ]]; then
    warn "attempting rollback (image only; the schema is NOT reverted)"
    "$SCRIPTS_DIR/rollback.sh" --yes --skip-health || warn "rollback failed; manual intervention required"
  fi
  die "deployment failed the health check"
fi

# ---------------------------------------------------------------------------
# 8. Record
# ---------------------------------------------------------------------------
MIGRATIONS_AFTER="$(compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT CASE WHEN to_regclass('drizzle.__drizzle_migrations') IS NULL THEN 'missing' ELSE (SELECT count(*)::text FROM drizzle.__drizzle_migrations) END;" 2>/dev/null | tr -d '[:space:]' || echo unknown)"

SCHEMA_CHANGED=false
if [[ -n "$MIGRATIONS_BEFORE" && "$MIGRATIONS_BEFORE" != "unknown" && "$MIGRATIONS_AFTER" != "$MIGRATIONS_BEFORE" ]]; then
  SCHEMA_CHANGED=true
fi

"$SCRIPTS_DIR/record-release.sh" --note "${NOTE:-deploy}"
info "step 8/8 recorded"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
info "DEPLOY RESULT: SUCCESS backend=${BACKEND_IMAGE##*/} frontend=${FRONTEND_IMAGE##*/} migrations=$MIGRATIONS_BEFORE->$MIGRATIONS_AFTER schema_changed=$SCHEMA_CHANGED"
if [[ "$SCHEMA_CHANGED" == "true" ]]; then
  warn "this release applied migrations ($MIGRATIONS_BEFORE -> $MIGRATIONS_AFTER)."
  warn "Migrate forward is the only supported direction. An image rollback (scripts/rollback.sh) will NOT undo these migrations; if the older image cannot read the new schema, restore the pre-deploy backup and deploy the matching image pair."
fi
info "recovery point: scripts/rollback.sh (previous images) and the pre-deploy backup in ${BHOOMITRACE_BACKUP_DIR:-the backup directory}"
