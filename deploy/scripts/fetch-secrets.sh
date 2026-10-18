#!/usr/bin/env bash
# Fetches the runtime secrets from AWS SSM Parameter Store or Secrets Manager and
# writes deploy/env/secrets.env with mode 0600.
#
#   sudo deploy/scripts/fetch-secrets.sh
#   sudo deploy/scripts/fetch-secrets.sh --parameter /bhoomitrace/prod/secrets
#   sudo deploy/scripts/fetch-secrets.sh --parameter arn:aws:secretsmanager:...:secret:bhoomitrace/prod
#
# Credentials come from the EC2 instance role. No access key is read from a file,
# passed as an argument, or written anywhere: the AWS CLI's default credential
# chain resolves the instance profile. Nothing here echoes a secret value.
#
# Expected secret payload (JSON object):
#   {
#     "POSTGRES_PASSWORD": "<32+ URL-safe characters>",
#     "GEMINI_API_KEY": "...",   # optional
#     "GROQ_API_KEY": "..."      # optional
#   }
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="fetch-secrets"
PARAMETER_NAME=""
AWS_REGION_OVERRIDE=""

usage() {
  cat >&2 <<'EOF'
Usage: fetch-secrets.sh [--parameter NAME_OR_ARN] [--region REGION]

  --parameter   SSM parameter name or path, or a Secrets Manager ARN
                (default: $BHOOMITRACE_SECRETS_PARAMETER from stack.env)
  --region      AWS region (default: $AWS_REGION from stack.env, then the
                instance metadata region)

Writes deploy/env/secrets.env (mode 0600). Requires the AWS CLI and an IAM role
that allows ssm:GetParameter (or secretsmanager:GetSecretValue) plus kms:Decrypt.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parameter)
      [[ $# -ge 2 ]] || die "--parameter needs a value"
      PARAMETER_NAME="$2"
      shift 2
      ;;
    --region)
      [[ $# -ge 2 ]] || die "--region needs a value"
      AWS_REGION_OVERRIDE="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) usage; die "unexpected argument: $1" ;;
  esac
done

load_config
require_cmd aws
require_cmd jq
require_cmd install

PARAMETER_NAME="${PARAMETER_NAME:-${BHOOMITRACE_SECRETS_PARAMETER:-}}"
if [[ -z "$PARAMETER_NAME" ]]; then
  die "no secret location given: pass --parameter, or set BHOOMITRACE_SECRETS_PARAMETER in $STACK_ENV_FILE"
fi

AWS_REGION_OVERRIDE="${AWS_REGION_OVERRIDE:-${AWS_REGION:-}}"

# --- Resolve the region -----------------------------------------------------
# Without a region the CLI would fail with a less actionable message.
if [[ -z "$AWS_REGION_OVERRIDE" ]]; then
  TOKEN="$(curl -fsS -X PUT --max-time 5 \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
    http://169.254.169.254/latest/api/token 2>/dev/null || true)"
  if [[ -n "$TOKEN" ]]; then
    AWS_REGION_OVERRIDE="$(curl -fsS --max-time 5 \
      -H "X-aws-ec2-metadata-token: $TOKEN" \
      http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || true)"
  fi
fi

if [[ -z "$AWS_REGION_OVERRIDE" ]]; then
  die "AWS region unknown: pass --region or set AWS_REGION in $STACK_ENV_FILE"
fi
export AWS_REGION="$AWS_REGION_OVERRIDE"

# --- Fetch ------------------------------------------------------------------
# Distinguish the two services by ARN shape so one script covers both.
info "reading secret from AWS (region=$AWS_REGION)"
SECRET_JSON=""
case "$PARAMETER_NAME" in
  arn:aws:secretsmanager:*)
    info "source=secretsmanager (the value itself is never logged)"
    if ! SECRET_JSON="$(aws secretsmanager get-secret-value \
      --secret-id "$PARAMETER_NAME" \
      --query 'SecretString' \
      --output text 2>&1)"; then
      error "secretsmanager GetSecretValue failed"
      printf '%s\n' "$SECRET_JSON" >&2
      die "check the instance role permission (secretsmanager:GetSecretValue) and any KMS key policy"
    fi
    ;;
  *)
    info "source=ssm parameter store"
    if ! SECRET_JSON="$(aws ssm get-parameter \
      --name "$PARAMETER_NAME" \
      --with-decryption \
      --query 'Parameter.Value' \
      --output text 2>&1)"; then
      error "ssm GetParameter failed"
      printf '%s\n' "$SECRET_JSON" >&2
      die "check the instance role permission (ssm:GetParameter) and the KMS key used for decryption"
    fi
    ;;
esac

[[ -n "$SECRET_JSON" && "$SECRET_JSON" != "None" ]] || die "secret payload is empty"

# --- Validate ---------------------------------------------------------------
# Validation happens before anything is written, so a bad payload leaves the
# previous secrets file in place rather than half-replacing it.
if ! printf '%s' "$SECRET_JSON" | jq -e 'type == "object"' >/dev/null 2>&1; then
  die "secret payload is not a JSON object; refusing to write a secrets file from it"
fi

PG_PASSWORD="$(printf '%s' "$SECRET_JSON" | jq -r '.POSTGRES_PASSWORD // empty')"
[[ -n "$PG_PASSWORD" ]] || die "secret payload has no POSTGRES_PASSWORD key"

if [[ ${#PG_PASSWORD} -lt 24 ]]; then
  die "POSTGRES_PASSWORD is shorter than 24 characters; refusing to use a weak credential"
fi

# The password is interpolated into DATABASE_URL, so a character that needs URL
# encoding would silently produce an unreachable database.
if [[ ! "$PG_PASSWORD" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  die "POSTGRES_PASSWORD contains characters outside [A-Za-z0-9._~-]; it is embedded in DATABASE_URL and must be URL-safe (generate with: openssl rand -hex 32)"
fi

# --- Write ------------------------------------------------------------------
# umask + a temp file in the same directory + atomic rename: a reader never sees
# a partially written file, and the file is never world-readable, even briefly.
umask 077
TARGET="$SECRETS_ENV_FILE"
TMP="$(mktemp "$(dirname "$TARGET")/.secrets.env.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

{
  printf '# Generated by deploy/scripts/fetch-secrets.sh — do not commit.\n'
  printf '# Source: %s\n' "$PARAMETER_NAME"
  printf '# Generated (UTC): %s\n\n' "$(_timestamp)"
  printf 'POSTGRES_PASSWORD=%s\n' "$PG_PASSWORD"
  for key in GEMINI_API_KEY GROQ_API_KEY; do
    value="$(printf '%s' "$SECRET_JSON" | jq -r --arg k "$key" '.[$k] // empty')"
    if [[ -n "$value" ]]; then
      printf '%s=%s\n' "$key" "$value"
      info "wrote key: $key"
    fi
  done
  printf '\n# Only the keys listed above are present. Values are never logged.\n'
} >"$TMP"

install -m 600 -o root -g root "$TMP" "$TARGET" 2>/dev/null || install -m 600 "$TMP" "$TARGET"
rm -f "$TMP"
trap - EXIT

info "wrote $TARGET (mode 600)"
