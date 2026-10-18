#!/usr/bin/env bash
# Runs both backups under one shared timestamp so the database dump and the
# evidence archive can be matched to each other during a restore. This is what
# the systemd timer invokes, and what deploy.sh calls before a release.
#
#   sudo deploy/scripts/backup-all.sh
#   sudo deploy/scripts/backup-all.sh --label pre-deploy
#   sudo deploy/scripts/backup-all.sh --no-upload      # local staging only
#   deploy/scripts/backup-all.sh --db-only
#
# Exit status is non-zero if either half fails, so a timer failure is visible and
# can be alarmed on. The final line is always a single, greppable result record.
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="backup-all"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LABEL=""
NO_UPLOAD=false
DB_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)
      [[ $# -ge 2 ]] || die "--label needs a value"
      LABEL="$2"
      shift 2
      ;;
    --no-upload) NO_UPLOAD=true; shift ;;
    --db-only) DB_ONLY=true; shift ;;
    -h | --help)
      echo "Usage: backup-all.sh [--label TEXT] [--no-upload] [--db-only]" >&2
      exit 0
      ;;
    *) die "unexpected argument: $1" ;;
  esac
done

require_cmd docker
load_config

BHOOMITRACE_BACKUP_DIR="${BHOOMITRACE_BACKUP_DIR:-$(backup_dir)}"
LOG_FILE="${BHOOMITRACE_LOG_FILE:-$BHOOMITRACE_BACKUP_DIR/../logs/backup.log}"
log_file_init "$LOG_FILE"
export BHOOMITRACE_LOG_FILE="$LOG_FILE"

# One timestamp for the whole run: the two artifacts must describe the same point
# in time, or a restore could pair a database from one day with evidence from the
# next.
RUN_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EFFECTIVE_LABEL="${LABEL:-scheduled}"
START_TIME="$SECONDS"

info "off-host backups: log file $LOG_FILE"

ARGS=(--label "$RUN_STAMP")
if [[ "$NO_UPLOAD" == "true" ]]; then
  ARGS+=(--no-upload)
fi

DB_STATUS="skipped"
UPLOADS_STATUS="skipped"
DB_FILE=""
UPLOADS_FILE=""

if [[ -e "$LOG_FILE" ]]; then
  chmod 640 "$LOG_FILE" 2>/dev/null || true
fi

info "--- database ---"
DB_OUTPUT="$(mktemp)"
if "${SCRIPTS_DIR}/backup-db.sh" "${ARGS[@]}" 2>&1 | tee "$DB_OUTPUT"; then
  DB_STATUS="ok"
  DB_FILE="$(sed -n 's/.*file=\([^ ]*\).*/\1/p' "$DB_OUTPUT" | tail -1)"
else
  DB_STATUS="failed"
fi
rm -f "$DB_OUTPUT"

if [[ "$DB_ONLY" != "true" ]]; then
  info "--- uploads ---"
  UP_OUTPUT="$(mktemp)"
  if "${SCRIPTS_DIR}/backup-uploads.sh" "${ARGS[@]}" 2>&1 | tee "$UP_OUTPUT"; then
    UPLOADS_STATUS="ok"
    UPLOADS_FILE="$(sed -n 's/.*file=\([^ ]*\).*/\1/p' "$UP_OUTPUT" | tail -1)"
  else
    UPLOADS_STATUS="failed"
  fi
  rm -f "$UP_OUTPUT"
fi

DURATION="$((SECONDS - START_TIME))"

if [[ "$DB_STATUS" != "ok" || "$UPLOADS_STATUS" == "failed" ]]; then
  error "BACKUP RESULT: FAILURE label=$EFFECTIVE_LABEL db=$DB_STATUS uploads=$UPLOADS_STATUS duration=${DURATION}s"
  publish_metric BackupFailure 1
  publish_metric BackupSuccess 0
  exit 1
fi

publish_metric BackupSuccess 1
publish_metric BackupFailure 0
info "BACKUP RESULT: SUCCESS label=$EFFECTIVE_LABEL db=$DB_STATUS uploads=$UPLOADS_STATUS db_file=${DB_FILE:-none} uploads_file=${UPLOADS_FILE:-none} duration=${DURATION}s"
