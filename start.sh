#!/bin/sh
set -eu

cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
Usage: ./start.sh [--check] [--no-build] [--no-open] [--open]
                  [--port N] [--db PATH] [--help]
EOF
}

error() {
  printf '[start] ERROR: %s\n' "$1" >&2
  exit 2
}

check=0
no_build=0
open=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) check=1 ;;
    --no-build) no_build=1 ;;
    --no-open) open=0 ;;
    --open) open=1 ;;
    --port|--db)
      option=$1
      shift
      [ "$#" -gt 0 ] || error "$option requires a value"
      case "$1" in ''|--*) error "$option requires a value" ;; esac
      if [ "$option" = --port ]; then
        export SUPERSTRING_DEV_PORT="$1"
      else
        export SUPERSTRING_DB_PATH="$1"
      fi
      ;;
    --help|-h) usage; exit 0 ;;
    *) error "unknown argument: $1" ;;
  esac
  shift
done

export SUPERSTRING_SERVE_WEB=1

if [ -n "${SUPERSTRING_BUN_EXE:-}" ]; then
  BUN=$SUPERSTRING_BUN_EXE
elif [ -x ./node_modules/.bin/bun ]; then
  BUN=./node_modules/.bin/bun
else
  BUN=$(command -v bun) || error 'bun not found; run npm ci first'
fi
[ -x "$BUN" ] || error "bun is not executable: $BUN"

if [ "$check" -eq 1 ]; then
  exec "$BUN" tools/ops/start.ts --check
fi

if [ "$no_build" -eq 1 ]; then
  "$BUN" tools/ops/start.ts --no-build
else
  "$BUN" tools/ops/start.ts
fi

if [ "$open" -eq 1 ]; then
  "$BUN" tools/ops/open-when-ready.ts --port "${SUPERSTRING_DEV_PORT:-17861}" --timeout 30000 &
fi
exec "$BUN" run src/server/index.ts
