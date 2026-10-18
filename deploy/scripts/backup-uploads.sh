#!/usr/bin/env bash
# Uploaded-evidence backup: a tar.gz of the shared upload directory, uploaded to
# S3 under a separate key prefix from the database dumps.
#
#   sudo deploy/scripts/backup-uploads.sh
#   sudo deploy/scripts/backup-uploads.sh --no-upload
#
# Evidence is backed up separately from the database because the two have
# different sizes, different restore semantics, and different failure modes. A
# database restored without the matching evidence is a database full of document
# rows pointing at files that no longer exist, so both artifacts record the same
# timestamp and both are uploaded before a release is reported as backed up.
#
# The upload directory is owned by the application user (uid 1000) with mode 0750,
# so this must run as root (the systemd timer does).
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/backup-common.sh"

BHOOMITRACE_SCRIPT_NAME="backup-uploads"
LABEL=""
NO_UPLOAD=false
OUTPUT_DIR=""
ALLOW_NONROOT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)
      [[ $# -ge 2 ]] || die "--label needs a value"
      LABEL="$2"
      shift 2
      ;;
    --no-upload) NO_UPLOAD=true; shift ;;
    --allow-nonroot) ALLOW_NONROOT=true; shift ;;
    --output-dir)
      [[ $# -ge 2 ]] || die "--output-dir needs a value"
      OUTPUT_DIR="$2"
      shift 2
      ;;
    -h | --help)
      echo "Usage: backup-uploads.sh [--label TEXT] [--no-upload] [--output-dir DIR] [--allow-nonroot]" >&2
      exit 0
      ;;
    *) die "unexpected argument: $1" ;;
  esac
done

require_cmd docker tar
load_config
require_var BHOOMITRACE_DATA_DIR

if [[ "$NO_UPLOAD" != "true" ]]; then
  # Same ordering as backup-db.sh: report a missing destination before a missing CLI.
  load_secrets
  backup_resolve_target
  require_cmd aws
fi

UPLOADS_DIR="$BHOOMITRACE_DATA_DIR/uploads"
require_dir "$UPLOADS_DIR" "upload directory"

if [[ "$(id -u)" != "0" && "$ALLOW_NONROOT" != "true" ]]; then
  die "must run as root to read the upload directory (owned by uid ${UPLOAD_UID:-1000}, mode 0750); use --allow-nonroot only if you know the reader has access"
fi

BHOOMITRACE_BACKUP_DIR="${BHOOMITRACE_BACKUP_DIR:-$(backup_dir)}"
log_file_init "${BHOOMITRACE_LOG_FILE:-$BHOOMITRACE_BACKUP_DIR/../logs/backup.log}"

OUTPUT_DIR="${OUTPUT_DIR:-$BHOOMITRACE_BACKUP_DIR/uploads}"
mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR" 2>/dev/null || true

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SUFFIX=""
[[ -n "$LABEL" ]] && SUFFIX="-${LABEL}"
BASENAME="bhoomitrace-uploads-${STAMP}${SUFFIX}.tar.gz"
TARGET="$OUTPUT_DIR/$BASENAME"

# --- Source inventory -------------------------------------------------------
# Counted before and after, so an incomplete archive is detected.
FILE_COUNT="$(find "$UPLOADS_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')"
info "upload directory contains $FILE_COUNT file(s) at $UPLOADS_DIR"

START_TIME="$SECONDS"
info "creating archive"
# -C so paths inside the archive are relative to the upload root, which is what
# restore expects. A read error is fatal rather than silently skipping a file, so
# the archive can never be a partial copy that looks complete.
if ! tar -C "$UPLOADS_DIR" -czf "$TARGET" .; then
  rm -f "$TARGET"
  die "tar failed while archiving $UPLOADS_DIR"
fi

BYTES="$(wc -c <"$TARGET" | tr -d ' ')"
[[ "$BYTES" -gt 0 ]] || die "archive is empty"

# --- Verify the archive -----------------------------------------------------
ARCHIVE_ENTRIES="$(tar -tzf "$TARGET" 2>/dev/null | wc -l | tr -d ' ')"
info "archive holds $ARCHIVE_ENTRIES entries"

# An evidence directory with files must produce an archive that lists them.
if [[ "$FILE_COUNT" -gt 0 && "$ARCHIVE_ENTRIES" -lt "$FILE_COUNT" ]]; then
  rm -f "$TARGET"
  die "archive lists $ARCHIVE_ENTRIES entries but the source has $FILE_COUNT files; archive is incomplete"
fi

CHECKSUM_FILE="$(write_checksum "$TARGET")"
CHECKSUM="$(awk '{print $1}' "$CHECKSUM_FILE")"
DURATION="$((SECONDS - START_TIME))"
info "archive complete: $TARGET ($(human_size "$BYTES"), ${DURATION}s, sha256=${CHECKSUM:0:16}…)"

META="$OUTPUT_DIR/$BASENAME.meta"
{
  printf 'kind=uploads\n'
  printf 'created_at=%s\n' "$STAMP"
  printf 'label=%s\n' "$LABEL"
  printf 'source_dir=%s\n' "$UPLOADS_DIR"
  printf 'file_count=%s\n' "$FILE_COUNT"
  printf 'bytes=%s\n' "$BYTES"
  printf 'sha256=%s\n' "$CHECKSUM"
  printf 'host=%s\n' "$(hostname)"
} >"$META"

S3_URI=""
if [[ "$NO_UPLOAD" == "true" ]]; then
  warn "--no-upload: this archive exists ONLY on the EBS volume. EBS is not a backup."
else
  KEY="$BACKUP_PREFIX/uploads/$BASENAME"
  s3_put "$TARGET" "$KEY" >/dev/null
  s3_put "$CHECKSUM_FILE" "$KEY.sha256" >/dev/null
  s3_put "$META" "$KEY.meta" >/dev/null
  S3_URI="s3://$BACKUP_BUCKET/$KEY"
  info "off-host copy verified: $S3_URI"
  prune_local_backups "uploads" "bhoomitrace-" "${BACKUP_LOCAL_RETENTION_DAYS:-7}"
fi

info "BACKUP RESULT: SUCCESS kind=uploads file=$BASENAME bytes=$BYTES files=$FILE_COUNT s3=${S3_URI:-none}"
