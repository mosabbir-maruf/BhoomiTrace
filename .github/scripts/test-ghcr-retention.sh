#!/usr/bin/env bash
# Mocked, fully-asserted tests for ghcr-retention.sh.
#
# Every test asserts an exact exit status and exact keep/candidate/delete
# outcomes. No real GHCR request is ever made: the API path is exercised against
# a local mock server, and delete outcomes are read from the mock's delete log.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/ghcr-retention.sh"
MOCK_SERVER="$(cd "$(dirname "$0")" && pwd)/mock-ghcr-server.js"
API_PORT="${API_PORT:-18765}"

PASS=0
FAIL=0
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

record() {
  local ok="$1" name="$2" detail="$3"
  if [ "$ok" = "1" ]; then
    PASS=$((PASS + 1))
    echo "PASS: $name"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $name"
    printf '%s\n' "$detail" | sed 's/^/    /'
  fi
}

candidates_of() {
  echo "$1" | awk '/CANDIDATE/{print $1}' | sort -n | tr '\n' ' ' | sed 's/ $//'
}

# ---------------------------------------------------------------------------
# File-mode cases (no network). Assert exact exit status and candidate ids.
# ---------------------------------------------------------------------------
run_file_case() {
  local name="$1" expected_exit="$2" expected_cands="$3"
  local out rc cands
  out=$(MODE="${MODE:-report}" KEEP_COUNT="${KEEP_COUNT:-2}" SHA_KEEP_COUNT="${SHA_KEEP_COUNT:-10}" \
    OWNER=test-owner PACKAGE=test-pkg TOKEN=fake-token VERSIONS_FILE="${VERSIONS_FILE}" \
    bash "$SCRIPT" 2>&1)
  rc=$?
  cands=$(candidates_of "$out")
  local ok=1 detail=""
  if [ "$rc" != "$expected_exit" ]; then ok=0; detail="expected exit=$expected_exit got=$rc"; fi
  if [ "$cands" != "$expected_cands" ]; then
    ok=0
    detail="$detail
expected candidates=[$expected_cands] got=[$cands]"
  fi
  record "$ok" "$name" "$detail
--- output ---
$out"
}

cat > "$workdir/c1.json" <<'EOF'
[
  {"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":["main"]}}},
  {"id":2,"created_at":"2024-02-01T00:00:00Z","metadata":{"container":{"tags":["sha-aaa"]}}},
  {"id":3,"created_at":"2024-03-01T00:00:00Z","metadata":{"container":{"tags":["sha-bbb"]}}},
  {"id":4,"created_at":"2024-04-01T00:00:00Z","metadata":{"container":{"tags":["sha-ccc"]}}},
  {"id":5,"created_at":"2024-05-01T00:00:00Z","metadata":{"container":{"tags":["sha-ddd"]}}}
]
EOF
VERSIONS_FILE="$workdir/c1.json" run_file_case "no semver tags" 0 "1"

cat > "$workdir/c2.json" <<'EOF'
[
  {"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":["main"]}}},
  {"id":2,"created_at":"2024-02-01T00:00:00Z","metadata":{"container":{"tags":["main"]}}},
  {"id":3,"created_at":"2024-03-01T00:00:00Z","metadata":{"container":{"tags":["v1.0.0"]}}},
  {"id":4,"created_at":"2024-04-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":5,"created_at":"2024-05-01T00:00:00Z","metadata":{"container":{"tags":[]}}}
]
EOF
VERSIONS_FILE="$workdir/c2.json" run_file_case "no SHA tags" 0 "1 2"

cat > "$workdir/c3.json" <<'EOF'
[
  {"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":["main"]}}},
  {"id":2,"created_at":"2024-02-01T00:00:00Z","metadata":{"container":{"tags":["sha-aaa"]}}},
  {"id":3,"created_at":"2024-03-01T00:00:00Z","metadata":{"container":{"tags":["sha-bbb","v1.0.0"]}}},
  {"id":4,"created_at":"2024-04-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":5,"created_at":"2024-05-01T00:00:00Z","metadata":{"container":{"tags":["v2.0.0"]}}}
]
EOF
VERSIONS_FILE="$workdir/c3.json" run_file_case "both SHA and semver" 0 "1"

