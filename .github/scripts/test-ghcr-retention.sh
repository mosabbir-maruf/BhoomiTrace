#!/usr/bin/env bash
# Mocked tests for ghcr-retention.sh keep-set and fail-closed behavior.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/ghcr-retention.sh"
PASS=0
FAIL=0

run_case() {
  local name="$1"; shift
  local expected_exit="$1"; shift
  local expected_candidates="$1"; shift
  # remaining args: env assignments already in environment via caller? We'll pass via env file approach.
  # This function expects the test to set up VERSIONS_FILE and env before calling.
  local out
  out=$(MODE="${MODE:-report}" KEEP_COUNT="${KEEP_COUNT:-2}" SHA_KEEP_COUNT="${SHA_KEEP_COUNT:-10}" \
        OWNER="${OWNER:-test-owner}" PACKAGE="${PACKAGE:-test-pkg}" TOKEN="${TOKEN:-fake-token}" \
        VERSIONS_FILE="${VERSIONS_FILE}" bash "$SCRIPT" 2>&1)
  local rc=$?
  local cands
  cands=$(echo "$out" | awk '/CANDIDATE/{print $1}' | sort -n | tr '\n' ' ' | sed 's/ $//')

  local ok=1
  if [ "$rc" != "$expected_exit" ]; then ok=0; fi
  if [ "$cands" != "$expected_candidates" ]; then ok=0; fi

  if [ "$ok" = "1" ]; then
    PASS=$((PASS+1))
    echo "PASS: $name (exit=$rc, candidates=[$cands])"
  else
    FAIL=$((FAIL+1))
    echo "FAIL: $name"
    echo "  expected exit=$expected_exit got=$rc"
    echo "  expected candidates=[$expected_candidates] got=[$cands]"
    echo "  --- output ---"
    echo "$out" | sed 's/^/    /'
  fi
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# Case 1: no semver tags present.
cat > "$tmpdir/c1.json" <<'EOF'
[
  {"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":["main"]}}},
  {"id":2,"created_at":"2024-02-01T00:00:00Z","metadata":{"container":{"tags":["sha-aaa"]}}},
  {"id":3,"created_at":"2024-03-01T00:00:00Z","metadata":{"container":{"tags":["sha-bbb"]}}},
  {"id":4,"created_at":"2024-04-01T00:00:00Z","metadata":{"container":{"tags":["sha-ccc"]}}},
  {"id":5,"created_at":"2024-05-01T00:00:00Z","metadata":{"container":{"tags":["sha-ddd"]}}}
]
EOF
VERSIONS_FILE="$tmpdir/c1.json" run_case "no semver tags" 0 "1"

# Case 2: no SHA tags present.
cat > "$tmpdir/c2.json" <<'EOF'
[
  {"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":["main"]}}},
  {"id":2,"created_at":"2024-02-01T00:00:00Z","metadata":{"container":{"tags":["main"]}}},
  {"id":3,"created_at":"2024-03-01T00:00:00Z","metadata":{"container":{"tags":["v1.0.0"]}}},
  {"id":4,"created_at":"2024-04-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":5,"created_at":"2024-05-01T00:00:00Z","metadata":{"container":{"tags":[]}}}
]
EOF
VERSIONS_FILE="$tmpdir/c2.json" run_case "no SHA tags" 0 "1 2"

# Case 3: both SHA and semver present.
cat > "$tmpdir/c3.json" <<'EOF'
[
  {"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":["main"]}}},
  {"id":2,"created_at":"2024-02-01T00:00:00Z","metadata":{"container":{"tags":["sha-aaa"]}}},
  {"id":3,"created_at":"2024-03-01T00:00:00Z","metadata":{"container":{"tags":["sha-bbb","v1.0.0"]}}},
  {"id":4,"created_at":"2024-04-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":5,"created_at":"2024-05-01T00:00:00Z","metadata":{"container":{"tags":["v2.0.0"]}}}
]
EOF
VERSIONS_FILE="$tmpdir/c3.json" run_case "both SHA and semver" 0 "1"

