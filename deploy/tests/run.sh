#!/usr/bin/env bash
# Verification suite for the production deployment scripts and configuration.
#
#   deploy/tests/run.sh
#
# Requires: bash, git, docker (for the Compose tests). Does NOT require root, AWS
# credentials, a running stack, or a real certificate — the point is that the
# guards hold without any of those.
#
# What it checks:
#   * every script parses (bash -n) and is executable
#   * the production Compose file renders, and the rendered result keeps
#     PostgreSQL and the API off the host, forces production settings, and mounts
#     one shared upload directory into both the API and the worker
#   * preflight passes on a valid configuration and refuses: `latest` images,
#     wildcard/non-HTTPS CORS, a missing certificate, a data directory on the
#     root filesystem
#   * restore.sh's production gates refuse every incomplete confirmation
#   * restore.sh and db-summary.sh refuse unsafe targets
#   * fetch-secrets.sh writes nothing when the AWS call fails
#   * rollback.sh reports a missing release instead of doing something
#   * privileged scripts refuse to run as an unprivileged user
#   * health-check.sh reports FAILURE (not success) for a stack that is not running
set -Eeuo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$TESTS_DIR/.." && pwd)"
REPO_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
SCRIPTS_DIR="$DEPLOY_DIR/scripts"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/bhoomitrace-deploy-tests.XXXXXX")"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

PASSED=0
FAILED=0
SKIPPED=0
declare -a FAILED_NAMES=()

ok() {
  printf 'ok   %s\n' "$1"
  PASSED=$((PASSED + 1))
}
bad() {
  printf 'FAIL %s\n' "$1"
  printf '       %s\n' "$2" | head -6
  FAILED=$((FAILED + 1))
  FAILED_NAMES+=("$1")
}
skip() {
  printf 'SKIP %s (%s)\n' "$1" "$2"
  SKIPPED=$((SKIPPED + 1))
}

expect_ok() {
  local name="$1"
  shift
  local out
  if out="$("$@" 2>&1)"; then
    ok "$name"
  else
    bad "$name" "expected exit 0: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
  fi
}

expect_fail() {
  local name="$1" pattern="$2"
  shift 2
  local out
  if out="$("$@" 2>&1)"; then
    bad "$name" "expected a non-zero exit, got 0"
    return
  fi
  if printf '%s' "$out" | grep -qE "$pattern"; then
    ok "$name"
  else
    bad "$name" "output did not match /$pattern/: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
  fi
}

# ---------------------------------------------------------------------------
# Sandbox: a valid-looking production configuration on throwaway paths
# ---------------------------------------------------------------------------
DRILL_DOMAIN="app.bhoomitrace.test"
IMAGE_BACKEND="ghcr.io/bhoomitrace-ci/bhoomitrace-backend:sha-1111111111111111111111111111111111111111"
IMAGE_FRONTEND="ghcr.io/bhoomitrace-ci/bhoomitrace-frontend:sha-2222222222222222222222222222222222222222"
# A project name of its own, so the suite can never attach to a real stack.
TEST_PROJECT="bhoomitrace-deploy-tests"

mkdir -p "$SANDBOX/data/postgres" "$SANDBOX/data/uploads" "$SANDBOX/data/acme" \
  "$SANDBOX/tls" "$SANDBOX/state" "$SANDBOX/backups" "$SANDBOX/dumps" "$SANDBOX/logs"

printf 'not-a-real-dump' >"$SANDBOX/dumps/fake.dump"

# A self-signed certificate with the right SAN: preflight validates the name, not
# the chain, which is what a real deployment needs to check too.
if command -v openssl >/dev/null 2>&1; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
    -keyout "$SANDBOX/tls/privkey.pem" -out "$SANDBOX/tls/fullchain.pem" \
    -subj "/CN=$DRILL_DOMAIN" -addext "subjectAltName=DNS:$DRILL_DOMAIN" >/dev/null 2>&1
  chmod 600 "$SANDBOX/tls/privkey.pem"
fi