cat > "$workdir/c4.json" <<'EOF'
[
  {"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":["main","backend"]}}},
  {"id":2,"created_at":"2024-02-01T00:00:00Z","metadata":{"container":{"tags":["sha-x","sha-y","v0.9.0"]}}},
  {"id":3,"created_at":"2024-03-01T00:00:00Z","metadata":{"container":{"tags":["sha-z"]}}},
  {"id":4,"created_at":"2024-04-01T00:00:00Z","metadata":{"container":{"tags":["sha-w"]}}},
  {"id":5,"created_at":"2024-05-01T00:00:00Z","metadata":{"container":{"tags":["sha-v"]}}},
  {"id":6,"created_at":"2024-06-01T00:00:00Z","metadata":{"container":{"tags":["sha-u"]}}},
  {"id":7,"created_at":"2024-07-01T00:00:00Z","metadata":{"container":{"tags":["sha-t"]}}},
  {"id":8,"created_at":"2024-08-01T00:00:00Z","metadata":{"container":{"tags":["sha-s"]}}},
  {"id":9,"created_at":"2024-09-01T00:00:00Z","metadata":{"container":{"tags":["sha-r"]}}},
  {"id":10,"created_at":"2024-10-01T00:00:00Z","metadata":{"container":{"tags":["sha-q"]}}},
  {"id":11,"created_at":"2024-11-01T00:00:00Z","metadata":{"container":{"tags":["sha-p"]}}},
  {"id":12,"created_at":"2024-12-01T00:00:00Z","metadata":{"container":{"tags":["sha-o"]}}}
]
EOF
VERSIONS_FILE="$workdir/c4.json" run_file_case "many versions multi-tag" 0 "1"

cat > "$workdir/c5a.json" <<'EOF'
[{"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":["main"]}}}]
EOF
VERSIONS_FILE="$workdir/c5a.json" run_file_case "total below KEEP_COUNT" 0 ""

cat > "$workdir/c5b.json" <<'EOF'
[
  {"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":["main"]}}},
  {"id":2,"created_at":"2024-02-01T00:00:00Z","metadata":{"container":{"tags":["main"]}}}
]
EOF
VERSIONS_FILE="$workdir/c5b.json" run_file_case "total equal KEEP_COUNT" 0 ""

cat > "$workdir/c5c.json" <<'EOF'
[
  {"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":2,"created_at":"2024-02-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":3,"created_at":"2024-03-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":4,"created_at":"2024-04-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":5,"created_at":"2024-05-01T00:00:00Z","metadata":{"container":{"tags":[]}}}
]
EOF
VERSIONS_FILE="$workdir/c5c.json" run_file_case "total above KEEP_COUNT" 0 "1 2 3"

# Empty file-mode array is a no-op success.
echo '[]' > "$workdir/c5d.json"
VERSIONS_FILE="$workdir/c5d.json" run_file_case "empty versions array" 0 ""

# --- fail-closed input validation ---
echo '{"message":"error"}' > "$workdir/c6a.json"
VERSIONS_FILE="$workdir/c6a.json" run_file_case "malformed response (object)" 1 ""

cat > "$workdir/c6b.json" <<'EOF'
[{"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":[]}}}]
EOF
VERSIONS_FILE="$workdir/c6b.json" run_file_case "invalid metadata (missing id)" 1 ""

cat > "$workdir/c6f.json" <<'EOF'
[{"id":1,"created_at":"not-a-timestamp","metadata":{"container":{"tags":[]}}}]
EOF
VERSIONS_FILE="$workdir/c6f.json" run_file_case "invalid created_at" 1 ""

cat > "$workdir/c6g.json" <<'EOF'
[{"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":"main"}}}]
EOF
VERSIONS_FILE="$workdir/c6g.json" run_file_case "tags not an array" 1 ""

# --- metadata shape must be strictly valid (missing metadata must fail closed) ---
cat > "$workdir/c6h.json" <<'EOF'
[{"id":1,"created_at":"2024-01-01T00:00:00Z"}]
EOF
VERSIONS_FILE="$workdir/c6h.json" run_file_case "metadata missing" 1 ""

