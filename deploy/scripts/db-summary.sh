#!/usr/bin/env bash
# Prints a canonical, diffable summary of a PostgreSQL database.
#
#   deploy/scripts/db-summary.sh --container bhoomitrace-drill --db bhoomitrace_restore_scratch
#   deploy/scripts/db-summary.sh --compose --db bhoomitrace
#
# Output (sorted, stable, no fluff):
#   migrations|<count or missing>
#   tables|<count>
#   table|<name>|<row count>     (one line per table in the public schema)
#
# A restore drill compares this output for the source database and the restored
# copy. Equal output means every table exists and every table holds the same
# number of rows, which is the strongest check that does not require the
# application to be running.
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="db-summary"

CONTAINER=""
DB_NAME=""
USE_COMPOSE=false
DB_USER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container)
      [[ $# -ge 2 ]] || die "--container needs a value"
      CONTAINER="$2"
      shift 2
      ;;
    --compose) USE_COMPOSE=true; shift ;;
    --db)
      [[ $# -ge 2 ]] || die "--db needs a value"
      DB_NAME="$2"
      shift 2
      ;;
    --user)
      [[ $# -ge 2 ]] || die "--user needs a value"
      DB_USER="$2"
      shift 2
      ;;
    -h | --help)
      echo "Usage: db-summary.sh (--container NAME | --compose) --db NAME [--user USER]" >&2
      exit 0
      ;;
    *) die "unexpected argument: $1" ;;
  esac
done

require_cmd docker
[[ -n "$DB_NAME" ]] || die "--db is required"
[[ "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "--db must be a plain identifier (got: $DB_NAME)"

load_config

if [[ "$USE_COMPOSE" == "true" ]]; then
  DB_USER="${DB_USER:-$POSTGRES_USER}"
  run_psql() { compose exec -T postgres psql -U "$DB_USER" "$@"; }
else
  [[ -n "$CONTAINER" ]] || die "--container NAME is required unless --compose is given"
  DB_USER="${DB_USER:-postgres}"
  run_psql() { docker exec -i "$CONTAINER" psql -U "$DB_USER" "$@"; }
fi

# Migration journal: reported as "missing" rather than failing, so a database
# that predates the journal is distinguishable from one that failed to restore.
MIGRATIONS="$(run_psql -d "$DB_NAME" -tAc "
  SELECT CASE
    WHEN to_regclass('drizzle.__drizzle_migrations') IS NULL THEN 'missing'
    ELSE (SELECT count(*)::text FROM drizzle.__drizzle_migrations)
  END;
" 2>/dev/null | tr -d '[:space:]')"

if [[ -z "$MIGRATIONS" ]]; then
  die "could not query database '$DB_NAME' (is it created and reachable?)"
fi

printf 'migrations|%s\n' "$MIGRATIONS"

# Every table in the public schema with its exact row count. query_to_xml is used
# so the count is produced by the server for an arbitrary table name without
# building the query in the client.
run_psql -d "$DB_NAME" -tAF'|' -c "
  SELECT 'table', tablename,
         (xpath('/row/c/text()',
                query_to_xml(format('SELECT count(*) AS c FROM public.%I', tablename), false, true, '')))[1]::text::bigint::text
  FROM pg_tables
  WHERE schemaname = 'public'
  ORDER BY tablename;
" 2>/dev/null | sed 's/^/ /' | sed 's/^ //'

printf 'tables|%s\n' "$(run_psql -d "$DB_NAME" -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public';" | tr -d '[:space:]')"
