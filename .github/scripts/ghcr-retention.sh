#!/usr/bin/env bash
# GHCR retention helper.
#
# Policy (explicit, bounded):
#   - Always preserve every version carrying a valid semver release tag.
#   - Preserve the newest 10 (SHA_KEEP_COUNT) SHA-build versions.
#   - Preserve the newest 2 (KEEP_COUNT) versions overall.
#   - Delete only versions outside those keep sets.
#   - Never delete a version carrying a semver release tag.
#   - A version may carry multiple tags and is evaluated as one package version.
#
# MODE=report  (default): list versions and mark keep/delete candidates. Never deletes.
# MODE=delete:            delete candidates with safety guards.
#
# Safety guards (fail closed):
#   - KEEP_COUNT and SHA_KEEP_COUNT must be positive integers.
#   - API errors, malformed responses, or uncertain keep-set computation abort
#     with zero deletions.
#   - never deletes when total versions <= KEEP_COUNT
#   - never deletes a version in the keep set
#   - aborts if a deletion would leave fewer than KEEP_COUNT versions
#   - logs every action and verifies the final count
set -euo pipefail

MODE="${MODE:-report}"
KEEP_COUNT="${KEEP_COUNT:-2}"
OWNER="${OWNER:?OWNER required}"
PACKAGE="${PACKAGE:?PACKAGE required}"
TOKEN="${TOKEN:?TOKEN required}"
API_BASE="${API_BASE:-https://api.github.com}"

# Defaults and validation for retention counts.
SHA_KEEP_COUNT="${SHA_KEEP_COUNT:-10}"