cat > "$workdir/c6i.json" <<'EOF'
[{"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{}}]
EOF
VERSIONS_FILE="$workdir/c6i.json" run_file_case "metadata.container missing" 1 ""

cat > "$workdir/c6j.json" <<'EOF'
[{"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{}}}]
EOF
VERSIONS_FILE="$workdir/c6j.json" run_file_case "metadata.container.tags missing" 1 ""

cat > "$workdir/c6k.json" <<'EOF'
[{"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":null}}}]
EOF
VERSIONS_FILE="$workdir/c6k.json" run_file_case "metadata.container.tags null" 1 ""

cat > "$workdir/c6l.json" <<'EOF'
[{"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":["ok",123]}}}]
EOF
VERSIONS_FILE="$workdir/c6l.json" run_file_case "tag element not a string" 1 ""

cat > "$workdir/c6m.json" <<'EOF'
[
  {"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":2,"created_at":"2024-02-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":3,"created_at":"2024-03-01T00:00:00Z","metadata":{"container":{"tags":[]}}}
]
EOF
VERSIONS_FILE="$workdir/c6m.json" run_file_case "explicitly empty tags array is valid" 0 "1"

# --- created_at must be a complete, real UTC timestamp ---
cat > "$workdir/c6n.json" <<'EOF'
[{"id":1,"created_at":"2024-01-01T00:00:00Zjunk","metadata":{"container":{"tags":[]}}}]
EOF
VERSIONS_FILE="$workdir/c6n.json" run_file_case "timestamp trailing garbage" 1 ""

cat > "$workdir/c6o.json" <<'EOF'
[{"id":1,"created_at":"2024-01-01T00:00:00","metadata":{"container":{"tags":[]}}}]
EOF
VERSIONS_FILE="$workdir/c6o.json" run_file_case "timestamp missing timezone" 1 ""

cat > "$workdir/c6p.json" <<'EOF'
[{"id":1,"created_at":"2023-02-30T00:00:00Z","metadata":{"container":{"tags":[]}}}]
EOF
VERSIONS_FILE="$workdir/c6p.json" run_file_case "timestamp invalid calendar date" 1 ""

cat > "$workdir/c6q.json" <<'EOF'
[{"id":1,"created_at":1700000000,"metadata":{"container":{"tags":[]}}}]
EOF
VERSIONS_FILE="$workdir/c6q.json" run_file_case "timestamp wrong type" 1 ""

cat > "$workdir/c6r.json" <<'EOF'
[{"id":1,"metadata":{"container":{"tags":[]}}}]
EOF
VERSIONS_FILE="$workdir/c6r.json" run_file_case "timestamp missing" 1 ""

cat > "$workdir/c6s.json" <<'EOF'
[
  {"id":1,"created_at":"2024-02-29T12:34:56Z","metadata":{"container":{"tags":["main"]}}},
  {"id":2,"created_at":"2024-03-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":3,"created_at":"2024-04-01T00:00:00Z","metadata":{"container":{"tags":[]}}}
]
EOF
VERSIONS_FILE="$workdir/c6s.json" run_file_case "valid leap-day timestamp is accepted" 0 "1"

VERSIONS_FILE="$workdir/c5c.json" KEEP_COUNT="0" run_file_case "invalid KEEP_COUNT (0)" 1 ""
VERSIONS_FILE="$workdir/c5c.json" SHA_KEEP_COUNT="abc" run_file_case "invalid SHA_KEEP_COUNT" 1 ""
VERSIONS_FILE="$workdir/c5c.json" MODE="purge" run_file_case "invalid MODE" 1 ""

