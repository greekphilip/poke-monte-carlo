#!/bin/zsh

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd -- "$SCRIPT_DIR" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to run Pokémon Scenario Lab."
  echo "Install it from https://nodejs.org and try again."
  echo "Press any key to close."
  read -k 1
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
  echo "Note: Python 3.12 or newer is required only for automated dataset refresh."
  echo "The rest of the app can still run without it."
  echo ""
fi

exec node "$SCRIPT_DIR/server.mjs"