for v in "$KEEP_COUNT" "$SHA_KEEP_COUNT"; do
  if ! [[ "$v" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: KEEP_COUNT and SHA_KEEP_COUNT must be positive integers (got '$v')" >&2
    exit 1
  fi
done

owner_lc=$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# Testing path: read versions from a file (JSON array or JSONL) instead of the API.
if [ -n "${VERSIONS_FILE:-}" ]; then
  if [ ! -f "$VERSIONS_FILE" ]; then
    echo "ERROR: VERSIONS_FILE not found: $VERSIONS_FILE" >&2
    exit 1
  fi
  if jq -e 'type=="array"' "$VERSIONS_FILE" >/dev/null 2>&1; then
    cp "$VERSIONS_FILE" "$tmpdir/versions.json"
  else
    jq -s '.' "$VERSIONS_FILE" > "$tmpdir/versions.json" 2>/dev/null || {
      echo "ERROR: VERSIONS_FILE is not valid JSON or JSONL" >&2
      exit 1
    }
  fi
  _from_file=1
else
  _from_file=0
fi

if [ "$_from_file" = "0" ]; then
  # Pick user vs. organization endpoint.
  org_code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    "$API_BASE/orgs/$owner_lc" 2>/dev/null || echo "000")
  if [ "$org_code" = "200" ]; then
    base="$API_BASE/orgs/$owner_lc/packages/container/$PACKAGE/versions"
  else
    base="$API_BASE/users/$owner_lc/packages/container/$PACKAGE/versions"
  fi

  page=1
  : > "$tmpdir/versions.jsonl"
  while :; do
    http=$(curl -sS -o "$tmpdir/page.json" -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
      "${base}?per_page=100&page=${page}")
    if [ "$http" != "200" ]; then
      echo "ERROR: GitHub API returned HTTP $http for $base (page $page)" >&2
      cat "$tmpdir/page.json" >&2
      exit 1
    fi
    if ! jq -e 'type=="array"' "$tmpdir/page.json" >/dev/null 2>&1; then
      echo "ERROR: unexpected API response (not a JSON array)" >&2
      cat "$tmpdir/page.json" >&2
      exit 1
    fi
    n=$(jq 'length' "$tmpdir/page.json")
    if [ "$n" = "0" ]; then break; fi
    jq -c '.[]' "$tmpdir/page.json" >> "$tmpdir/versions.jsonl"
    page=$((page + 1))
  done

  if [ ! -s "$tmpdir/versions.jsonl" ]; then
    echo "No versions found for ghcr.io/$owner_lc/$PACKAGE (package may not exist yet)."
    exit 0
  fi

  # Combine paginated JSONL records into a single JSON array before any keep-set calc.
  jq -s '.' "$tmpdir/versions.jsonl" > "$tmpdir/versions.json"
fi

# No versions found (file mode with empty array).
if [ "$(jq 'length' "$tmpdir/versions.json")" = "0" ]; then
  echo "No versions found for ghcr.io/$owner_lc/$PACKAGE (package may not exist yet)."
  exit 0
fi

total=$(jq 'length' "$tmpdir/versions.json")
echo "Package: ghcr.io/$owner_lc/$PACKAGE"
echo "Total versions: $total"
echo "Mode: $MODE  |  KEEP_COUNT: $KEEP_COUNT  |  SHA_KEEP_COUNT: $SHA_KEEP_COUNT"
echo


# Sort by created_at descending (newest first) for keep-set selection.
jq 'sort_by(.created_at) | reverse' "$tmpdir/versions.json" > "$tmpdir/sorted.json"

# Determine keep set (robust, array-based):
#   1. newest KEEP_COUNT versions overall
#   2. newest SHA_KEEP_COUNT versions carrying a sha-* tag
#   3. all versions carrying a valid semver tag (x.y or x.y.z, optional leading v)
jq --argjson k "$KEEP_COUNT" '[.[0:$k] | .[].id]' "$tmpdir/sorted.json" > "$tmpdir/keep_newest.json"

jq --argjson k "$SHA_KEEP_COUNT" '
  [ .[] | select((.metadata.container.tags // []) | any(startswith("sha-"))) ] | .[0:$k] | map(.id)
' "$tmpdir/sorted.json" > "$tmpdir/keep_sha.json"

jq '
  [ .[] | select((.metadata.container.tags // []) | any(test("^v?[0-9]+\\.[0-9]+(\\.[0-9]+)?$"))) ] | map(.id)
' "$tmpdir/sorted.json" > "$tmpdir/keep_semver.json"

jq -s 'add | unique' "$tmpdir/keep_newest.json" "$tmpdir/keep_sha.json" "$tmpdir/keep_semver.json" > "$tmpdir/keep_ids.json"

# Fail closed: keep set must be a non-empty array of numbers.
if ! jq -e 'type=="array" and length>0 and all(.[]; type=="number")' "$tmpdir/keep_ids.json" >/dev/null 2>&1; then
  echo "ERROR: keep-set computation produced an invalid/empty result; aborting (fail closed)" >&2
  exit 1
fi

jq -r '.[]' "$tmpdir/keep_ids.json" > "$tmpdir/keep_ids.txt"

echo "Keep set (ids):"
cat "$tmpdir/keep_ids.txt" | sed 's/^/  /'
echo

# Safety: never go below KEEP_COUNT versions total.
if [ "$total" -le "$KEEP_COUNT" ]; then
  echo "Total ($total) <= keep count ($KEEP_COUNT): nothing to delete."
  exit 0
fi

# Candidates = versions not in keep set.
jq -r '.[].id' "$tmpdir/sorted.json" | while read -r id; do
  if ! grep -qx "$id" "$tmpdir/keep_ids.txt"; then
    echo "$id"
  fi
done > "$tmpdir/candidates.txt"

cand_count=$(wc -l < "$tmpdir/candidates.txt" | tr -d ' ')
echo "Delete candidates: $cand_count"
echo

# Print a table.
printf '%-12s %-40s %-22s %s\n' "ID" "TAGS" "CREATED" "DECISION"
echo "--------------------------------------------------------------------------------"
while IFS= read -r id; do
  [ -z "$id" ] && continue
  tags=$(jq -r --argjson id "$id" '.[] | select(.id==$id) | (.metadata.container.tags // []) | join(",")' "$tmpdir/sorted.json")
  created=$(jq -r --argjson id "$id" '.[] | select(.id==$id) | .created_at' "$tmpdir/sorted.json")
  if grep -qx "$id" "$tmpdir/keep_ids.txt"; then
    printf '%-12s %-40s %-22s %s\n' "$id" "${tags:-<none>}" "$created" "KEEP"
  else
    printf '%-12s %-40s %-22s %s\n' "$id" "${tags:-<none>}" "$created" "CANDIDATE"
  fi
done < <(jq -r '.[].id' "$tmpdir/sorted.json")

echo

if [ "$MODE" != "delete" ]; then
  echo "MODE=report: no deletions performed."
  exit 0
fi

# --- deletion ---
echo "MODE=delete: deleting candidates..."
deleted=0
while IFS= read -r id; do
  [ -z "$id" ] && continue
  if grep -qx "$id" "$tmpdir/keep_ids.txt"; then
    echo "  skip (keep set): $id"
    continue
  fi
  # safety: would deletion leave fewer than KEEP_COUNT?
  remaining=$(( total - deleted ))
  if [ "$remaining" -le "$KEEP_COUNT" ]; then
    echo "  abort: deleting $id would leave $((remaining-1)) < $KEEP_COUNT versions"
    break
  fi
  echo "  deleting version $id ..."
  http=$(curl -sS -o /tmp/del.out -w "%{http_code}" -X DELETE \
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    "$base/$id")
  if [ "$http" = "204" ] || [ "$http" = "200" ]; then
    deleted=$((deleted + 1))
    echo "    -> deleted (HTTP $http)"
  else
    echo "    -> FAILED (HTTP $http): $(cat /tmp/del.out)"
  fi
done < "$tmpdir/candidates.txt"

echo
echo "Deleted $deleted version(s)."

# Verify final count.
page=1; final=0
while :; do
  resp=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    "${base}?per_page=100&page=${page}")
  n=$(printf '%s' "$resp" | jq 'if type=="array" then length else 0 end')
  if [ "$n" = "0" ] || [ "$n" = "null" ]; then break; fi
  final=$((final + n))
  page=$((page + 1))
done
echo "Versions remaining: $final"
if [ "$final" -lt "$KEEP_COUNT" ]; then
  echo "WARNING: fewer than $KEEP_COUNT versions remain!" >&2
  exit 1
fi
echo "Retention complete."
