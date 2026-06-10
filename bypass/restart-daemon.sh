#!/bin/bash
# Kill old daemon by PID file, then start fresh.
PID_FILE=/tmp/qwen2api-bypass-daemon.pid
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "killing old daemon pid=$OLD_PID"
        kill "$OLD_PID"
        sleep 2
        kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID"
    fi
fi
cd /home/user/Qwen2API/bypass
nohup node daemon.js >> daemon.log 2>&1 &
disown
sleep 2
curl -sS http://127.0.0.1:9099/healthz
