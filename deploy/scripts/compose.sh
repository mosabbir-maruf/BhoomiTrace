#!/usr/bin/env bash
# Thin wrapper so operators (and the systemd units) never hand-assemble the
# docker compose invocation. Every production command goes through here.
#
#   deploy/scripts/compose.sh ps
#   deploy/scripts/compose.sh logs -f api
#   deploy/scripts/compose.sh exec postgres psql -U bhoomitrace -d bhoomitrace
#
# Reads deploy/env/stack.env and deploy/env/secrets.env.
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_config
load_secrets
require_cmd docker

# `compose` is a shell function from lib.sh, so it cannot be run through `exec`.
# Called as the final command its exit status is still the script's exit status.
compose "$@"
