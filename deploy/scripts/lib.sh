#!/usr/bin/env bash
# Shared helpers for the BhoomiTrace production deployment scripts.
#
# Sourced, never executed:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#
# Rules this file enforces for every caller:
#   * No secret value is ever printed. Scripts log key names, never values.
#   * Paths come from the environment files, so nothing is hard-coded per host.
#   * Failures are loud and non-zero, so a systemd timer or a deploy step cannot
#     silently succeed.

set -Eeuo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$LIB_DIR/.." && pwd)"
REPO_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"

# Environment files. Overridable so the local verification harness can point at
# throwaway copies without touching deploy/env/.
STACK_ENV_FILE="${BHOOMITRACE_STACK_ENV:-$DEPLOY_DIR/env/stack.env}"
SECRETS_ENV_FILE="${BHOOMITRACE_SECRETS_ENV:-$DEPLOY_DIR/env/secrets.env}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"

# Exported because the Compose file interpolates these names itself (service
# env_file paths). The default resolves to the real files; a harness can point
# them at a throwaway directory.
export BHOOMITRACE_STACK_ENV="$STACK_ENV_FILE"
export BHOOMITRACE_SECRETS_ENV="$SECRETS_ENV_FILE"

# Compose project name. Overridable so a verification run cannot attach to, or
# interfere with, the real production stack on the same host.
PROJECT_NAME="${BHOOMITRACE_PROJECT_NAME:-bhoomitrace-prod}"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

BHOOMITRACE_LOG_FILE="${BHOOMITRACE_LOG_FILE:-}"
BHOOMITRACE_SCRIPT_NAME="${BHOOMITRACE_SCRIPT_NAME:-$(basename "${BASH_SOURCE[1]:-bhoomitrace}")}"

_timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Attaches a durable log file for scheduled jobs. Creates the parent directory.
log_file_init() {
  local path="$1"
  [[ -n "$path" ]] || return 0
  mkdir -p "$(dirname "$path")"
  BHOOMITRACE_LOG_FILE="$path"
  : >>"$path"
}

# Appends one structured line to stderr and, when configured, to the log file.
_emit() {
  local level="$1"
  shift
  local line
  line="$(_timestamp) level=$level script=$BHOOMITRACE_SCRIPT_NAME msg=$*"
  printf '%s\n' "$line" >&2
  if [[ -n "$BHOOMITRACE_LOG_FILE" ]]; then
    printf '%s\n' "$line" >>"$BHOOMITRACE_LOG_FILE"
  fi
}

info() { _emit INFO "$@"; }
warn() { _emit WARN "$@"; }
error() { _emit ERROR "$@"; }

# Prints a banner for operations that must be hard to miss in a terminal.
banner() {
  printf '\n%s\n%s\n%s\n\n' \
    '===============================================================' \
    "$*" \
    '===============================================================' >&2
  if [[ -n "$BHOOMITRACE_LOG_FILE" ]]; then
    printf 'BANNER %s\n' "$*" >>"$BHOOMITRACE_LOG_FILE"
  fi
}

die() {
  error "$@"
  exit 1
}

