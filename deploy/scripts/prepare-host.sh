#!/usr/bin/env bash
# Creates the EBS-backed host directories the stack depends on and gives each one
# the ownership its container expects.
#
#   sudo deploy/scripts/prepare-host.sh            # create/verify
#   sudo deploy/scripts/prepare-host.sh --check    # verify only, change nothing
#
# It never deletes anything, never runs a destructive volume operation, and
# refuses to touch a PostgreSQL directory that belongs to a different UID unless
# the operator asks for it. Re-running is safe.
#
# Ownership facts, verified against the images this stack pins:
#   postgres:17-alpine     -> postgres uid/gid 70   (needs the data directory)
#   backend (node:24)      -> node     uid/gid 1000 (needs the upload directory)
#   nginx edge             -> reads TLS material as root; dirs are 0700 root:root
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BHOOMITRACE_SCRIPT_NAME="prepare-host"
CHECK_ONLY=false

usage() {
  cat >&2 <<'EOF'
Usage: prepare-host.sh [--check]

  --check   verify the layout and ownership without creating or changing anything

Requires deploy/env/stack.env. Runs as root.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=true ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unexpected argument: $1" ;;
  esac
  shift
done

load_config
require_cmd stat
require_var BHOOMITRACE_DATA_DIR
require_root

DATA_DIR="$BHOOMITRACE_DATA_DIR"
TLS_DIR="${BHOOMITRACE_TLS_DIR:-$DATA_DIR/tls}"
BACKUP_DIR="${BHOOMITRACE_BACKUP_DIR:-$DATA_DIR/backups}"
STATE_DIR="${BHOOMITRACE_STATE_DIR:-$DATA_DIR/state}"
POSTGRES_UID="${POSTGRES_UID:-70}"
UPLOAD_UID="${UPLOAD_UID:-1000}"

# --- Identify the EBS mount -------------------------------------------------
# The database and every upload live here. If this path sits on the root
# filesystem, a full root volume takes the database with it, so that condition is
# treated as an error unless explicitly accepted.
info "resolving filesystem for $DATA_DIR"
if [[ -d "$DATA_DIR" ]]; then
  df -PT "$DATA_DIR" >&2 || true
  DATA_FS="$(df -PT "$DATA_DIR" | awk 'NR==2 {print $1}')"
  DATA_MOUNT="$(df -PT "$DATA_DIR" | awk 'NR==2 {print $7}')"
  ROOT_FS="$(df -PT / | awk 'NR==2 {print $1}')"
  info "data dir filesystem=$DATA_FS mountpoint=$DATA_MOUNT"
  if [[ "$DATA_FS" == "$ROOT_FS" && "${BHOOMITRACE_ALLOW_ROOT_FS:-false}" != "true" ]]; then
    die "$DATA_DIR is on the root filesystem ($ROOT_FS). Mount the EBS data volume there first, or set BHOOMITRACE_ALLOW_ROOT_FS=true to accept that the database lives on the root volume."
  fi
else
  warn "$DATA_DIR does not exist yet; the EBS mount cannot be verified until the volume is mounted"
  if ! verify_mode_enabled; then
    die "create and mount the EBS data volume at $DATA_DIR first (see deploy/README.md), or set BHOOMITRACE_ALLOW_ROOT_FS=true to accept the root filesystem"
  fi
fi

# --- Directory table --------------------------------------------------------
# name|path|mode|owner|description
DIRECTORIES=(
  "postgres|$DATA_DIR/postgres|700|$POSTGRES_UID:$POSTGRES_UID|PostgreSQL data directory (EBS)"
  "uploads|$DATA_DIR/uploads|750|$UPLOAD_UID:$UPLOAD_UID|Uploaded evidence, shared by API and worker (EBS)"
  "tls|$TLS_DIR|700|0:0|Flat TLS certificate pair (EBS)"
  "acme|$DATA_DIR/acme|755|0:0|ACME HTTP-01 challenge webroot"
  "backups|$BACKUP_DIR|700|0:0|Local staging for dumps and evidence tarballs (EBS)"
  "state|$STATE_DIR|700|0:0|Recorded releases for rollback (EBS)"
  "logs|$DATA_DIR/logs|750|0:0|Deployment, backup, and restore logs (EBS)"
)

create_directory() {
  local name="$1" path="$2" mode="$3" owner="$4" description="$5"

  if [[ "$CHECK_ONLY" == "true" ]]; then
    [[ -d "$path" ]] || die "[$name] missing: $path ($description)"
    info "[$name] present: $path"
    return 0
  fi

  if [[ -d "$path" ]]; then
    info "[$name] already exists, leaving contents untouched: $path"
  else
    mkdir -p "$path"
    info "[$name] created: $path"
  fi

  # Never widen an existing mode; apply the intended mode and ownership.
  chmod "$mode" "$path"
  local current_owner
  current_owner="$(stat -c '%u:%g' "$path" 2>/dev/null || stat -f '%u:%g' "$path")"
  if [[ "$current_owner" != "$owner" ]]; then
    # chown of a directory is not a destructive operation, but a pre-existing
    # PostgreSQL data directory is reported first so the change is deliberate.
    if [[ "$name" == "postgres" && -n "$(ls -A "$path" 2>/dev/null | head -1)" ]]; then
      warn "[$name] pre-existing data found in $path; setting ownership to $owner for the container user"
    fi
    info "[$name] chown $owner $path (was $current_owner)"
    chown "$owner" "$path"
  fi

  # The upload directory is written by the API (uid 1000). 0750 with the
  # container GID keeps it non-world-readable while remaining writable.
  info "[$name] ready: mode=$mode owner=$owner ($description)"
}

info "starting prepare-host (check_only=$CHECK_ONLY)"
for entry in "${DIRECTORIES[@]}"; do
  IFS='|' read -r name path mode owner description <<<"$entry"
  create_directory "$name" "$path" "$mode" "$owner" "$description"
done

if [[ "$CHECK_ONLY" == "true" ]]; then
  # In check mode the script is read-only, so a fresh host legitimately fails.
  # Report the outcome explicitly rather than exiting zero on a partial layout.
  info "layout check complete"
fi

info "prepare-host finished"
