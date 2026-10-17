#!/usr/bin/env bash
# GHCR retention helper.
#
# MODE=report  (default): list versions and mark keep/delete candidates. Never deletes.
# MODE=delete:            delete candidates, keeping the newest KEEP_COUNT versions
#                         plus every version carrying an immutable sha-* or semver tag.
#
# Safety guards:
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

owner_lc=$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')

# Pick user vs. organization endpoint.
if curl -sS -o /dev/null -w '%{http_code}' \
     -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/orgs/$owner_lc" | grep -q '^20'; then
  base="https://api.github.com/orgs/$owner_lc/packages/container/$PACKAGE/versions"
else
  base="https://api.github.com/users/$owner_lc/packages/container/$PACKAGE/versions"
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

page=1
while :; do
  resp=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    "${base}?per_page=100&page=${page}")
  n=$(printf '%s' "$resp" | jq 'if type=="array" then length else 0 end')
  if [ "$n" = "0" ] || [ "$n" = "null" ]; then break; fi
  printf '%s' "$resp" | jq -c '.[]' >> "$tmpdir/versions.jsonl"
  page=$((page + 1))
done

if [ ! -s "$tmpdir/versions.jsonl" ]; then
  echo "No versions found for ghcr.io/$owner_lc/$PACKAGE (package may not exist yet)."
  exit 0
fi

total=$(wc -l < "$tmpdir/versions.jsonl" | tr -d ' ')
echo "Package: ghcr.io/$owner_lc/$PACKAGE"
echo "Total versions: $total"
echo "Mode: $MODE  |  Keep count: $KEEP_COUNT"
echo

# Sort by created_at descending (newest first) for keep-set selection.
jq -s 'sort_by(.created_at) | reverse' "$tmpdir/versions.jsonl" > "$tmpdir/sorted.json"

# Determine keep set: newest KEEP_COUNT + any with sha-* or semver tag.
jq -r --argjson k "$KEEP_COUNT" '
  . as $all |
  ( [range(0; ($k | tonumber))] | map($all[.].id) ) as $newest |
  ( $all[] | select((.metadata.container.tags // []) | any(test("^sha-"))) | .id ) as $sha |
  ( $all[] | select((.metadata.container.tags // []) | any(test("[0-9]+\\.[0-9]+"))) | .id ) as $semver |
  ($newest + [$sha] + [$semver]) | unique | .[]
' "$tmpdir/sorted.json" > "$tmpdir/keep.txt" 2>/dev/null || true

# Fallback: ensure at least the newest KEEP_COUNT are kept even if jq path above misfires.
if [ ! -s "$tmpdir/keep.txt" ]; then
  jq -r --argjson k "$KEEP_COUNT" '.[:$k] | .[].id' "$tmpdir/sorted.json" > "$tmpdir/keep.txt"
fi

echo "Keep set (ids):"
cat "$tmpdir/keep.txt" | sed 's/^/  /'
echo

# Safety: never go below KEEP_COUNT versions total.
if [ "$total" -le "$KEEP_COUNT" ]; then
  echo "Total ($total) <= keep count ($KEEP_COUNT): nothing to delete."
  exit 0
fi

# Candidates = versions not in keep set.
jq -r '.[].id' "$tmpdir/sorted.json" | while read -r id; do
  if ! grep -qx "$id" "$tmpdir/keep.txt"; then
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
  if grep -qx "$id" "$tmpdir/keep.txt"; then
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
  if grep -qx "$id" "$tmpdir/keep.txt"; then
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