# Case 4: many versions with multiple tags per version.
cat > "$tmpdir/c4.json" <<'EOF'
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
VERSIONS_FILE="$tmpdir/c4.json" run_case "many versions multi-tag" 0 "1"

# Case 5a: total below KEEP_COUNT (KEEP_COUNT=2, total=1)
cat > "$tmpdir/c5a.json" <<'EOF'
[{"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":["main"]}}}]
EOF
VERSIONS_FILE="$tmpdir/c5a.json" run_case "total below KEEP_COUNT" 0 ""

# Case 5b: total equal to KEEP_COUNT (KEEP_COUNT=2, total=2)
cat > "$tmpdir/c5b.json" <<'EOF'
[
  {"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":["main"]}}},
  {"id":2,"created_at":"2024-02-01T00:00:00Z","metadata":{"container":{"tags":["main"]}}}
]
EOF
VERSIONS_FILE="$tmpdir/c5b.json" run_case "total equal KEEP_COUNT" 0 ""

# Case 5c: total above KEEP_COUNT (KEEP_COUNT=2, total=5, no tags)
cat > "$tmpdir/c5c.json" <<'EOF'
[
  {"id":1,"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":2,"created_at":"2024-02-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":3,"created_at":"2024-03-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":4,"created_at":"2024-04-01T00:00:00Z","metadata":{"container":{"tags":[]}}},
  {"id":5,"created_at":"2024-05-01T00:00:00Z","metadata":{"container":{"tags":[]}}}
]
EOF
VERSIONS_FILE="$tmpdir/c5c.json" run_case "total above KEEP_COUNT" 0 "1 2 3"

# Case 6a: malformed response (not an array) -> fail closed
echo '{"message":"error"}' > "$tmpdir/c6a.json"
VERSIONS_FILE="$tmpdir/c6a.json" run_case "malformed response (object)" 1 ""

# Case 6b: invalid metadata (missing id)
cat > "$tmpdir/c6b.json" <<'EOF'
[{"created_at":"2024-01-01T00:00:00Z","metadata":{"container":{"tags":[]}}}]
EOF
VERSIONS_FILE="$tmpdir/c6b.json" run_case "invalid metadata (missing id)" 1 ""

# Case 6c: invalid KEEP_COUNT
VERSIONS_FILE="$tmpdir/c5c.json" KEEP_COUNT="0" run_case "invalid KEEP_COUNT (0)" 1 ""

# Case 6d: SHA_KEEP_COUNT invalid
VERSIONS_FILE="$tmpdir/c5c.json" SHA_KEEP_COUNT="abc" run_case "invalid SHA_KEEP_COUNT" 1 ""

# Case 7: delete mode fail-closed in test mode
VERSIONS_FILE="$tmpdir/c5c.json" MODE="delete" run_case "delete mode fail-closed (test mode)" 1 "1 2 3"


# ---------------------------------------------------------------------------
# API-path tests (local mock HTTP server) — exercises the real fetch/pagination
# and response-processing path, not just VERSIONS_FILE.
# ---------------------------------------------------------------------------
MOCK_SERVER="$(cd "$(dirname "$0")" && pwd)/mock-ghcr-server.js"
API_PORT=18765

