#!/usr/bin/env bash
# Static tests for GHCR image publishing and retention safety configuration.
#
# These assertions lock in the behaviour we need to keep `docker pull` working
# on the deployment host:
#   * both images are published with an immutable full-SHA tag,
#   * `latest` stays gated to the default branch,
#   * the publish workflow cannot delete package versions (report-only audit),
#   * the manual retention report is report-only and read-only,
#   * the retention helper protects untagged manifests/attestations and gates
#     destructive deletion behind an explicit opt-in.
#
# It only reads files; it never contacts GitHub or GHCR and never runs Docker.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PUBLISH="$REPO_DIR/.github/workflows/publish-image.yml"
REPORT="$REPO_DIR/.github/workflows/ghcr-retention-report.yml"
RETENTION="$REPO_DIR/.github/scripts/ghcr-retention.sh"

PASS=0
FAIL=0

record() {
  local ok="$1" name="$2" detail="${3:-}"
  if [ "$ok" = "1" ]; then
    PASS=$((PASS + 1))
    echo "PASS: $name"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $name"
    [ -n "$detail" ] && printf '%s\n' "$detail" | sed 's/^/    /'
  fi
}

# Extract a block delimited by `  <job>:` at 2-space indentation, stopping at the
# next 2-space-indented job key or a top-level key.
job_block() {
  local file="$1" job="$2"
  awk -v job="$job" '
    BEGIN { inblock = 0 }
    $0 ~ "^  " job ":" { inblock = 1; print; next }
    inblock && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { exit }
    inblock && /^[A-Za-z]/ { exit }
    inblock { print }
  ' "$file"
}

assert_file() {
  local name="$1" path="$2"
  if [ -s "$path" ]; then
    record 1 "$name"
  else
    record 0 "$name" "missing or empty: $path"
  fi
}

assert_contains() {
  local name="$1" path="$2" needle="$3"
  if grep -qF -- "$needle" "$path"; then
    record 1 "$name"
  else
    record 0 "$name" "expected to find: $needle in $path"
  fi
}

assert_not_contains() {
  local name="$1" path="$2" needle="$3"
  if grep -qF -- "$needle" "$path"; then
    record 0 "$name" "must not contain: $needle (found in $path)"
  else
    record 1 "$name"
  fi
}

echo "== publish workflow and retention safety configuration =="

assert_file "publish-image.yml exists" "$PUBLISH"
assert_file "ghcr-retention-report.yml exists" "$REPORT"
assert_file "ghcr-retention.sh exists" "$RETENTION"

# --- both images are published -------------------------------------------------
assert_contains "publish workflow builds the backend image" "$PUBLISH" "image: bhoomitrace-backend"
assert_contains "publish workflow builds the frontend image" "$PUBLISH" "image: bhoomitrace-frontend"
assert_contains "backend Dockerfile is referenced" "$PUBLISH" "./backend/Dockerfile"
assert_contains "frontend Dockerfile is referenced" "$PUBLISH" "./frontend/Dockerfile"
assert_file "backend/Dockerfile exists" "$REPO_DIR/backend/Dockerfile"
assert_file "frontend/Dockerfile exists" "$REPO_DIR/frontend/Dockerfile"

# --- immutable sha tags and gated latest --------------------------------------
assert_contains "images are tagged with the immutable full commit SHA" "$PUBLISH" "type=sha,format=long"
assert_contains "latest is restricted to the default branch" "$PUBLISH" "type=raw,value=latest,enable={{is_default_branch}}"

# --- destructive retention is disabled in the publish path --------------------
assert_not_contains "publish workflow never runs deletion mode" "$PUBLISH" "MODE: delete"
assert_contains "publish workflow runs the retention audit in report mode" "$PUBLISH" "MODE: report"
assert_contains "publish workflow uses a dedicated report-only audit job" "$PUBLISH" "retention-audit:"

AUDIT_BLOCK="$(job_block "$PUBLISH" "retention-audit")"
if [ -z "$AUDIT_BLOCK" ]; then
  record 0 "retention-audit job is present" "could not extract the retention-audit job"
else
  case "$AUDIT_BLOCK" in
    *"packages: read"*) record 1 "retention-audit job can only read packages" ;;
    *) record 0 "retention-audit job can only read packages" "packages: read missing from the retention-audit job" ;;
  esac
  case "$AUDIT_BLOCK" in
    *"packages: write"*) record 0 "retention-audit job cannot write/delete packages" "packages: write found in the retention-audit job" ;;
    *) record 1 "retention-audit job cannot write/delete packages" ;;
  esac
  case "$AUDIT_BLOCK" in
    *"MODE: report"*) record 1 "retention-audit job runs in report mode" ;;
    *) record 0 "retention-audit job runs in report mode" "MODE: report missing from the retention-audit job" ;;
  esac
fi

# The publish job legitimately needs packages: write to push images.
PUBLISH_BLOCK="$(job_block "$PUBLISH" "publish")"
case "$PUBLISH_BLOCK" in
  *"packages: write"*) record 1 "publish job keeps packages: write (needed to push)" ;;
  *) record 0 "publish job keeps packages: write (needed to push)" "publish job lost packages: write" ;;
esac

# --- the manual report workflow is report-only and read-only ------------------
assert_not_contains "manual report workflow never runs deletion mode" "$REPORT" "MODE: delete"
assert_contains "manual report workflow runs in report mode" "$REPORT" "MODE: report"
assert_contains "manual report workflow can only read packages" "$REPORT" "packages: read"
assert_not_contains "manual report workflow cannot write/delete packages" "$REPORT" "packages: write"

# --- the helper itself enforces the safety net --------------------------------
assert_contains "retention helper gates deletion on an explicit opt-in" "$RETENTION" "RETENTION_ALLOW_DELETE"
assert_contains "retention helper computes a protected set" "$RETENTION" "protected_ids"
assert_contains "retention helper never deletes untagged versions" "$RETENTION" "delete an untagged version"

echo
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
