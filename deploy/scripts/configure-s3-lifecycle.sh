#!/usr/bin/env bash
# Applies the S3 lifecycle (retention) policy that removes old backups, and
# optionally the encryption and TLS-only settings that protect the bucket.
#
#   sudo deploy/scripts/configure-s3-lifecycle.sh --dry-run
#   sudo deploy/scripts/configure-s3-lifecycle.sh
#   sudo deploy/scripts/configure-s3-lifecycle.sh --apply-encryption --apply-tls-only-policy
#
# Run this once when the bucket is created. It is idempotent: the policy is put,
# then read back and printed, so what is in effect is visible rather than assumed.
#
# Credentials come from the instance role. Nothing about the bucket is guessed:
# the bucket name, prefix, retention days, and encryption settings all come from
# deploy/env/stack.env.
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="configure-s3-lifecycle"

DRY_RUN=false
APPLY_ENCRYPTION=false
APPLY_TLS_ONLY_POLICY=false
EXPIRY_DAYS=""
RULE_ID="bhoomitrace-backup-retention"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --apply-encryption) APPLY_ENCRYPTION=true; shift ;;
    --apply-tls-only-policy) APPLY_TLS_ONLY_POLICY=true; shift ;;
    --expire-days)
      [[ $# -ge 2 ]] || die "--expire-days needs a value"
      EXPIRY_DAYS="$2"
      shift 2
      ;;
    -h | --help)
      echo "Usage: configure-s3-lifecycle.sh [--dry-run] [--expire-days N] [--apply-encryption] [--apply-tls-only-policy]" >&2
      exit 0
      ;;
    *) die "unexpected argument: $1" ;;
  esac
done

require_cmd aws jq
load_config
require_var BACKUP_S3_BUCKET

BUCKET="$BACKUP_S3_BUCKET"
PREFIX="${BACKUP_S3_PREFIX:-bhoomitrace}"
EXPIRY_DAYS="${EXPIRY_DAYS:-${BACKUP_RETENTION_DAYS:-30}}"
[[ "$EXPIRY_DAYS" =~ ^[0-9]+$ && "$EXPIRY_DAYS" -ge 1 ]] || die "expiry days must be a positive integer (got: $EXPIRY_DAYS)"

info "configuring bucket $BUCKET (prefix=$PREFIX retention=${EXPIRY_DAYS}d)"

# ---------------------------------------------------------------------------
# Lifecycle: expire backups, abort abandoned multipart uploads, and move old
# objects to cheaper storage before deleting them.
# ---------------------------------------------------------------------------
LIFECYCLE_JSON="$(jq -n \
  --arg prefix "$PREFIX/" \
  --arg id "$RULE_ID" \
  --argjson days "$EXPIRY_DAYS" \
  '{
    Rules: [
      {
        ID: $id,
        Status: "Enabled",
        Filter: { Prefix: $prefix },
        Transitions: [
          { Days: 1, StorageClass: "STANDARD_IA" },
          { Days: ($days / 2 | floor + 1), StorageClass: "GLACIER_IR" }
        ],
        Expiration: { Days: $days },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 }
      }
    ]
  }')"

if [[ "$DRY_RUN" == "true" ]]; then
  printf '%s\n' "$LIFECYCLE_JSON"
  info "DRY RUN: lifecycle policy not applied"
else
  if ! printf '%s' "$LIFECYCLE_JSON" | aws s3api put-bucket-lifecycle-configuration \
    --bucket "$BUCKET" \
    --lifecycle-configuration file:///dev/stdin; then
    die "could not apply the lifecycle policy to $BUCKET (check s3:PutLifecycleConfiguration)"
  fi
  info "lifecycle policy applied"

  # Read back: an accepted API call is not proof of what is in effect.
  APPLIED="$(aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" 2>/dev/null || true)"
  if [[ -z "$APPLIED" ]]; then
    warn "could not read back the lifecycle configuration"
  else
    printf '%s\n' "$APPLIED" | jq -c '.Rules[] | {ID, Status, Expiration, Filter}' >&2
    if printf '%s' "$APPLIED" | jq -e --arg id "$RULE_ID" '.Rules[] | select(.ID == $id)' >/dev/null 2>&1; then
      info "verified: rule '$RULE_ID' is present on $BUCKET"
    else
      die "the applied lifecycle configuration does not contain rule '$RULE_ID'"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Default encryption at rest
# ---------------------------------------------------------------------------
if [[ "$APPLY_ENCRYPTION" == "true" ]]; then
  ENC_JSON="$(jq -n --arg sse "${BACKUP_S3_SSE:-aws:kms}" --arg key "${BACKUP_S3_KMS_KEY_ID:-}" '
    if $sse == "aws:kms" and $key != "" then
      { Rules: [ { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: $sse, KMSMasterKeyID: $key }, BucketKeyEnabled: true } ] }
    else
      { Rules: [ { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: $sse }, BucketKeyEnabled: true } ] }
    end')"
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '%s\n' "$ENC_JSON" >&2
    info "DRY RUN: bucket encryption not applied"
  else
    printf '%s' "$ENC_JSON" | aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration file:///dev/stdin \
      || die "could not apply default bucket encryption"
    info "default bucket encryption applied and read back below"
    aws s3api get-bucket-encryption --bucket "$BUCKET" 2>/dev/null | jq -c . >&2 || warn "could not read back bucket encryption"
  fi
fi

# ---------------------------------------------------------------------------
# Deny any request that is not over TLS
# ---------------------------------------------------------------------------
if [[ "$APPLY_TLS_ONLY_POLICY" == "true" ]]; then
  POLICY_JSON="$(jq -n --arg bucket "$BUCKET" '{
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyUnencryptedTransport",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [ ("arn:aws:s3:::" + $bucket), ("arn:aws:s3:::" + $bucket + "/*") ],
        Condition: { Bool: { "aws:SecureTransport": "false" } }
      }
    ]
  }')"
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '%s\n' "$POLICY_JSON" >&2
    info "DRY RUN: bucket policy not applied"
  else
    printf '%s' "$POLICY_JSON" | aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///dev/stdin \
      || die "could not apply the TLS-only bucket policy"
    info "TLS-only bucket policy applied"
  fi
fi

info "S3 LIFECYCLE RESULT: SUCCESS bucket=$BUCKET retention_days=$EXPIRY_DAYS dry_run=$DRY_RUN"
