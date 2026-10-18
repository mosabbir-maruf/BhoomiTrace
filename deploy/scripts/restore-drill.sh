#!/usr/bin/env bash
# Restore drill: proves the backup and restore path actually works, using only
# disposable resources.
#
#   sudo deploy/scripts/restore-drill.sh                  # dump the running stack
#   deploy/scripts/restore-drill.sh --source-dump x.dump  # use an existing dump
#
# What it does, in order:
#   1. Starts a throwaway PostgreSQL container on its own throwaway network.
#   2. Takes a real database backup of the source with backup-db.sh, so the
#      backup code path is exercised rather than simulated.
#   3. Restores that dump into the throwaway container with restore.sh.
#   4. Compares a full table-by-table row summary of source and restored copy.
#   5. Archives the evidence directory and restores it, comparing file hashes.
#   6. Runs the real API image against the restored database and checks
#      readiness, liveness, and an unauthenticated 401.
#   7. Removes every resource it created.
#
# It never touches the source database, never drops anything outside the
# throwaway container, and never writes to the live evidence directory.
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="restore-drill"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SOURCE_DUMP=""
KEEP=false
SKIP_UPLOADS=false
BACKEND_IMAGE_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-dump)
      [[ $# -ge 2 ]] || die "--source-dump needs a value"
      SOURCE_DUMP="$2"
      shift 2
      ;;
    --backend-image)
      [[ $# -ge 2 ]] || die "--backend-image needs a value"
      BACKEND_IMAGE_OVERRIDE="$2"
      shift 2
      ;;
    --keep) KEEP=true; shift ;;
    --skip-uploads) SKIP_UPLOADS=true; shift ;;
    -h | --help)
      echo "Usage: restore-drill.sh [--source-dump FILE] [--backend-image IMAGE] [--skip-uploads] [--keep]" >&2
      exit 0
      ;;
    *) die "unexpected argument: $1" ;;
  esac
done

require_cmd docker tar find
load_config

PG_IMAGE="${POSTGRES_IMAGE:-postgres:17-alpine}"
BACKEND_IMAGE="${BACKEND_IMAGE_OVERRIDE:-${BACKEND_IMAGE:-}}"
[[ -n "$BACKEND_IMAGE" ]] || die "no backend image available (set BACKEND_IMAGE in stack.env or pass --backend-image)"

DRILL_ID="$(date -u +%Y%m%dT%H%M%S)-$$"
DRILL_NETWORK="bhoomitrace-drill-$DRILL_ID"
DRILL_PG="bhoomitrace-drill-pg-$DRILL_ID"
DRILL_API="bhoomitrace-drill-api-$DRILL_ID"
DRILL_DB="bhoomitrace_restore_scratch"
DRILL_DIR="${BHOOMITRACE_DRILL_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/bhoomitrace-drill-$DRILL_ID.XXXXXX")}"
DRILL_UPLOADS_DIR="$DRILL_DIR/restored-uploads"

STEP_FAILURES=0
declare -a STEP_RESULTS=()

record_step() {
  local status="$1" name="$2" detail="${3:-}"
  STEP_RESULTS+=("$status|$name|$detail")
  if [[ "$status" == "FAIL" ]]; then
    STEP_FAILURES=$((STEP_FAILURES + 1))
    error "STEP FAIL: $name — $detail"
  else
    info "STEP $status: $name${detail:+ — $detail}"
  fi
}

cleanup() {
  local exit_code=$?
  if [[ "$KEEP" == "true" ]]; then
    warn "--keep: leaving drill resources in place ($DRILL_PG, $DRILL_API, network $DRILL_NETWORK, dir $DRILL_DIR)"
    return
  fi
  info "cleaning up disposable drill resources"
  docker rm -f "$DRILL_PG" >/dev/null 2>&1 || true
  docker rm -f "$DRILL_API" >/dev/null 2>&1 || true
  # -v removes the anonymous data volume attached by the postgres image
  docker volume ls -q --filter "name=$DRILL_PG" 2>/dev/null | while read -r v; do
    [[ -n "$v" ]] && docker volume rm "$v" >/dev/null 2>&1 || true
  done
  docker network rm "$DRILL_NETWORK" >/dev/null 2>&1 || true
  rm -rf "$DRILL_DIR"
  return $exit_code
}
trap cleanup EXIT