# ---------------------------------------------------------------------------
# API-path cases (local mock HTTP server). Assert exit, candidates, and deletes.
# ---------------------------------------------------------------------------
run_api_case() {
  local name="$1" scenario="$2" mode="$3" expected_exit="$4" expected_cands="$5" expected_deletes="$6" expected_kept="$7"
  local logdir="$workdir/log-${scenario}-${mode}-${RANDOM}"
  mkdir -p "$logdir"

  MOCK_LOG_DIR="$logdir" \
    MOCK_FAIL_DELETE="${MOCK_FAIL_DELETE_IN:-0}" \
    MOCK_LIST_FAIL_AFTER="${MOCK_LIST_FAIL_AFTER_IN:--1}" \
    MOCK_LIST_FAIL_MODE="${MOCK_LIST_FAIL_MODE_IN:-non200}" \
    node "$MOCK_SERVER" "$API_PORT" "$scenario" >"$logdir/server.log" 2>&1 &
  local srv_pid=$!
  local up=0
  for _ in $(seq 1 50); do
    if grep -q READY "$logdir/server.log" 2>/dev/null; then up=1; break; fi
    sleep 0.1
  done
  if [ "$up" != "1" ]; then
    record 0 "$name" "mock server did not start
--- server log ---
$(cat "$logdir/server.log" 2>/dev/null)"
    kill "$srv_pid" 2>/dev/null || true
    wait "$srv_pid" 2>/dev/null || true
    return
  fi

  local out rc cands deletes
  out=$(MODE="$mode" KEEP_COUNT=2 SHA_KEEP_COUNT=10 \
    OWNER=test-owner PACKAGE=test-pkg TOKEN=fake-token \
    API_BASE="http://127.0.0.1:$API_PORT" bash "$SCRIPT" 2>&1)
  rc=$?
  kill "$srv_pid" 2>/dev/null || true
  wait "$srv_pid" 2>/dev/null || true

  cands=$(candidates_of "$out")
  # Deletions are attempted newest-first; compare as a sorted numeric set.
  deletes=$(grep -E '^[0-9]+$' "$logdir/deletes.log" 2>/dev/null | sort -n | tr '\n' ' ' | sed 's/ $//')

  local ok=1 detail=""
  if [ "$rc" != "$expected_exit" ]; then ok=0; detail="$detail
expected exit=$expected_exit got=$rc"; fi
  if [ "$cands" != "$expected_cands" ]; then ok=0; detail="$detail
expected candidates=[$expected_cands] got=[$cands]"; fi
  if [ "$deletes" != "$expected_deletes" ]; then ok=0; detail="$detail
expected deletes=[$expected_deletes] got=[$deletes]"; fi
  if [ -n "$expected_kept" ] && [ -n "$deletes" ]; then
    for k in $expected_kept; do
      case " $deletes " in
        *" $k "*) ok=0; detail="$detail
kept id $k was deleted";;
      esac
    done
  fi
  if [ "$mode" = "delete" ] && [ "$expected_exit" = "0" ]; then
    case "$out" in
      *"Retention complete."*) : ;;
      *) ok=0; detail="$detail
missing 'Retention complete.' after successful delete";;
    esac
  fi
  if [ "$mode" = "report" ] && [ "$expected_exit" = "0" ]; then
    case "$out" in
      *"No versions found"*) : ;;
      *"no deletions performed"*) : ;;
      *) ok=0; detail="$detail
report mode did not report 'no deletions performed'";;
    esac
  fi

  record "$ok" "$name" "$detail
--- output ---
$out"
}

# report mode: correct candidates and zero deletes
run_api_case "API normal (report)" normal report 0 "1" "" "1 2 3 4 5"
run_api_case "API multipage (report)" multipage report 0 "1 2" "" "1 2 3 4 5"
run_api_case "API empty package (report)" empty report 0 "" "" ""
run_api_case "API candidates4 (report)" candidates4 report 0 "1 2 3 4" "" "5 6"

# report mode must never DELETE (explicit assertion)
run_api_case "API report sends zero DELETEs" normal report 0 "1" "" "2 3 4 5"

# fail-closed API input errors
run_api_case "API non-200 response" non200 report 1 "" "" ""
run_api_case "API malformed JSON" malformed report 1 "" "" ""
run_api_case "API bad metadata (missing id)" badmetadata report 1 "" "" ""

# delete mode: exact delete set, keep set preserved, deletes reflected afterwards
run_api_case "API delete (normal)" normal delete 0 "1" "1" "2 3 4 5"
run_api_case "API delete (candidates4)" candidates4 delete 0 "1 2 3 4" "1 2 3 4" "5 6"

# delete failure aborts remaining deletions and exits non-zero
MOCK_FAIL_DELETE_IN=1 run_api_case "API delete failure aborts" candidates4 delete 1 "1 2 3 4" "4" "5 6"

# final-count verification must fail closed (initial fetch succeeds, final count fails)
MOCK_LIST_FAIL_AFTER_IN=2 MOCK_LIST_FAIL_MODE_IN=non200 run_api_case "API final-count non-200" normal delete 1 "1" "1" "2 3 4 5"
MOCK_LIST_FAIL_AFTER_IN=2 MOCK_LIST_FAIL_MODE_IN=malformed run_api_case "API final-count malformed" normal delete 1 "1" "1" "2 3 4 5"
MOCK_LIST_FAIL_AFTER_IN=2 MOCK_LIST_FAIL_MODE_IN=object run_api_case "API final-count invalid (object)" normal delete 1 "1" "1" "2 3 4 5"