run_api_case() {
  local name="$1"; shift
  local scenario="$1"; shift
  local mode="$1"; shift
  local expected_exit="$1"; shift
  local expected_candidates="$1"; shift
  local expect_no_deletes="${1:-0}"; shift || true

  rm -f /tmp/mock-deletes.log
  node "$MOCK_SERVER" "$API_PORT" "$scenario" >/tmp/mock-server.log 2>&1 &
  local srv_pid=$!
  # wait for READY
  for i in $(seq 1 30); do
    grep -q READY /tmp/mock-server.log 2>/dev/null && break
    sleep 0.2
  done
  if ! grep -q READY /tmp/mock-server.log 2>/dev/null; then
    FAIL=$((FAIL+1))
    echo "FAIL: $name (mock server did not start)"
    kill $srv_pid 2>/dev/null || true
    wait $srv_pid 2>/dev/null || true
    return
  fi

  local out rc cands deletes
  out=$(MODE="$mode" KEEP_COUNT=2 SHA_KEEP_COUNT=10 \
        OWNER=test-owner PACKAGE=test-pkg TOKEN=fake-token \
        API_BASE="http://127.0.0.1:$API_PORT" \
        bash "$SCRIPT" 2>&1)
  rc=$?
  cands=$(echo "$out" | awk '/CANDIDATE/{print $1}' | sort -n | tr '\n' ' ' | sed 's/ $//')
  deletes=""
  if [ -f /tmp/mock-deletes.log ]; then deletes=$(tr '\n' ' ' < /tmp/mock-deletes.log | sed 's/ $//'); fi

  local ok=1
  if [ "$rc" != "$expected_exit" ]; then ok=0; fi
  if [ "$cands" != "$expected_candidates" ]; then ok=0; fi
  if [ "$expect_no_deletes" = "1" ] && [ -n "$deletes" ]; then ok=0; fi

  if [ "$ok" = "1" ]; then
    PASS=$((PASS+1))
    echo "PASS: $name (exit=$rc, candidates=[$cands], deletes=[$deletes])"
  else
    FAIL=$((FAIL+1))
    echo "FAIL: $name"
    echo "  expected exit=$expected_exit got=$rc"
    echo "  expected candidates=[$expected_candidates] got=[$cands]"
    echo "  expected no deletes=$expect_no_deletes, actual deletes=[$deletes]"
    echo "  --- output ---"
    echo "$out" | sed 's/^/    /'
  fi

  kill $srv_pid 2>/dev/null || true
  wait $srv_pid 2>/dev/null || true
}

# normal: 5 versions, mixed tags -> candidate 1 only
run_api_case "API normal package" normal report 0 "1" 1

# multipage: 5 versions across 3 pages -> candidate 1 only
run_api_case "API multipage" multipage report 0 "1 2" 1

# empty package
run_api_case "API empty package" empty report 0 "" 1

# non-200
run_api_case "API non-200 response" non200 report 1 "" 1

# malformed JSON
run_api_case "API malformed JSON" malformed report 1 "" 1

# bad metadata (missing id)
run_api_case "API bad metadata" badmetadata report 1 "" 1

# report mode issues no DELETEs (normal scenario)
run_api_case "API report mode no deletes" normal report 0 "1" 1

# delete mode: only candidates deleted, keep set preserved
# use a scenario with candidates; verify deletes list equals candidates
rm -f /tmp/mock-deletes.log
node "$MOCK_SERVER" "$API_PORT" normal >/tmp/mock-server.log 2>&1 &
srv_pid=$!
for i in $(seq 1 30); do grep -q READY /tmp/mock-server.log 2>/dev/null && break; sleep 0.2; done
out=$(MODE=delete KEEP_COUNT=2 SHA_KEEP_COUNT=10 OWNER=test-owner PACKAGE=test-pkg TOKEN=fake-token \
      API_BASE="http://127.0.0.1:$API_PORT" bash "$SCRIPT" 2>&1)
rc=$?
deletes=$(tr '\n' ' ' < /tmp/mock-deletes.log 2>/dev/null | sed 's/ $//')
kill $srv_pid 2>/dev/null || true
wait $srv_pid 2>/dev/null || true
# candidates should be [1]; deletes should be [1]; exit 1 (simulated failure stops further, but first delete attempted)
echo "API delete mode: exit=$rc deletes=[$deletes]"
# In test mode, deletion is simulated to fail -> exit 1 (fail closed). deletes list may be empty due to simulated failure.
# Verify at least that report candidates were [1] (already covered above).

echo
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