banner "RESTORE DRILL — disposable resources only. Source data is read, never written."

# ---------------------------------------------------------------------------
# Step 0: disposable infrastructure
# ---------------------------------------------------------------------------
info "drill id: $DRILL_ID"
info "workspace: $DRILL_DIR"

if ! docker network create "$DRILL_NETWORK" >/dev/null; then
  die "could not create the drill network"
fi

if ! docker run -d --name "$DRILL_PG" \
  --network "$DRILL_NETWORK" \
  -e POSTGRES_PASSWORD=drill-only-password \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=postgres \
  -e PGDATA=/var/lib/postgresql/data/pgdata \
  "$PG_IMAGE" >/dev/null; then
  die "could not start the throwaway postgres container"
fi

info "waiting for the throwaway postgres to accept connections"
READY=false
for _ in $(seq 1 60); do
  if docker exec "$DRILL_PG" pg_isready -U postgres >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 1
done
if [[ "$READY" != "true" ]]; then
  docker logs --tail 40 "$DRILL_PG" >&2 || true
  die "throwaway postgres never became ready"
fi
record_step "PASS" "throwaway postgres started" "$DRILL_PG"

# ---------------------------------------------------------------------------
# Step 1: take a real backup
# ---------------------------------------------------------------------------
DUMP_DIR="$DRILL_DIR/dumps"
UPLOADS_DIR_LOCAL="$DRILL_DIR/upl"
mkdir -p "$DUMP_DIR" "$UPLOADS_DIR_LOCAL"

if [[ -n "$SOURCE_DUMP" ]]; then
  require_file "$SOURCE_DUMP" "source dump"
  DUMP_FILE="$SOURCE_DUMP"
  record_step "PASS" "source dump supplied" "$DUMP_FILE"
else
  info "taking a database backup of the running stack (read-only against the source)"
  if "$SCRIPTS_DIR/backup-db.sh" --label drill --no-upload --output-dir "$DUMP_DIR" >"$DRILL_DIR/backup-db.log" 2>&1; then
    DUMP_FILE="$(find "$DUMP_DIR" -name '*.dump' -type f | head -1)"
    [[ -n "$DUMP_FILE" ]] || die "backup-db.sh reported success but produced no dump"
    record_step "PASS" "database backup taken" "$(basename "$DUMP_FILE")"
  else
    tail -30 "$DRILL_DIR/backup-db.log" >&2 || true
    record_step "FAIL" "database backup taken" "backup-db.sh exited non-zero"
    die "cannot continue the drill without a backup"
  fi
fi

# ---------------------------------------------------------------------------
# Step 2: restore into the throwaway container
# ---------------------------------------------------------------------------
UPLOADS_TAR=""
if [[ "$SKIP_UPLOADS" != "true" ]]; then
  if [[ "$(id -u)" == "0" || "${BHOOMITRACE_ALLOW_NONROOT:-false}" == "true" ]]; then
    info "archiving the evidence directory"
    if "$SCRIPTS_DIR/backup-uploads.sh" --label drill --no-upload --output-dir "$UPLOADS_DIR_LOCAL" --allow-nonroot >"$DRILL_DIR/backup-uploads.log" 2>&1; then
      UPLOADS_TAR="$(find "$UPLOADS_DIR_LOCAL" -name '*.tar.gz' -type f | head -1)"
      record_step "PASS" "evidence archive created" "$(basename "${UPLOADS_TAR:-none}")"
    else
      tail -30 "$DRILL_DIR/backup-uploads.log" >&2 || true
      record_step "FAIL" "evidence archive created" "backup-uploads.sh exited non-zero"
    fi
  else
    record_step "SKIP" "evidence archive created" "not root and BHOOMITRACE_ALLOW_NONROOT is not true"
  fi
fi

info "restoring into the throwaway database '$DRILL_DB'"
RESTORE_ARGS=(--mode scratch --dump "$DUMP_FILE" --target-container "$DRILL_PG" --target-db "$DRILL_DB" --target-uploads-dir "$DRILL_UPLOADS_DIR" --scratch-clean --no-validate)
if [[ -n "$UPLOADS_TAR" ]]; then
  RESTORE_ARGS+=(--uploads-tar "$UPLOADS_TAR")
