#!/usr/bin/env bash
# PostgreSQL backup using pg_dump in custom format (-Fc), uploaded to S3.
#
#   sudo deploy/scripts/backup-db.sh
#   sudo deploy/scripts/backup-db.sh --no-upload            # local staging only
#   sudo deploy/scripts/backup-db.sh --label pre-deploy
#
# Custom format is used deliberately: it is compressed, it supports selective and
# parallel restore (pg_restore -j), and it carries a table of contents that can be
# listed and verified without restoring (`pg_restore --list`). A plain SQL dump
# would have to be replayed to know whether it is complete.
#
# The dump is streamed out of the running container to the host, so nothing large
# is ever written to the container's writable layer (which lives on the root
# volume), and no restore-capable file is left inside the database container.
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/backup-common.sh"

BHOOMITRACE_SCRIPT_NAME="backup-db"
LABEL=""
NO_UPLOAD=false
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)
      [[ $# -ge 2 ]] || die "--label needs a value"
      LABEL="$2"
      shift 2
      ;;
    --no-upload) NO_UPLOAD=true; shift ;;
    --output-dir)
      [[ $# -ge 2 ]] || die "--output-dir needs a value"
      OUTPUT_DIR="$2"
      shift 2
      ;;
    -h | --help)
      echo "Usage: backup-db.sh [--label TEXT] [--no-upload] [--output-dir DIR]" >&2
      exit 0
      ;;
    *) die "unexpected argument: $1" ;;
  esac
done

require_cmd docker
load_config
load_secrets
require_var POSTGRES_USER POSTGRES_DB

if [[ "$NO_UPLOAD" != "true" ]]; then
  # Resolve and validate the destination before checking for the CLI: a missing
  # bucket is a configuration mistake worth reporting ahead of a missing tool.
  backup_resolve_target
  require_cmd aws
fi

BHOOMITRACE_BACKUP_DIR="${BHOOMITRACE_BACKUP_DIR:-$(backup_dir)}"
log_file_init "${BHOOMITRACE_LOG_FILE:-$BHOOMITRACE_BACKUP_DIR/../logs/backup.log}"

OUTPUT_DIR="${OUTPUT_DIR:-$BHOOMITRACE_BACKUP_DIR/database}"
mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR" 2>/dev/null || true

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SUFFIX=""
[[ -n "$LABEL" ]] && SUFFIX="-${LABEL}"
BASENAME="bhoomitrace-${POSTGRES_DB}-${STAMP}${SUFFIX}.dump"
TARGET="$OUTPUT_DIR/$BASENAME"

# --- Preconditions ----------------------------------------------------------
# Refuse before writing anything if the database is not actually serving, rather
# than producing a truncated file that looks like a backup.
info "checking that the postgres container is up and accepting connections"
if ! compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
  die "postgres is not ready; refusing to take a dump that could be empty or partial"
fi

# --- Dump -------------------------------------------------------------------
# -Fc custom format, -Z6 compression. Written straight to the host path.
info "dumping database '$POSTGRES_DB' as user '$POSTGRES_USER' (custom format)"
START_TIME="$SECONDS"
if ! compose exec -T postgres pg_dump \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-privileges >"$TARGET"; then
  rm -f "$TARGET"
  die "pg_dump failed; no backup file was produced"
fi

BYTES="$(wc -c <"$TARGET" | tr -d ' ')"
if [[ "$BYTES" -lt 1024 ]]; then
  rm -f "$TARGET"
  die "dump is only ${BYTES} bytes, which is too small to be a complete database; treating as failure"
fi

# --- Verify the archive -----------------------------------------------------
# --list walks the table of contents, so a truncated or corrupt archive is caught
# here rather than at restore time.
info "verifying archive table of contents"
TOC="$(docker run --rm -i "${POSTGRES_IMAGE:-postgres:17-alpine}" pg_restore --list <"$TARGET" 2>/dev/null || true)"
TOC_ENTRIES="$(printf '%s\n' "$TOC" | grep -c ';' || true)"
if [[ -z "$TOC" || "$TOC_ENTRIES" -lt 1 ]]; then
  rm -f "$TARGET"
  die "pg_restore --list could not read the archive; the dump is not usable"
fi

# The migration journal proves this is the BhoomiTrace schema and not some other
# database that happened to be reachable.
if printf '%s' "$TOC" | grep -q 'drizzle_migrations'; then
  info "archive contains the drizzle migration journal ($TOC_ENTRIES TOC entries)"
else
  warn "archive has no drizzle_migrations table; verify you dumped the right database"
fi

CHECKSUM_FILE="$(write_checksum "$TARGET")"
CHECKSUM="$(awk '{print $1}' "$CHECKSUM_FILE")"
DURATION="$((SECONDS - START_TIME))"
info "dump complete: $TARGET ($(human_size "$BYTES"), ${DURATION}s, sha256=${CHECKSUM:0:16}…)"

# --- Metadata sidecar -------------------------------------------------------
META="$OUTPUT_DIR/$BASENAME.meta"
{
  printf 'kind=database\n'
  printf 'database=%s\n' "$POSTGRES_DB"
  printf 'created_at=%s\n' "$STAMP"
  printf 'label=%s\n' "$LABEL"
  printf 'bytes=%s\n' "$BYTES"
  printf 'sha256=%s\n' "$CHECKSUM"
  printf 'toc_entries=%s\n' "$TOC_ENTRIES"
  printf 'pg_dump_format=custom\n'
  printf 'host=%s\n' "$(hostname)"
} >"$META"

# --- Off-host copy ----------------------------------------------------------
S3_URI=""
if [[ "$NO_UPLOAD" == "true" ]]; then
  warn "--no-upload: this backup exists ONLY on the EBS volume. EBS is not a backup."
else
  KEY="$BACKUP_PREFIX/database/$BASENAME"
  s3_put "$TARGET" "$KEY" >/dev/null
  s3_put "$CHECKSUM_FILE" "$KEY.sha256" >/dev/null
  s3_put "$META" "$KEY.meta" >/dev/null
  S3_URI="s3://$BACKUP_BUCKET/$KEY"
  info "off-host copy verified: $S3_URI"
  prune_local_backups "database" "bhoomitrace-" "${BACKUP_LOCAL_RETENTION_DAYS:-7}"
fi

info "BACKUP RESULT: SUCCESS kind=database file=$BASENAME bytes=$BYTES toc=$TOC_ENTRIES s3=${S3_URI:-none}"
