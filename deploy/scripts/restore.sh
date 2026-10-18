#!/usr/bin/env bash
# Restores a PostgreSQL dump (and optionally an evidence archive).
#
# SAFE BY DEFAULT: the default target is a scratch database in a scratch
# container plus a scratch upload directory. Production is never touched unless
# the operator asks for it explicitly and confirms it three separate ways.
#
#   # scratch restore into a disposable container (the drill uses this)
#   deploy/scripts/restore.sh --dump backups/database/x.dump \
#     --target-container bhoomitrace-drill --target-db bhoomitrace_restore_scratch
#
#   # include evidence
#   deploy/scripts/restore.sh --dump x.dump --uploads-tar uploads-x.tar.gz \
#     --target-container bhoomitrace-drill
#
#   # production restore: stops the API and worker, replaces the database, starts
#   # them again. Requires --force-production AND RESTORE_PRODUCTION_CONFIRM,
#   # plus typing the database name at a terminal.
#   sudo RESTORE_PRODUCTION_CONFIRM=overwrite-production-data \
#     deploy/scripts/restore.sh --mode production --force-production --dump x.dump
#
# Why a production restore replaces the database rather than merging: a dump is a
# point-in-time copy. Restoring it into a database that already holds different
# data cannot produce the state the dump describes, so the only honest operation
# is a replacement — which is exactly why it is fenced off.
#
# WARNING for schema changes: migrations are forward-only. Restoring an older dump
# also restores an older schema. The application image must match, so a
# schema-incompatible failure is fixed by restoring a backup and, if needed,
# deploying the older image pair — not by rolling back the schema.
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="restore"

MODE="scratch"
DUMP_FILE=""
UPLOADS_TAR=""
TARGET_CONTAINER=""
TARGET_DB=""
TARGET_UPLOADS_DIR=""
FORCE_PRODUCTION=false
SCRATCH_CLEAN=false
VALIDATE=true

usage() {
  cat >&2 <<'EOF'
Usage: restore.sh --dump FILE [options]

Required:
  --dump FILE                 custom-format pg_dump archive to restore

Target (default: scratch):
  --mode scratch|production   default scratch
  --target-container NAME     running postgres container to restore into (scratch)
  --target-db NAME            database name to create/restore (default <db>_restore_scratch)
  --uploads-tar FILE          evidence archive to restore as well
  --target-uploads-dir DIR    where to extract evidence (default <data>/scratch-uploads)
  --scratch-clean             empty the scratch upload directory before extracting

Production (all three gates required):
  --mode production --force-production
  RESTORE_PRODUCTION_CONFIRM=overwrite-production-data
  typing the database name at a terminal

Other:
  --no-validate               skip the post-restore summary
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || die "--mode needs a value"
      MODE="$2"
      shift 2
      ;;
    --dump)
      [[ $# -ge 2 ]] || die "--dump needs a value"
      DUMP_FILE="$2"
      shift 2
      ;;
    --uploads-tar)
      [[ $# -ge 2 ]] || die "--uploads-tar needs a value"
      UPLOADS_TAR="$2"
      shift 2
      ;;
    --target-container)
      [[ $# -ge 2 ]] || die "--target-container needs a value"
      TARGET_CONTAINER="$2"
      shift 2
      ;;
    --target-db)
      [[ $# -ge 2 ]] || die "--target-db needs a value"
      TARGET_DB="$2"
      shift 2
      ;;
    --target-uploads-dir)
      [[ $# -ge 2 ]] || die "--target-uploads-dir needs a value"
      TARGET_UPLOADS_DIR="$2"
      shift 2
      ;;
    --force-production) FORCE_PRODUCTION=true; shift ;;
    --scratch-clean) SCRATCH_CLEAN=true; shift ;;
    --no-validate) VALIDATE=false; shift ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) usage; die "unexpected argument: $1" ;;
  esac
done

case "$MODE" in
  scratch | production) ;;
  *) die "--mode must be scratch or production (got: $MODE)" ;;
esac