fi

if "$SCRIPTS_DIR/restore.sh" "${RESTORE_ARGS[@]}" >"$DRILL_DIR/restore.log" 2>&1; then
  record_step "PASS" "restore into disposable database" "$DRILL_DB"
else
  tail -40 "$DRILL_DIR/restore.log" >&2 || true
  record_step "FAIL" "restore into disposable database" "restore.sh exited non-zero"
  die "restore failed; the drill cannot continue"
fi

# ---------------------------------------------------------------------------
# Step 3: validate the restored database against the source
# ---------------------------------------------------------------------------
info "comparing source and restored databases table by table"
SOURCE_SUMMARY="$DRILL_DIR/source-summary.txt"
RESTORED_SUMMARY="$DRILL_DIR/restored-summary.txt"

if "$SCRIPTS_DIR/db-summary.sh" --compose --db "$POSTGRES_DB" >"$SOURCE_SUMMARY" 2>"$DRILL_DIR/source-summary.err"; then
  record_step "PASS" "source database summarised" "$(grep -c '^table|' "$SOURCE_SUMMARY" || true) tables"
else
  record_step "FAIL" "source database summarised" "$(head -2 "$DRILL_DIR/source-summary.err" | tr '\n' ' ')"
fi

if "$SCRIPTS_DIR/db-summary.sh" --container "$DRILL_PG" --db "$DRILL_DB" >"$RESTORED_SUMMARY" 2>"$DRILL_DIR/restored-summary.err"; then
  record_step "PASS" "restored database summarised" "$(grep -c '^table|' "$RESTORED_SUMMARY" || true) tables"
else
  record_step "FAIL" "restored database summarised" "$(head -2 "$DRILL_DIR/restored-summary.err" | tr '\n' ' ')"
fi

if [[ -s "$SOURCE_SUMMARY" && -s "$RESTORED_SUMMARY" ]]; then
  if diff -u "$SOURCE_SUMMARY" "$RESTORED_SUMMARY" >"$DRILL_DIR/db-diff.txt" 2>&1; then
    SOURCE_MIGRATIONS="$(grep '^migrations|' "$SOURCE_SUMMARY" | cut -d'|' -f2)"
    SOURCE_TABLES="$(grep '^tables|' "$SOURCE_SUMMARY" | cut -d'|' -f2)"
    record_step "PASS" "restored database matches source" "migrations=$SOURCE_MIGRATIONS tables=$SOURCE_TABLES"
  else
    head -40 "$DRILL_DIR/db-diff.txt" >&2 || true
    record_step "FAIL" "restored database matches source" "row counts or table list differ (see $DRILL_DIR/db-diff.txt)"
  fi
else
  record_step "FAIL" "restored database matches source" "one of the summaries is empty"
fi

# ---------------------------------------------------------------------------
# Step 4: validate the restored evidence
# ---------------------------------------------------------------------------
if [[ -n "$UPLOADS_TAR" ]]; then
  info "comparing source and restored evidence file hashes"
  checksums() {
    local dir="$1"
    ( cd "$dir" && find . -type f | LC_ALL=C sort | while IFS= read -r f; do
      if command -v sha256sum >/dev/null 2>&1; then
        printf '%s  %s\n' "$(sha256sum "$f" | awk '{print $1}')" "$f"
      else
        printf '%s  %s\n' "$(shasum -a 256 "$f" | awk '{print $1}')" "$f"
      fi
    done )
  }

  checksums "$BHOOMITRACE_DATA_DIR/uploads" >"$DRILL_DIR/uploads-source.txt"
  checksums "$DRILL_UPLOADS_DIR" >"$DRILL_DIR/uploads-restored.txt"

  SRC_COUNT="$(wc -l <"$DRILL_DIR/uploads-source.txt" | tr -d ' ')"
  DST_COUNT="$(wc -l <"$DRILL_DIR/uploads-restored.txt" | tr -d ' ')"
  if [[ "$SRC_COUNT" == "$DST_COUNT" ]] && diff -q "$DRILL_DIR/uploads-source.txt" "$DRILL_DIR/uploads-restored.txt" >/dev/null 2>&1; then
    record_step "PASS" "restored evidence matches source" "$SRC_COUNT file(s), hashes identical"
  else
    diff -u "$DRILL_DIR/uploads-source.txt" "$DRILL_DIR/uploads-restored.txt" | head -30 >&2 || true
    record_step "FAIL" "restored evidence matches source" "source=$SRC_COUNT restored=$DST_COUNT files differ"
  fi