write_stack_env() {
  local path="$1"
  cat >"$path" <<EOF
# Test configuration — synthetic values only.
BHOOMITRACE_DATA_DIR=$SANDBOX/data
BHOOMITRACE_TLS_DIR=$SANDBOX/tls
BHOOMITRACE_BACKUP_DIR=$SANDBOX/backups
BHOOMITRACE_STATE_DIR=$SANDBOX/state
DOMAIN=$DRILL_DOMAIN
CORS_ALLOWED_ORIGINS=https://$DRILL_DOMAIN:18443
EDGE_HTTP_PORT=18080
EDGE_HTTPS_PORT=18443
BACKEND_IMAGE=$IMAGE_BACKEND
FRONTEND_IMAGE=$IMAGE_FRONTEND
POSTGRES_IMAGE=postgres:17-alpine
EDGE_IMAGE=nginx:1.30.6-alpine
POSTGRES_USER=bhoomitrace
POSTGRES_DB=bhoomitrace
POSTGRES_UID=70
UPLOAD_UID=1000
BACKUP_S3_BUCKET=
BACKUP_S3_PREFIX=bhoomitrace
BACKUP_S3_SSE=aws:kms
BACKUP_RETENTION_DAYS=30
BACKUP_LOCAL_RETENTION_DAYS=7
AWS_REGION=ap-south-1
LOG_LEVEL=info
EXTRACTION_PROVIDER=mock
EOF
  chmod 600 "$path"
}

write_secrets_env() {
  local path="$1"
  # A throwaway value for a disposable sandbox database. It is not, and has
  # never been, a credential for anything: the real password is generated per
  # host by scripts/fetch-secrets.sh and never enters the repository.
  cat >"$path" <<'EOF'
POSTGRES_PASSWORD=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff
EOF
  chmod 600 "$path"
}

write_stack_env "$SANDBOX/stack.env"
write_secrets_env "$SANDBOX/secrets.env"

# Runs a script against the sandbox configuration, never the real one.
sandbox_run() {
  env \
    BHOOMITRACE_STACK_ENV="$SANDBOX/stack.env" \
    BHOOMITRACE_SECRETS_ENV="$SANDBOX/secrets.env" \
    BHOOMITRACE_STATE_DIR="$SANDBOX/state" \
    BHOOMITRACE_BACKUP_DIR="$SANDBOX/backups" \
    BHOOMITRACE_LOG_FILE="$SANDBOX/logs/test.log" \
    BHOOMITRACE_PROJECT_NAME="$TEST_PROJECT" \
    BHOOMITRACE_ALLOW_ROOT_FS=true \
    BHOOMITRACE_ALLOW_NONROOT=true \
    AWS_EC2_METADATA_DISABLED=true \
    "$@"
}

# The same configuration, rendered by Compose directly (used to assert on the
# rendered result rather than on the scripts).
test_compose() {
  env \
    BHOOMITRACE_STACK_ENV="$SANDBOX/stack.env" \
    BHOOMITRACE_SECRETS_ENV="$SANDBOX/secrets.env" \
    BHOOMITRACE_PROJECT_NAME="$TEST_PROJECT" \
    docker compose \
    --project-directory "$DEPLOY_DIR" \
    --project-name "$TEST_PROJECT" \
    -f "$COMPOSE_FILE" \
    --env-file "$SANDBOX/stack.env" \
    --env-file "$SANDBOX/secrets.env" \
    "$@"
}

DOCKER_AVAILABLE=false
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  DOCKER_AVAILABLE=true
fi

printf '\n== BhoomiTrace deploy verification ==\n'
printf 'sandbox: %s\ndocker:  %s\n\n' "$SANDBOX" "$DOCKER_AVAILABLE"

