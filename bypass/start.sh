#!/bin/bash
# Bootstrap script for the bypass daemon.
# Ensures socat is installed inside qwen2api-chrome and forwarding CDP from 127.0.0.1:9222 → 0.0.0.0:9223,
# then starts the Node.js daemon.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$SCRIPT_DIR/daemon.log"

echo "[$(date +'%H:%M:%S')] bootstrap: ensuring socat in qwen2api-chrome…"
if ! docker exec qwen2api-chrome which socat >/dev/null 2>&1; then
    echo "  installing socat (one-time)…"
    docker exec qwen2api-chrome sh -c 'apt-get update -qq && apt-get install -y socat' >/dev/null
fi

# Kill any old socat
docker exec qwen2api-chrome sh -c 'pkill -x socat 2>/dev/null; true' >/dev/null

# Start socat as background (detached) — survives our shell exit
echo "  starting socat 9223 → 127.0.0.1:9222…"
docker exec -d qwen2api-chrome sh -c \
    'nohup socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 > /tmp/socat.log 2>&1 &'

sleep 1

# Sanity check: socat listening on 9223 inside container
docker exec qwen2api-chrome ss -tln 2>/dev/null | grep -q ':9223' || {
    echo "ERROR: socat failed to bind 9223 inside chromium container"
    exit 1
}

# Sanity: CDP version from host
if ! curl -sS -m 5 http://127.0.0.1:9222/json/version | grep -q Browser; then
    echo "ERROR: CDP not reachable from host on 9222"
    exit 1
fi

# Restart daemon
echo "[$(date +'%H:%M:%S')] bootstrap: restarting daemon…"
for pid in $(pgrep -f "node $SCRIPT_DIR/daemon.js" 2>/dev/null); do
    /bin/kill "$pid" 2>/dev/null || true
done
sleep 1

cd "$SCRIPT_DIR"
nohup node daemon.js >> "$LOG" 2>&1 &
disown
sleep 2

curl -sS http://127.0.0.1:9099/healthz
echo
echo "[$(date +'%H:%M:%S')] bootstrap: done. logs at $LOG"