# A caller-supplied database name is used in SQL and in command arguments, so it
# is validated before anything else happens — including before any container is
# inspected. The resolved default (below) is validated again for the same reason.
if [[ -n "$TARGET_DB" ]]; then
  [[ "$TARGET_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
    die "target database name must be a plain identifier (got: $TARGET_DB)"
fi

require_cmd docker tar
[[ -n "$DUMP_FILE" ]] || { usage; die "--dump is required"; }
require_file "$DUMP_FILE" "dump archive"
[[ "$DUMP_FILE" == *.dump || "$DUMP_FILE" == *.backup ]] || warn "$DUMP_FILE does not look like a custom-format dump; continuing"

load_config
require_var POSTGRES_USER POSTGRES_DB

BHOOMITRACE_BACKUP_DIR="${BHOOMITRACE_BACKUP_DIR:-$(backup_dir)}"
log_file_init "${BHOOMITRACE_LOG_FILE:-$BHOOMITRACE_BACKUP_DIR/../logs/restore.log}"
PG_IMAGE="${POSTGRES_IMAGE:-postgres:17-alpine}"

# ---------------------------------------------------------------------------
# Confirmation gates
# ---------------------------------------------------------------------------
if [[ "$MODE" == "production" ]]; then
  load_secrets
  require_var POSTGRES_PASSWORD
  banner "PRODUCTION RESTORE — the live database will be REPLACED from $DUMP_FILE"
  require_production_overwrite_confirmation \
    "$POSTGRES_DB" "$FORCE_PRODUCTION" "RESTORE_PRODUCTION_CONFIRM"

  if [[ -z "$TARGET_UPLOADS_DIR" ]]; then
    TARGET_UPLOADS_DIR="$BHOOMITRACE_DATA_DIR/uploads"
  fi
  TARGET_DB="${TARGET_DB:-$POSTGRES_DB}"

  # Nothing may be writing while the database is replaced.
  info "stopping api and worker so nothing writes during the restore"
  compose stop api worker >/dev/null || warn "could not stop api/worker; continuing, but expect dirty reads"
else
  [[ -n "$TARGET_CONTAINER" ]] || die "--target-container NAME is required in scratch mode (the drill creates a disposable container)"
  [[ "$TARGET_CONTAINER" =~ ^[A-Za-z0-9_.-]+$ ]] || die "--target-container is not a valid container name"

  if ! docker inspect -f '{{.State.Running}}' "$TARGET_CONTAINER" >/dev/null 2>&1; then
    die "scratch target container '$TARGET_CONTAINER' is not running"
  fi

  TARGET_DB="${TARGET_DB:-${POSTGRES_DB}_restore_scratch}"
  if [[ -z "$TARGET_UPLOADS_DIR" ]]; then
    TARGET_UPLOADS_DIR="${BHOOMITRACE_DATA_DIR:-$(dirname "$(backup_dir)")}/scratch-uploads"
  fi
fi

[[ "$TARGET_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "target database name must be a plain identifier (got: $TARGET_DB)"

if [[ "$MODE" == "production" && "$TARGET_DB" == "$POSTGRES_DB" ]]; then
  info "target database is the production database '$POSTGRES_DB'"
fi

# ---------------------------------------------------------------------------
# PostgreSQL client wrappers
# ---------------------------------------------------------------------------
if [[ "$MODE" == "production" ]]; then
  PG_USER="$POSTGRES_USER"
  run_psql() { compose exec -T postgres psql -U "$PG_USER" "$@"; }
  run_pg() { compose exec -T postgres "$@"; }
else
  PG_USER="postgres"
  run_psql() { docker exec -i "$TARGET_CONTAINER" psql -U "$PG_USER" "$@"; }
  run_pg() { docker exec -i "$TARGET_CONTAINER" "$@"; }
fi

db_exists() {
  # Captured rather than piped into `grep -q`: an early-exiting consumer under
  # `set -o pipefail` can turn a successful check into a failed one.
  local found
  found="$(run_psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'" 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$found" == "1" ]]
}

# ---------------------------------------------------------------------------
# Database restore
# ---------------------------------------------------------------------------
info "restoring database '$TARGET_DB' from $DUMP_FILE (mode=$MODE)"

# Prove the archive is readable before touching any target database.
#
# The table of contents is captured and counted rather than piped into
# `grep -q`: `grep -q` exits at the first match, and under `set -o pipefail` the
# resulting SIGPIPE on the producer makes a *successful* check look like a
# failure. Counting also reports how many entries were found.
TOC_ENTRIES="$(run_pg pg_restore --list <"$DUMP_FILE" 2>/dev/null | grep -c ';' || true)"
if [[ "${TOC_ENTRIES:-0}" -lt 1 ]]; then
  die "pg_restore cannot read $DUMP_FILE, or it has an empty table of contents; refusing to proceed"
fi
info "archive is readable: $TOC_ENTRIES table-of-contents entries"

if [[ "$MODE" == "production" ]]; then
  # Replacement semantics: an existing database is dropped. Guarded above.
  if db_exists; then
    info "dropping existing database '$TARGET_DB' (confirmed production restore)"
    run_pg dropdb --if-exists --force -U "$PG_USER" "$TARGET_DB"
  fi
  run_pg createdb -U "$PG_USER" "$TARGET_DB"
else
  # Scratch semantics: recreate for a deterministic result.
  if db_exists; then
    info "dropping existing scratch database '$TARGET_DB'"
    run_pg dropdb --if-exists --force -U "$PG_USER" "$TARGET_DB"
  fi
  run_pg createdb -U "$PG_USER" "$TARGET_DB"
fi

START_TIME="$SECONDS"
# --exit-on-error turns a partially restored database into a failed restore
# rather than a database that looks fine until someone queries a missing table.
# --no-owner/--no-privileges keep the restore portable between hosts.
# --username is required: inside the container pg_restore would otherwise
# connect as the container's OS user (root), which has no database role.
if ! run_pg pg_restore \
  --dbname "$TARGET_DB" \
  --username "$PG_USER" \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  <"$DUMP_FILE"; then
  die "pg_restore failed for '$TARGET_DB'; the database may be incomplete"
fi
info "database restore finished in $((SECONDS - START_TIME))s"

# ---------------------------------------------------------------------------
# Evidence restore
# ---------------------------------------------------------------------------
if [[ -n "$UPLOADS_TAR" ]]; then
  require_file "$UPLOADS_TAR" "uploads archive"

  if [[ "$MODE" == "scratch" ]]; then
    if [[ "$SCRATCH_CLEAN" == "true" && -d "$TARGET_UPLOADS_DIR" ]]; then
      info "clearing scratch upload directory $TARGET_UPLOADS_DIR"
      rm -rf "$TARGET_UPLOADS_DIR"
    fi
  fi

  mkdir -p "$TARGET_UPLOADS_DIR"
  # Extract into a staging directory first, so an extraction failure cannot leave
  # the live evidence directory half-populated.
  STAGING="${TARGET_UPLOADS_DIR}.incoming-$(date -u +%Y%m%dT%H%M%SZ)"
  rm -rf "$STAGING"
  mkdir -p "$STAGING"

  info "extracting evidence archive into a staging directory"
  if ! tar -xzf "$UPLOADS_TAR" -C "$STAGING"; then
    rm -rf "$STAGING"
    die "tar failed to extract $UPLOADS_TAR"
  fi

  STAGED_FILES="$(find "$STAGING" -type f | wc -l | tr -d ' ')"
  info "staged $STAGED_FILES file(s)"

  if [[ "$MODE" == "production" ]]; then
    # Never delete the previous evidence: move it aside so the restore is
    # reversible by hand if it turns out to be the wrong archive.
    ARCHIVE_TS="$(date -u +%Y%m%dT%H%M%SZ)"
    if [[ -d "$TARGET_UPLOADS_DIR" && -n "$(ls -A "$TARGET_UPLOADS_DIR" 2>/dev/null | head -1)" ]]; then
      info "moving current evidence aside to ${TARGET_UPLOADS_DIR}.pre-restore-${ARCHIVE_TS}"
      mv "$TARGET_UPLOADS_DIR" "${TARGET_UPLOADS_DIR}.pre-restore-${ARCHIVE_TS}"
    fi
  else
    rm -rf "$TARGET_UPLOADS_DIR"
  fi

  mv "$STAGING" "$TARGET_UPLOADS_DIR"
  info "evidence restored into $TARGET_UPLOADS_DIR"

  # Ownership so the API (uid 1000) can read the restored files.
  if [[ "$(id -u)" == "0" ]]; then
    chown -R "${UPLOAD_UID:-1000}:${UPLOAD_UID:-1000}" "$TARGET_UPLOADS_DIR" 2>/dev/null || \
      warn "could not set ownership on $TARGET_UPLOADS_DIR"
  fi
fi

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
if [[ "$VALIDATE" == "true" ]]; then
  info "post-restore summary for '$TARGET_DB':"
  if [[ "$MODE" == "production" ]]; then
    "$(dirname "${BASH_SOURCE[0]}")/db-summary.sh" --compose --db "$TARGET_DB" | tee -a "${BHOOMITRACE_LOG_FILE:-/dev/null}" >&2
  else
    "$(dirname "${BASH_SOURCE[0]}")/db-summary.sh" --container "$TARGET_CONTAINER" --db "$TARGET_DB" | tee -a "${BHOOMITRACE_LOG_FILE:-/dev/null}" >&2
  fi
fi

if [[ "$MODE" == "production" ]]; then
  info "restarting api and worker"
  compose start api worker >/dev/null || warn "could not restart api/worker; start them manually with scripts/compose.sh start api worker"
  info "run scripts/health-check.sh now, and expect the frontend to re-authenticate every user (sessions in the restored dump are older than the cookies in browsers)"
fi

info "RESTORE RESULT: SUCCESS mode=$MODE database=$TARGET_DB dump=${DUMP_FILE##*/} uploads=${UPLOADS_TAR:-none}"