# ---------------------------------------------------------------------------
printf -- '-- script hygiene --\n'
# ---------------------------------------------------------------------------
shopt -s nullglob
for script in "$SCRIPTS_DIR"/*.sh; do
  name="$(basename "$script")"
  expect_ok "$name parses" bash -n "$script"
  if [[ -x "$script" ]]; then
    ok "$name is executable"
  else
    bad "$name is executable" "mode is not executable (chmod +x needed)"
  fi

  # Argument parsing must always advance. A flag-only branch such as
  # `--no-upload) NO_UPLOAD=true ;;` without a shift loops forever, which is a
  # hang rather than an error — the worst possible failure mode for an operator.
  # (prepare-host.sh advances with a `shift` at the end of its loop body.)
  if ! grep -qE '^  shift$' "$script"; then
    offenders="$(grep -nE '^[[:space:]]+--[A-Za-z0-9-]+\)[^;]*=[a-zA-Z_]+[^;]*;;[[:space:]]*$' "$script" | grep -v 'shift' || true)"
    if [[ -z "$offenders" ]]; then
      ok "$name advances on every flag"
    else
      bad "$name advances on every flag" "flag branch without shift: $(printf '%s' "$offenders" | head -2 | tr '\n' ' ')"
    fi
  fi

  # `local a="$1" b="$a.x"` is a trap: in a single `local` command every value is
  # expanded before any name is assigned, so `$a` is empty (and with `set -u`,
  # fatal). Without shellcheck available this is checked directly.
  offenders="$(awk '
    /^[[:space:]]*local[[:space:]]/ {
      n = split($0, words, /[[:space:]]+/)
      for (i = 1; i <= n; i++) {
        if (words[i] !~ /^[A-Za-z_][A-Za-z0-9_]*=/) continue
        split(words[i], kv, "=")
        for (j = i + 1; j <= n; j++) {
          if (index(words[j], "$" kv[1]) > 0 || index(words[j], "${" kv[1] "}") > 0) {
            printf "%d: %s\n", FNR, $0
            break
          }
        }
      }
    }' "$script" || true)"
  # `pg_restore --list < dump | grep -q ';'` looks correct and fails in practice:
  # the consumer exits at the first match, the producer takes SIGPIPE, and
  # `set -o pipefail` reports the pipeline as failed. Any streamed producer
  # (a container exec, a database client) must be captured instead.
  offenders="$(grep -nE '(docker exec|compose exec|run_pg|run_psql|pg_restore|pg_dump|curl)[^|]*\|[[:space:]]*grep -q' "$script" || true)"
  if [[ -z "$offenders" ]]; then
    ok "$name does not pipe streamed output into grep -q"
  else
    bad "$name does not pipe streamed output into grep -q" "$(printf '%s' "$offenders" | head -2 | tr '\n' ' ')"
  fi

  # `docker compose ps --format json` is line-delimited, not an array, so a
  # jq filter that starts at `.[]` silently matches nothing. compose_ps_json in
  # lib.sh is the only supported reader; lib.sh itself defines it.
  if [[ "$name" != "lib.sh" ]]; then
    offenders="$(grep -nE 'compose ps .*--format json' "$script" || true)"
    if [[ -z "$offenders" ]]; then
      ok "$name reads container state through compose_ps_json"
    else
      bad "$name reads container state through compose_ps_json" "$(printf '%s' "$offenders" | head -2 | tr '\n' ' ')"
    fi
  fi
done

# Behavioural counterpart: a flag followed by --help must terminate.
expect_ok "restore.sh parses a flag then terminates" \
  sandbox_run "$SCRIPTS_DIR/restore.sh" --no-validate --help
expect_ok "deploy.sh parses a flag then terminates" \
  sandbox_run "$SCRIPTS_DIR/deploy.sh" --skip-backup --help
expect_ok "health-check.sh parses a flag then terminates" \
  sandbox_run "$SCRIPTS_DIR/health-check.sh" --insecure --skip-public --help
expect_ok "rollback.sh parses a flag then terminates" \
  sandbox_run "$SCRIPTS_DIR/rollback.sh" --yes --skip-health --help
expect_ok "backup-all.sh parses a flag then terminates" \
  sandbox_run "$SCRIPTS_DIR/backup-all.sh" --no-upload --db-only --help
expect_ok "restore-drill.sh parses a flag then terminates" \
  sandbox_run "$SCRIPTS_DIR/restore-drill.sh" --keep --skip-uploads --help
expect_ok "configure-s3-lifecycle.sh parses a flag then terminates" \
  sandbox_run "$SCRIPTS_DIR/configure-s3-lifecycle.sh" --dry-run --apply-encryption --help

# The Compose file must be valid YAML that Compose itself accepts.
if [[ "$DOCKER_AVAILABLE" == "true" ]]; then
  expect_ok "docker compose config accepts the production file" test_compose config -q
else
  skip "docker compose config accepts the production file" "no docker daemon"
fi

# compose.sh is the only path operators and systemd units use, so it must work
# as an executable script, not only as a sourced library. Running it through
# `exec` on a shell function fails at runtime while every static check passes.
expect_ok "compose.sh runs as an executable wrapper" \
  sandbox_run "$SCRIPTS_DIR/compose.sh" version

# Compose warns on any `${...}` it interpolates without a value. A stray one —
# for instance a JavaScript template literal inside a healthcheck command —
# silently rewrites the container command, so warnings are treated as failures.
if [[ "$DOCKER_AVAILABLE" == "true" ]]; then
  COMPOSE_WARNINGS="$(test_compose config -q 2>&1 >/dev/null || true)"
  if [[ -z "$COMPOSE_WARNINGS" ]]; then
    ok "docker compose config renders without interpolation warnings"
  else
    bad "docker compose config renders without interpolation warnings" \
      "$(printf '%s' "$COMPOSE_WARNINGS" | head -2 | tr '\n' ' ')"
  fi
fi

# ---------------------------------------------------------------------------
printf -- '\n-- compose ps parsing --\n'
# ---------------------------------------------------------------------------
# Fixture-driven unit test for the helper the scripts rely on, without needing a
# running stack. lib.sh is side-effect free to source and compose() is stubbed.
cat >"$SANDBOX/ps-parse-probe.sh" <<'PROBE'
#!/usr/bin/env bash
set -Eeuo pipefail
source "$1/lib.sh"
compose() {
  printf '%s\n' \
    '{"Service":"api","State":"running","Health":"healthy"}' \
    '{"Service":"migrate","State":"exited","ExitCode":0}' \
    '{"Service":"edge","State":"running","Health":"starting"}'
}
compose_ps_json
PROBE

# The real helper, exercised through a stubbed compose().
HELPER_JSON="$(bash "$SANDBOX/ps-parse-probe.sh" "$SCRIPTS_DIR" 2>/dev/null || true)"
HELPER_MIG="$(printf '%s' "$HELPER_JSON" | jq -r '[.[] | select(.Service == "migrate")] | first // "none" | .State + ":" + (.ExitCode|tostring)' 2>/dev/null || echo '')"
if [[ "$(printf '%s' "$HELPER_JSON" | jq -r 'type' 2>/dev/null)" == "array" ]] \
  && [[ "$(printf '%s' "$HELPER_JSON" | jq -r 'length' 2>/dev/null)" == "3" ]] \
  && [[ "$HELPER_MIG" == "exited:0" ]]; then
  ok "compose_ps_json returns a queryable array from line-delimited output"
else
  bad "compose_ps_json returns a queryable array from line-delimited output" \
    "type/length/migrate: $(printf '%s' "$HELPER_JSON" | jq -r 'type' 2>/dev/null)/$(printf '%s' "$HELPER_JSON" | jq -r 'length' 2>/dev/null)/${HELPER_MIG:-empty}"
fi

ndjson="$(printf '%s\n' '{"Service":"api","State":"running","Health":"healthy"}' '{"Service":"migrate","State":"exited","ExitCode":0}')"
SLURPED="$(printf '%s\n' "$ndjson" | jq -s '.' 2>/dev/null || true)"
if [[ "$(printf '%s' "$SLURPED" | jq -r 'type' 2>/dev/null)" == "array" ]] \
  && [[ "$(printf '%s' "$SLURPED" | jq -r 'length' 2>/dev/null)" == "2" ]]; then
  ok "line-delimited compose ps output is slurped into an array"
else
  bad "line-delimited compose ps output is slurped into an array" "got: ${SLURPED:-empty}"
fi

# The naive form the scripts previously used: it must not be treated as correct.
NAIVE="$(printf '%s\n' "$ndjson" | jq -r '[.[] | .Service] | join(",")' 2>/dev/null || true)"
if [[ -z "$NAIVE" ]]; then
  ok "an un-slurped .[] query over the same input fails loudly"
else
  bad "an un-slurped .[] query over the same input fails loudly" "unexpectedly produced: $NAIVE"
fi

MIG="$(printf '%s' "$SLURPED" | jq -r '[.[] | select(.Service == "migrate")] | first | .State + ":" + (.ExitCode|tostring)' 2>/dev/null || echo '')"
if [[ "$MIG" == "exited:0" ]]; then
  ok "the migration result is readable from the parsed array"
else
  bad "the migration result is readable from the parsed array" "got: ${MIG:-empty}"
fi

# ---------------------------------------------------------------------------
printf -- '\n-- rendered configuration invariants --\n'
# ---------------------------------------------------------------------------
if [[ "$DOCKER_AVAILABLE" == "true" ]]; then
  RENDERED="$(test_compose config --format json 2>/dev/null || echo '{}')"
  SERVICE_COUNT="$(printf '%s' "$RENDERED" | jq -r '(.services // {}) | length' 2>/dev/null || echo 0)"

  if [[ "$SERVICE_COUNT" -ge 6 ]]; then
    ok "production configuration renders ($SERVICE_COUNT services)"
  else
    bad "production configuration renders" "only $SERVICE_COUNT services rendered; the file did not interpolate"
  fi

  publishing="$(printf '%s' "$RENDERED" | jq -r '[.services | to_entries[] | select((.value.ports // []) | length > 0) | .key] | sort | join(",")' 2>/dev/null || echo '')"
  if [[ "$publishing" == "edge" ]]; then
    ok "only the edge proxy publishes ports"
  else
    bad "only the edge proxy publishes ports" "publishing services: [$publishing]"
  fi

  api_upload="$(printf '%s' "$RENDERED" | jq -r '[.services.api.volumes[]? | select(.target == "/data/uploads") | .source] | first // ""' 2>/dev/null || echo '')"
  worker_upload="$(printf '%s' "$RENDERED" | jq -r '[.services.worker.volumes[]? | select(.target == "/data/uploads") | .source] | first // ""' 2>/dev/null || echo '')"
  if [[ -n "$api_upload" && "$api_upload" == "$worker_upload" ]]; then
    ok "api and worker share one upload directory"
  else
    bad "api and worker share one upload directory" "api='$api_upload' worker='$worker_upload'"
  fi

  if [[ "$(printf '%s' "$RENDERED" | jq -r '.services.api.environment.NODE_ENV // ""')" == "production" \
    && "$(printf '%s' "$RENDERED" | jq -r '.services.api.environment.COOKIE_SECURE // ""')" == "true" \
    && "$(printf '%s' "$RENDERED" | jq -r '.services.api.environment.TRUST_PROXY // ""')" == "true" ]]; then
    ok "api environment is forced to production/secure-cookie/trust-proxy"
  else
    bad "api environment is forced to production/secure-cookie/trust-proxy" "see rendered configuration"
  fi

  SEED_RENDERED="$(test_compose --profile demo config --format json 2>/dev/null || echo '{}')"
  if printf '%s' "$SEED_RENDERED" | jq -e '.services.seed.profiles == ["demo"]' >/dev/null 2>&1; then
    ok "synthetic seed service stays behind the demo profile"
  else
    bad "synthetic seed service stays behind the demo profile" "profiles: $(printf '%s' "$SEED_RENDERED" | jq -c '.services.seed.profiles' 2>/dev/null)"
  fi

  if printf '%s' "$RENDERED" | jq -e '.services.postgres.environment.POSTGRES_PASSWORD != "bhoomitrace"' >/dev/null 2>&1; then
    ok "postgres does not use the example password"
  else
    bad "postgres does not use the example password" "rendered password equals the development default"
  fi

  # Every service that opens the database must wait for PostgreSQL to accept
  # queries. The one-shot migration job is the critical one: without this it
  # races a cold database, fails, and aborts the deployment.
  missing_dependency=""
  for service in migrate api worker seed; do
    condition="$(printf '%s' "$SEED_RENDERED" | jq -r ".services.${service}.depends_on.postgres.condition // \"\"" 2>/dev/null)"
    if [[ "$condition" != "service_healthy" ]]; then
      missing_dependency="$missing_dependency ${service}(${condition:-none})"
    fi
  done
  if [[ -z "$missing_dependency" ]]; then
    ok "migrate, api, worker and seed all wait for a healthy database"
  else
    bad "migrate, api, worker and seed all wait for a healthy database" "$missing_dependency"
  fi
else
  skip "rendered configuration invariants" "no docker daemon"
fi

# ---------------------------------------------------------------------------
printf -- '\n-- preflight --\n'
# ---------------------------------------------------------------------------
if [[ "$DOCKER_AVAILABLE" == "true" ]]; then
  expect_ok "preflight accepts a valid production configuration" \
    sandbox_run "$SCRIPTS_DIR/preflight.sh"

  # `latest` must be refused even though the rest of the configuration is fine.
  sed "s|^BACKEND_IMAGE=.*|BACKEND_IMAGE=ghcr.io/bhoomitrace-ci/bhoomitrace-backend:latest|" \
    "$SANDBOX/stack.env" >"$SANDBOX/stack-latest.env"
  chmod 600 "$SANDBOX/stack-latest.env"
  expect_fail "preflight refuses a 'latest' image tag" "latest" \
    env BHOOMITRACE_STACK_ENV="$SANDBOX/stack-latest.env" BHOOMITRACE_SECRETS_ENV="$SANDBOX/secrets.env" \
    BHOOMITRACE_ALLOW_ROOT_FS=true AWS_EC2_METADATA_DISABLED=true "$SCRIPTS_DIR/preflight.sh"

  sed 's|^CORS_ALLOWED_ORIGINS=.*|CORS_ALLOWED_ORIGINS=*|' \
    "$SANDBOX/stack.env" >"$SANDBOX/stack-cors.env"
  chmod 600 "$SANDBOX/stack-cors.env"
  expect_fail "preflight refuses a wildcard CORS origin" "wildcard|exactly" \
    env BHOOMITRACE_STACK_ENV="$SANDBOX/stack-cors.env" BHOOMITRACE_SECRETS_ENV="$SANDBOX/secrets.env" \
    BHOOMITRACE_ALLOW_ROOT_FS=true AWS_EC2_METADATA_DISABLED=true "$SCRIPTS_DIR/preflight.sh"

  sed 's|^CORS_ALLOWED_ORIGINS=.*|CORS_ALLOWED_ORIGINS=http://app.bhoomitrace.test|' \
    "$SANDBOX/stack.env" >"$SANDBOX/stack-http.env"
  chmod 600 "$SANDBOX/stack-http.env"
  expect_fail "preflight refuses a non-HTTPS origin" "not HTTPS" \
    env BHOOMITRACE_STACK_ENV="$SANDBOX/stack-http.env" BHOOMITRACE_SECRETS_ENV="$SANDBOX/secrets.env" \
    BHOOMITRACE_ALLOW_ROOT_FS=true AWS_EC2_METADATA_DISABLED=true "$SCRIPTS_DIR/preflight.sh"

  # The origin must name the port the edge publishes on. This stack publishes
  # 18443, so an origin without the port is wrong and must be refused.
  sed 's|^CORS_ALLOWED_ORIGINS=.*|CORS_ALLOWED_ORIGINS=https://app.bhoomitrace.test|' \
    "$SANDBOX/stack.env" >"$SANDBOX/stack-cors-port.env"
  chmod 600 "$SANDBOX/stack-cors-port.env"
  expect_fail "preflight refuses an origin that omits a non-default HTTPS port" "must be exactly" \
    env BHOOMITRACE_STACK_ENV="$SANDBOX/stack-cors-port.env" BHOOMITRACE_SECRETS_ENV="$SANDBOX/secrets.env" \
    BHOOMITRACE_ALLOW_ROOT_FS=true AWS_EC2_METADATA_DISABLED=true "$SCRIPTS_DIR/preflight.sh"

  # And the mirror image: on the default port the origin must not carry one.
  sed -e 's|^CORS_ALLOWED_ORIGINS=.*|CORS_ALLOWED_ORIGINS=https://app.bhoomitrace.test:18443|' \
    -e 's|^EDGE_HTTPS_PORT=.*|EDGE_HTTPS_PORT=443|' \
    "$SANDBOX/stack.env" >"$SANDBOX/stack-cors-default-port.env"
  chmod 600 "$SANDBOX/stack-cors-default-port.env"
  expect_fail "preflight refuses an origin with a port on the default HTTPS port" "must be exactly" \
    env BHOOMITRACE_STACK_ENV="$SANDBOX/stack-cors-default-port.env" BHOOMITRACE_SECRETS_ENV="$SANDBOX/secrets.env" \
    BHOOMITRACE_ALLOW_ROOT_FS=true AWS_EC2_METADATA_DISABLED=true "$SCRIPTS_DIR/preflight.sh"

  sed "s|^BHOOMITRACE_TLS_DIR=.*|BHOOMITRACE_TLS_DIR=$SANDBOX/missing-tls|" \
    "$SANDBOX/stack.env" >"$SANDBOX/stack-notls.env"
  chmod 600 "$SANDBOX/stack-notls.env"
  expect_fail "preflight refuses a missing certificate" "no TLS certificate pair" \
    env BHOOMITRACE_STACK_ENV="$SANDBOX/stack-notls.env" BHOOMITRACE_SECRETS_ENV="$SANDBOX/secrets.env" \
    BHOOMITRACE_ALLOW_ROOT_FS=true AWS_EC2_METADATA_DISABLED=true "$SCRIPTS_DIR/preflight.sh"

  # Without the root-filesystem override, a data directory on / must be refused.
  # The sandbox is always on the root filesystem, so this is a real check.
  expect_fail "preflight refuses a data directory on the root filesystem" "root filesystem" \
    env BHOOMITRACE_STACK_ENV="$SANDBOX/stack.env" BHOOMITRACE_SECRETS_ENV="$SANDBOX/secrets.env" \
    AWS_EC2_METADATA_DISABLED=true "$SCRIPTS_DIR/preflight.sh"
else
  skip "preflight checks" "no docker daemon"
fi

# ---------------------------------------------------------------------------
printf -- '\n-- restore safety guards --\n'
# ---------------------------------------------------------------------------
expect_fail "restore refuses a production restore without --force-production" \
  "refusing to overwrite production data without --force-production" \
  sandbox_run "$SCRIPTS_DIR/restore.sh" --mode production --dump "$SANDBOX/dumps/fake.dump"

expect_fail "restore refuses a production restore without the sentinel" \
  "RESTORE_PRODUCTION_CONFIRM" \
  sandbox_run "$SCRIPTS_DIR/restore.sh" --mode production --force-production --dump "$SANDBOX/dumps/fake.dump"

expect_fail "restore refuses an incorrect sentinel value" \
  "RESTORE_PRODUCTION_CONFIRM" \
  env RESTORE_PRODUCTION_CONFIRM=yes \
  BHOOMITRACE_STACK_ENV="$SANDBOX/stack.env" BHOOMITRACE_SECRETS_ENV="$SANDBOX/secrets.env" \
  BHOOMITRACE_ALLOW_ROOT_FS=true "$SCRIPTS_DIR/restore.sh" --mode production --force-production --dump "$SANDBOX/dumps/fake.dump"

expect_fail "restore refuses a scratch restore without a target container" \
  "target-container" \
  sandbox_run "$SCRIPTS_DIR/restore.sh" --dump "$SANDBOX/dumps/fake.dump"

expect_fail "restore refuses a scratch restore into a container that is not running" \
  "not running" \
  sandbox_run "$SCRIPTS_DIR/restore.sh" --dump "$SANDBOX/dumps/fake.dump" --target-container bhoomitrace-does-not-exist

expect_fail "restore refuses a non-identifier database name" \
  "plain identifier" \
  sandbox_run "$SCRIPTS_DIR/restore.sh" --dump "$SANDBOX/dumps/fake.dump" \
  --target-container bhoomitrace-does-not-exist --target-db 'bad;DROP'

expect_fail "restore refuses a missing dump file" \
  "dump archive not found" \
  sandbox_run "$SCRIPTS_DIR/restore.sh" --dump "$SANDBOX/dumps/nope.dump" --target-container bhoomitrace-does-not-exist

expect_fail "db-summary refuses a non-identifier database name" \
  "plain identifier" \
  sandbox_run "$SCRIPTS_DIR/db-summary.sh" --container nowhere --db 'bad;DROP'

# ---------------------------------------------------------------------------
printf -- '\n-- rollback --\n'
# ---------------------------------------------------------------------------
expect_ok "rollback --list works with no recorded releases" \
  sandbox_run "$SCRIPTS_DIR/rollback.sh" --list

expect_fail "rollback refuses when there is no previous release" \
  "recorded release file not found" \
  sandbox_run "$SCRIPTS_DIR/rollback.sh" --yes

# With a recorded release present, rollback must not touch anything until it has
# pulled the images. The references below point at a closed local port, so the
# pull fails immediately and offline, while stack.env must stay untouched.
cat >"$SANDBOX/state/previous.env" <<EOF
BACKEND_IMAGE=127.0.0.1:1/bhoomitrace-does-not-exist:sha-3333333333333333333333333333333333333333
FRONTEND_IMAGE=127.0.0.1:1/bhoomitrace-does-not-exist:sha-4444444444444444444444444444444444444444
EOF
STACK_BEFORE="$(shasum -a 256 "$SANDBOX/stack.env" 2>/dev/null | awk '{print $1}' || sha256sum "$SANDBOX/stack.env" | awk '{print $1}')"
if sandbox_run "$SCRIPTS_DIR/rollback.sh" --yes >/dev/null 2>&1; then
  bad "rollback aborts when the target images cannot be pulled" "rollback unexpectedly succeeded"
else
  STACK_AFTER="$(shasum -a 256 "$SANDBOX/stack.env" 2>/dev/null | awk '{print $1}' || sha256sum "$SANDBOX/stack.env" | awk '{print $1}')"
  if [[ "$STACK_BEFORE" == "$STACK_AFTER" ]]; then
    ok "rollback aborts when the target images cannot be pulled, leaving stack.env unchanged"
  else
    bad "rollback aborts when the target images cannot be pulled, leaving stack.env unchanged" "stack.env was modified before the pull succeeded"
  fi
fi

# ---------------------------------------------------------------------------
printf -- '\n-- secrets handling --\n'
# ---------------------------------------------------------------------------
rm -f "$SANDBOX/secrets-produced.env"
expect_fail "fetch-secrets fails cleanly with no AWS access" \
  "aws CLI is not installed|GetParameter failed|GetSecretValue failed|region unknown|required command not found" \
  env BHOOMITRACE_STACK_ENV="$SANDBOX/stack.env" \
  BHOOMITRACE_SECRETS_ENV="$SANDBOX/secrets-produced.env" \
  AWS_EC2_METADATA_DISABLED=true AWS_REGION=ap-south-1 \
  "$SCRIPTS_DIR/fetch-secrets.sh" --parameter /bhoomitrace/does-not-exist --region ap-south-1

if [[ -f "$SANDBOX/secrets-produced.env" ]]; then
  bad "fetch-secrets writes nothing when the fetch fails" "$SANDBOX/secrets-produced.env was created"
else
  ok "fetch-secrets writes nothing when the fetch fails"
fi

# The repository must ignore a real secrets file wherever it lives, and must not
# ignore its own template.
if git -C "$REPO_DIR" check-ignore -q "deploy/env/secrets.env"; then
  ok "deploy/env/secrets.env is git-ignored"
else
  bad "deploy/env/secrets.env is git-ignored" "the ignore rule is missing"
fi
if git -C "$REPO_DIR" check-ignore -q "deploy/env/stack.env"; then
  ok "deploy/env/stack.env is git-ignored"
else
  bad "deploy/env/stack.env is git-ignored" "the ignore rule is missing"
fi
if git -C "$REPO_DIR" check-ignore -q "deploy/env/stack.env.example"; then
  bad "deploy/env/stack.env.example is committed" "the template is being ignored"
else
  ok "deploy/env/stack.env.example is committed"
fi

# ---------------------------------------------------------------------------
printf -- '\n-- privileged scripts refuse unprivileged users --\n'
# ---------------------------------------------------------------------------
if [[ "$(id -u)" == "0" ]]; then
  skip "privileged script guards" "running as root"
else
  expect_fail "prepare-host refuses to run unprivileged" "must run as root" \
    sandbox_run "$SCRIPTS_DIR/prepare-host.sh"
  if command -v systemctl >/dev/null 2>&1; then
    expect_fail "install-systemd-units refuses to run unprivileged" "must run as root" \
      sandbox_run "$SCRIPTS_DIR/install-systemd-units.sh"
  else
    skip "install-systemd-units refuses to run unprivileged" "systemctl not available"
  fi
fi

# ---------------------------------------------------------------------------
printf -- '\n-- health check honesty --\n'
# ---------------------------------------------------------------------------
if [[ "$DOCKER_AVAILABLE" == "true" ]]; then
  # No production stack is running in the sandbox, so the health check must report
  # failure. A health check that passed here would be worse than useless.
  expect_fail "health-check reports FAILURE for a stack that is not running" \
    "HEALTH RESULT: FAILURE" \
    sandbox_run "$SCRIPTS_DIR/health-check.sh" --skip-public
else
  skip "health-check reports FAILURE for a stack that is not running" "no docker daemon"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n== summary ==\n'
printf 'passed:  %s\n' "$PASSED"
printf 'failed:  %s\n' "$FAILED"
printf 'skipped: %s\n' "$SKIPPED"
if [[ "$FAILED" -gt 0 ]]; then
  printf '\nfailed checks:\n'
  printf '  - %s\n' "${FAILED_NAMES[@]}"
  printf '\nDEPLOY TESTS RESULT: FAILURE passed=%s failed=%s skipped=%s\n' "$PASSED" "$FAILED" "$SKIPPED"
  exit 1
fi

printf '\nDEPLOY TESTS RESULT: SUCCESS passed=%s failed=0 skipped=%s\n' "$PASSED" "$SKIPPED"
