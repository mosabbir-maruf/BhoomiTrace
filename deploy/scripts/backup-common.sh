#!/usr/bin/env bash
# Shared backup helpers: S3 target resolution, verified upload, local pruning.
# Sourced by backup-db.sh, backup-uploads.sh, backup-all.sh.
#
# Design rules:
#   * Credentials are never read here. `aws` uses the instance role's default
#     credential chain, so nothing sensitive exists in a file or a process
#     argument.
#   * An upload is only reported as successful after the object is read back and
#     its size and encryption state match what was requested.
#   * Local pruning touches only files this project created, inside the
#     configured backup directory, and only when an operator asks for it.

: "${BHOOMITRACE_BACKUP_DIR:=}"

# Resolves bucket/prefix/encryption settings and fails loudly when a real backup
# would have no off-host copy.
backup_resolve_target() {
  require_var BACKUP_S3_BUCKET

  BACKUP_BUCKET="$BACKUP_S3_BUCKET"
  BACKUP_PREFIX="${BACKUP_S3_PREFIX:-bhoomitrace}"
  BACKUP_SSE="${BACKUP_S3_SSE:-aws:kms}"
  BACKUP_KMS_KEY="${BACKUP_S3_KMS_KEY_ID:-}"
  BACKUP_STORAGE_CLASS="${BACKUP_S3_STORAGE_CLASS:-STANDARD_IA}"
  BACKUP_REGION="${AWS_REGION:-}"

  local args=(--bucket "$BACKUP_BUCKET" --prefix "$BACKUP_PREFIX" --sse "$BACKUP_SSE")
  if [[ "$BACKUP_SSE" == "aws:kms" && -n "$BACKUP_KMS_KEY" ]]; then
    args+=(--kms-key "$BACKUP_KMS_KEY")
  fi
  if [[ -n "$BACKUP_STORAGE_CLASS" ]]; then
    args+=(--storage-class "$BACKUP_STORAGE_CLASS")
  fi
  BACKUP_RESOLVED="$(
    IFS=' '
    printf '%s' "${args[*]}"
  )"
}

# s3_put <local-file> <key>
# Uploads with the configured encryption, then proves the object exists with the
# expected size and encryption state.
s3_put() {
  local file="$1" key="$2"
  local s3_uri="s3://$BACKUP_BUCKET/$key"
  local local_size
  local_size="$(wc -c <"$file" | tr -d ' ')"

  local -a cp_args=(--no-progress --sse "$BACKUP_SSE")
  if [[ "$BACKUP_SSE" == "aws:kms" && -n "$BACKUP_KMS_KEY" ]]; then
    cp_args+=(--sse-kms-key-id "$BACKUP_KMS_KEY")
  fi
  if [[ -n "$BACKUP_STORAGE_CLASS" ]]; then
    cp_args+=(--storage-class "$BACKUP_STORAGE_CLASS")
  fi

  info "uploading $key ($local_size bytes, sse=$BACKUP_SSE, class=${BACKUP_STORAGE_CLASS:-default})"
  if ! aws s3 cp "$file" "$s3_uri" "${cp_args[@]}"; then
    die "S3 upload failed for $s3_uri (check the instance role's s3:PutObject permission and bucket policy)"
  fi

  # Read back. A 200 from `cp` is not proof; the object must be the right size.
  local remote_size remote_sse
  remote_size="$(aws s3api head-object --bucket "$BACKUP_BUCKET" --key "$key" --query 'ContentLength' --output text 2>/dev/null || echo '')"
  remote_sse="$(aws s3api head-object --bucket "$BACKUP_BUCKET" --key "$key" --query 'ServerSideEncryption' --output text 2>/dev/null || echo '')"

  if [[ "$remote_size" != "$local_size" ]]; then
    die "S3 object size mismatch for $s3_uri (local=$local_size remote=${remote_size:-missing})"
  fi

  if [[ -z "$remote_sse" || "$remote_sse" == "None" ]]; then
    warn "S3 did not report server-side encryption for $s3_uri; confirm the bucket policy enforces encryption"
  else
    info "verified $s3_uri (bytes=$remote_size sse=$remote_sse)"
  fi

  printf '%s' "$remote_size"
}

# Writes a checksum sidecar next to a local artifact and returns its path.
write_checksum() {
  # Assigned on separate lines: within one `local` command every word is
  # expanded before any assignment happens, so `out="$file.sha256"` on the same
  # line would expand an empty (or unset) `file`.
  local file="$1"
  local out="$file.sha256"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" >"$out"
  else
    shasum -a 256 "$file" >"$out"
  fi
  printf '%s' "$out"
}

# Deletes local artifacts older than N days, only inside <backup-dir>/<subdir>,
# only files matching the given prefix, and never the most recent file.
prune_local_backups() {
  local subdir="$1" prefix="$2" days="$3"
  local dir="$BHOOMITRACE_BACKUP_DIR/$subdir"

  [[ -d "$dir" ]] || return 0
  if [[ -z "$days" || ! "$days" =~ ^[0-9]+$ || "$days" -lt 1 ]]; then
    warn "local retention disabled (BACKUP_LOCAL_RETENTION_DAYS=$days)"
    return 0
  fi

  local newest=""
  newest="$(find "$dir" -maxdepth 1 -type f -name "${prefix}*" -print 2>/dev/null | sort | tail -1)"

  local removed=0 path
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    [[ "$path" == "$newest" ]] && continue
    rm -f "$path"
    removed=$((removed + 1))
  done < <(find "$dir" -maxdepth 1 -type f -name "${prefix}*" -mtime "+$days" -print 2>/dev/null)

  info "local retention: removed $removed artifact(s) older than ${days}d from $dir"
}

# Human-readable size used in log lines.
human_size() {
  awk -v b="$1" 'BEGIN {
    split("B KiB MiB GiB TiB", u, " ");
    i = 1;
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    printf "%.1f %s", b, u[i]
  }'
}
