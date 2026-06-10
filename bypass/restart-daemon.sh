#!/bin/bash
# Restart the bypass daemon.
#
# Preferred path: systemd (auto-starts on reboot, logs to journald).
#   Install once:  sudo cp qwen2api-bypass.service /etc/systemd/system/ \
#                  && sudo systemctl daemon-reload \
#                  && sudo systemctl enable --now qwen2api-bypass
#   Logs:          journalctl -u qwen2api-bypass -f
#
# If the systemd unit is installed, just restart it. Otherwise fall back to
# the legacy nohup launch (PID file) for ad-hoc runs.

if systemctl list-unit-files qwen2api-bypass.service >/dev/null 2>&1 \
   && systemctl cat qwen2api-bypass.service >/dev/null 2>&1; then
    echo "restarting via systemd…"
    sudo systemctl restart qwen2api-bypass
    sleep 2
    curl -sS http://127.0.0.1:9099/healthz; echo
    exit 0
fi

echo "systemd unit not installed — falling back to nohup"
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
