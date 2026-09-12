#!/usr/bin/env bash
# Start both TrueTick services and wait until they actually answer.
#
# Written for the demo: the MCP server is a thin shell over these two, and the
# most likely way to lose a take is recording against a service that has not
# finished starting. This blocks until /health responds, then warms the data
# path so the first paid call is not the slow one.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${TMPDIR:-/tmp}"
PAID_LOG="$LOG_DIR/truetick-paid.log"
FREE_LOG="$LOG_DIR/truetick-free.log"

wait_for() { # url, label, tries
  local url="$1" label="$2" tries="${3:-60}"
  for ((i = 0; i < tries; i++)); do
    if curl -sf --max-time 2 "$url" >/dev/null 2>&1; then
      echo "  UP    $label  ($url)"
      return 0
    fi
    sleep 0.5
  done
  echo "  FAIL  $label did not come up — see the log"
  return 1
}

start_if_down() { # port, script, log, label
  local port="$1" script="$2" log="$3" label="$4"
  if lsof -ti:"$port" >/dev/null 2>&1; then
    echo "  (already running on :$port) $label"
    return 0
  fi
  echo "  starting $label -> $log"
  nohup node "$script" >"$log" 2>&1 &
}

echo "TrueTick services"
start_if_down 4402 paid-service.mjs "$PAID_LOG" "paid service (x402-gated)"
start_if_down 8402 service.mjs      "$FREE_LOG" "free service + UI"
echo

ok=0
wait_for "http://localhost:4402/health" "paid service" || ok=1
wait_for "http://localhost:8402/health" "free service" || ok=1

if [[ $ok -ne 0 ]]; then
  echo
  echo "Something did not start. Logs:"
  echo "  $PAID_LOG"
  echo "  $FREE_LOG"
  exit 1
fi

# Warm the default ticker through the PAID service's own free route: that is the
# process whose caches the paid call will use, and warming the other one does
# nothing for it.
TICKER="${1:-NVDA}"
echo
echo "  warming $TICKER (first fetch can take ~75s; later calls are ~1s)..."
START=$(date +%s)
if curl -sf --max-time 180 "http://localhost:4402/preview/$TICKER" >/dev/null 2>&1; then
  echo "  warm in $(( $(date +%s) - START ))s"
else
  echo "  warm-up did not finish — the MCP server will retry on demand"
fi

echo
echo "Ready. UI: http://localhost:8402/"
echo "Test the MCP server:  node mcp/selftest.mjs        (free)"
echo "                      node mcp/selftest.mjs --pay  (spends real HBAR)"