# Invalid metadata/timestamp must fail closed before any DELETE (delete mode).
# Each scenario's oldest version (id 1) is the sole keep-2 candidate, so zero
# deletes proves the guard aborted before touching the registry.
run_api_case "API delete: metadata missing" missingmeta delete 1 "" "" ""
run_api_case "API delete: metadata.container missing" missingcontainer delete 1 "" "" ""
run_api_case "API delete: metadata.container.tags missing" missingtags delete 1 "" "" ""
run_api_case "API delete: metadata.container.tags null" nulltags delete 1 "" "" ""
run_api_case "API delete: tags wrong type" badtagstype delete 1 "" "" ""
run_api_case "API delete: timestamp missing" tsmissing delete 1 "" "" ""
run_api_case "API delete: timestamp trailing garbage" tstrailing delete 1 "" "" ""
run_api_case "API delete: timestamp missing timezone" tsnotz delete 1 "" "" ""
run_api_case "API delete: timestamp invalid calendar date" tsinvalid delete 1 "" "" ""
run_api_case "API delete: timestamp wrong type" tswrongtype delete 1 "" "" ""

# ---------------------------------------------------------------------------
# File-mode delete guard: must refuse and make no HTTP request at all.
# ---------------------------------------------------------------------------
run_file_delete_guard_case() {
  local name="file delete-mode guard rejects and makes no HTTP request"
  local logdir="$workdir/log-guard-${RANDOM}"
  mkdir -p "$logdir"
  MOCK_LOG_DIR="$logdir" node "$MOCK_SERVER" "$API_PORT" candidates4 >"$logdir/server.log" 2>&1 &
  local srv_pid=$!
  for _ in $(seq 1 50); do grep -q READY "$logdir/server.log" 2>/dev/null && break; sleep 0.1; done

  local out rc
  out=$(MODE=delete KEEP_COUNT=2 SHA_KEEP_COUNT=10 \
    OWNER=test-owner PACKAGE=test-pkg TOKEN=fake-token \
    API_BASE="http://127.0.0.1:$API_PORT" VERSIONS_FILE="$workdir/c5c.json" \
    bash "$SCRIPT" 2>&1)
  rc=$?
  kill "$srv_pid" 2>/dev/null || true
  wait "$srv_pid" 2>/dev/null || true

  local reqs=0 dels=0
  [ -f "$logdir/requests.log" ] && reqs=$(wc -l < "$logdir/requests.log" | tr -d ' ')
  [ -f "$logdir/deletes.log" ] && dels=$(wc -l < "$logdir/deletes.log" | tr -d ' ')

  local ok=1 detail=""
  if [ "$rc" != "1" ]; then ok=0; detail="$detail
expected exit=1 got=$rc"; fi
  case "$out" in
    *"refusing to delete"*) : ;;
    *) ok=0; detail="$detail
missing explicit refusal message";;
  esac
  if [ "$reqs" != "0" ]; then ok=0; detail="$detail
expected 0 HTTP requests got $reqs"; fi
  if [ "$dels" != "0" ]; then ok=0; detail="$detail
expected 0 DELETEs got $dels"; fi
  record "$ok" "$name" "$detail
--- output ---
$out"
}
run_file_delete_guard_case

# ---------------------------------------------------------------------------
# Connection failure (no server listening) must fail closed.
# ---------------------------------------------------------------------------
run_connection_failure_case() {
  local name="API connection failure fails closed"
  local out rc
  out=$(MODE=delete KEEP_COUNT=2 SHA_KEEP_COUNT=10 \
    OWNER=test-owner PACKAGE=test-pkg TOKEN=fake-token \
    API_BASE="http://127.0.0.1:1" bash "$SCRIPT" 2>&1)
  rc=$?
  local ok=1 detail=""
  if [ "$rc" != "1" ]; then ok=0; detail="expected exit=1 got=$rc"; fi
  record "$ok" "$name" "$detail
--- output ---
$out"
}
run_connection_failure_case

echo
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