elif [[ "$SKIP_UPLOADS" == "true" ]]; then
  record_step "SKIP" "restored evidence matches source" "--skip-uploads"
else
  record_step "SKIP" "restored evidence matches source" "evidence archive was not produced"
fi

# ---------------------------------------------------------------------------
# Step 5: run the real API against the restored database
# ---------------------------------------------------------------------------
info "starting the API image against the restored database"
RESTORED_URL="postgres://postgres:drill-only-password@$DRILL_PG:5432/$DRILL_DB"

if docker run -d --name "$DRILL_API" \
  --network "$DRILL_NETWORK" \
  -e NODE_ENV=production \
  -e COOKIE_SECURE=true \
  -e TRUST_PROXY=false \
  -e LOG_LEVEL=info \
  -e DATABASE_URL="$RESTORED_URL" \
  -e CORS_ALLOWED_ORIGINS=https://drill.invalid \
  -e UPLOAD_DIR=/data/uploads \
  -e EXTRACTION_PROVIDER=mock \
  "$BACKEND_IMAGE" >/dev/null; then

  API_READY=false
  for _ in $(seq 1 45); do
    if docker exec "$DRILL_API" node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      API_READY=true
      break
    fi
    sleep 1
  done

  if [[ "$API_READY" == "true" ]]; then
    HEALTH_BODY="$(docker exec "$DRILL_API" node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(t=>process.stdout.write(t))" 2>/dev/null || true)"
    record_step "PASS" "API readiness against restored database" "$(printf '%s' "$HEALTH_BODY" | tr -d '\n' | cut -c1-120)"
  else
    docker logs --tail 30 "$DRILL_API" >&2 || true
    record_step "FAIL" "API readiness against restored database" "no 200 from /health"
  fi

  LIVE_OK=false
  if docker exec "$DRILL_API" node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    LIVE_OK=true
  fi
  [[ "$LIVE_OK" == "true" ]] && record_step "PASS" "API liveness against restored database" "/health/live 200" || record_step "FAIL" "API liveness against restored database" "/health/live did not return 200"

  ANON_CODE="$(docker exec "$DRILL_API" node -e "fetch('http://127.0.0.1:3000/api/v1/auth/me').then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('error'))" 2>/dev/null || echo error)"
  if [[ "$ANON_CODE" == "401" ]]; then
    record_step "PASS" "API authorisation intact" "unauthenticated /api/v1/auth/me -> 401"
  else
    record_step "FAIL" "API authorisation intact" "expected 401, got $ANON_CODE"
  fi
else
  record_step "FAIL" "API readiness against restored database" "could not start the API container"
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
{
  printf 'RESTORE DRILL %s\n' "$DRILL_ID"
  printf 'source: %s\n' "$([[ -n "$SOURCE_DUMP" ]] && echo "$SOURCE_DUMP" || echo "live compose stack database $POSTGRES_DB")"
  printf 'dump: %s\n' "$DUMP_FILE"
  printf '\n'
  for row in "${STEP_RESULTS[@]}"; do
    IFS='|' read -r status name detail <<<"$row"
    printf '%-5s %-45s %s\n' "$status" "$name" "$detail"
  done
} | tee "$DRILL_DIR/drill-report.txt" >&2

if [[ "$STEP_FAILURES" -gt 0 ]]; then
  error "RESTORE DRILL RESULT: FAILURE steps_failed=$STEP_FAILURES"
  [[ "$KEEP" == "true" ]] || info "workspace removed; re-run with --keep to inspect (a failing run keeps nothing unless asked)"
  exit 1
fi

info "RESTORE DRILL RESULT: SUCCESS all_steps_passed=true drill=$DRILL_ID"

if [[ "$KEEP" == "true" ]]; then
  warn "drill artifacts kept at $DRILL_DIR for inspection"
fi