# Wraps the whole command so a failure is always attributed and always non-zero.
run() {
  if ! "$@"; then
    die "command failed: $*"
  fi
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

require_cmd() {
  local name
  for name in "$@"; do
    command -v "$name" >/dev/null 2>&1 || die "required command not found: $name"
  done
}

require_file() {
  local path="$1" description="${2:-file}"
  [[ -f "$path" ]] || die "$description not found: $path"
}

require_dir() {
  local path="$1" description="${2:-directory}"
  [[ -d "$path" ]] || die "$description not found: $path"
}

require_var() {
  local name value
  for name in "$@"; do
    value="${!name:-}"
    [[ -n "$value" ]] || die "required configuration value is empty: $name (set it in ${STACK_ENV_FILE##*/})"
  done
}

# Refuses to run as a non-root user when the operation needs root.
require_root() {
  [[ "$(id -u)" == "0" ]] || die "this step must run as root (use sudo)"
}

# ---------------------------------------------------------------------------
# Configuration loading
# ---------------------------------------------------------------------------

# Loads stack.env (non-secret) and, when present and requested, secrets.env.
# Sourcing is used because these files are a flat KEY=VALUE list maintained by
# the operator. Values are exported for child processes.
load_config() {
  require_file "$STACK_ENV_FILE" "stack environment file"
  set -a
  # shellcheck disable=SC1090
  source "$STACK_ENV_FILE"
  set +a
}

load_secrets() {
  require_file "$SECRETS_ENV_FILE" "secrets environment file (run scripts/fetch-secrets.sh)"
  local mode
  mode="$(stat -c '%a' "$SECRETS_ENV_FILE" 2>/dev/null || stat -f '%Lp' "$SECRETS_ENV_FILE" 2>/dev/null || echo '')"
  if [[ -n "$mode" && "$mode" != "600" ]]; then
    warn "$SECRETS_ENV_FILE is mode $mode; 600 is expected (chmod 600 will be applied)"
    chmod 600 "$SECRETS_ENV_FILE"
  fi
  set -a
  # shellcheck disable=SC1090
  source "$SECRETS_ENV_FILE"
  set +a
}

# ---------------------------------------------------------------------------
# Compose
# ---------------------------------------------------------------------------

# The single supported way to invoke the production stack, so every command gets
# the same project directory and the same two environment files.
compose() {
  docker compose \
    --project-directory "$DEPLOY_DIR" \
    --project-name "$PROJECT_NAME" \
    -f "$COMPOSE_FILE" \
    --env-file "$STACK_ENV_FILE" \
    --env-file "$SECRETS_ENV_FILE" \
    "$@"
}

# Container state as a single JSON array.
#
# `docker compose ps --format json` emits one JSON object *per line* (NDJSON),
# not an array, so `jq '.[] | ...'` over its raw output fails with
# "Cannot index string with string" — a failure that is easy to miss because
# `|| true` and `2>/dev/null` swallow it. Slurping here means callers can rely
# on an array. Returns `[]` when no containers are present.
compose_ps_json() {
  compose ps -a --format json 2>/dev/null | jq -s '.' 2>/dev/null || printf '[]'
}

# ---------------------------------------------------------------------------
# Verification mode
# ---------------------------------------------------------------------------
#
# The local harness validates this stack on a Docker host that has no EBS mount,
# no real hostname, and no certificate. Verification mode relaxes exactly those
# host-property assertions, and nothing else, and it is refused unless the caller
# asks for it explicitly. It never relaxes TLS or secret handling.

verify_mode_enabled() {
  [[ "${BHOOMITRACE_VERIFY_MODE:-false}" == "true" ]]
}

require_verify_mode_banner() {
  verify_mode_enabled || return 0
  banner "VERIFICATION MODE — checks relaxed for a disposable local run. NOT a production deployment."
}

# ---------------------------------------------------------------------------
# State (recorded releases, for rollback)
# ---------------------------------------------------------------------------

state_dir() {
  printf '%s' "${BHOOMITRACE_STATE_DIR:-$DEPLOY_DIR/state}"
}

backup_dir() {
  printf '%s' "${BHOOMITRACE_BACKUP_DIR:-$DEPLOY_DIR/backups}"
}

# ---------------------------------------------------------------------------
# Explicit confirmation for destructive operations
# ---------------------------------------------------------------------------

# Double gate for anything that would overwrite production data:
#   1. the operator passes an explicit flag, and
#   2. the environment carries a sentinel string that no default ever sets.
# When a terminal is attached, typing the target name is required as well.
require_production_overwrite_confirmation() {
  local target_name="$1" flag_given="$2" sentinel_var="$3" typed=""

  [[ "$flag_given" == "true" ]] || die "refusing to overwrite production data without --force-production"
  [[ "${!sentinel_var:-}" == "overwrite-production-data" ]] || die \
    "refusing to overwrite production data: set ${sentinel_var}=overwrite-production-data to acknowledge that this destroys the current database and/or evidence"

  if [[ -t 0 ]]; then
    printf 'Type "%s" to confirm overwriting production data: ' "$target_name" >&2
    read -r typed
    [[ "$typed" == "$target_name" ]] || die "confirmation text did not match; aborted"
  fi
}

# ---------------------------------------------------------------------------
# CloudWatch metrics (optional)
# ---------------------------------------------------------------------------
#
# Disabled unless BHOOMITRACE_CLOUDWATCH_NAMESPACE is set, so local runs and the
# verification harness never try to reach AWS. Publishing is best-effort: a
# missing metric must never turn a successful backup into a failed one.
#
# Metrics this project publishes:
#   BackupSuccess / BackupFailure  (from backup-all.sh)
#   HealthCheckFailure             (from health-check.sh)

ec2_instance_id() {
  if [[ -n "${BHOOMITRACE_INSTANCE_ID:-}" ]]; then
    printf '%s' "$BHOOMITRACE_INSTANCE_ID"
    return 0
  fi
  local token id
  token="$(curl -fsS -X PUT --max-time 2 \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
    http://169.254.169.254/latest/api/token 2>/dev/null || true)"
  if [[ -n "$token" ]]; then
    id="$(curl -fsS --max-time 2 -H "X-aws-ec2-metadata-token: $token" \
      http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)"
  else
    id="$(curl -fsS --max-time 2 http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)"
  fi
  [[ -n "$id" ]] && BHOOMITRACE_INSTANCE_ID="$id"
  printf '%s' "${id:-unknown-instance}"
}

publish_metric() {
  local name="$1" value="$2"
  [[ -n "${BHOOMITRACE_CLOUDWATCH_NAMESPACE:-}" ]] || return 0

  if ! command -v aws >/dev/null 2>&1; then
    warn "CloudWatch metrics enabled but the aws CLI is not installed; skipping $name"
    return 0
  fi

  local instance_id
  instance_id="$(ec2_instance_id)"

  if aws cloudwatch put-metric-data \
    --namespace "$BHOOMITRACE_CLOUDWATCH_NAMESPACE" \
    --metric-name "$name" \
    --value "$value" \
    --unit Count \
    --dimensions "InstanceId=$instance_id" >/dev/null 2>&1; then
    info "published metric $name=$value (namespace=$BHOOMITRACE_CLOUDWATCH_NAMESPACE instance=$instance_id)"
  else
    warn "failed to publish metric $name (alarms will not see this run)"
  fi
}

# ---------------------------------------------------------------------------
# Certificates
# ---------------------------------------------------------------------------
#
# `openssl x509 -ext` is unavailable in LibreSSL (the system openssl on macOS),
# where it would silently return nothing and turn a real SAN check into a no-op.
# This helper produces the same information on both toolchains: `-ext` when
# supported, otherwise the equivalent section of the full text dump.
certificate_san() {
  local path="$1" out=""
  out="$(openssl x509 -in "$path" -noout -ext subjectAltName 2>/dev/null || true)"
  if [[ -z "$out" ]]; then
    out="$(openssl x509 -in "$path" -noout -text 2>/dev/null |
      awk '/X509v3 Subject Alternative Name/{found=1; next} found && NF {print; exit}' || true)"
  fi
  printf '%s' "$out"
}

# SHA-256 of a PEM public key, used to prove a certificate and key pair match.
public_key_digest() {
  openssl dgst -sha256 2>/dev/null | awk '{print $NF}'
}

# ---------------------------------------------------------------------------
# Disk
# ---------------------------------------------------------------------------

# Emits "<used-percent> <available-kib>" for the filesystem holding a path.
disk_usage_percent() {
  df -Pk "$1" | awk 'NR==2 {gsub("%", "", $5); print $5}'
}

disk_available_kib() {
  df -Pk "$1" | awk 'NR==2 {print $4}'
}

# Human-readable byte count for a path (GNU stat, then BSD stat).
path_size_bytes() {
  local path="$1"
  du -sk "$path" 2>/dev/null | awk '{print $1 * 1024}'
}
