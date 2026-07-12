#!/bin/bash
# solver-cdp-watchdog.sh
# Сторож CDP браузеров qwen2api-chrome-solver-*.
#
# Проблема: после перезагрузки сервера контейнеры поднимаются (restart:
# unless-stopped), статус "Up", но chromium внутри не отдаёт CDP на
# проброшенном порту (curl /json/version → нет ответа). browser-channel
# при этом валит все аккаунты в cooling с "CDP connect failed", и весь
# канал стоит, хотя docker ps выглядит зелёным.
#
# Решение: для каждого контейнера проверяем его host-порт CDP; если
# /json/version не отвечает дважды подряд (с паузой) — docker restart
# ТОЛЬКО этого контейнера. Здоровые не трогаем (не рвём живые запросы).
#
# Установка (crontab -e от user):
#   @reboot sleep 180 && /home/user/Qwen2API/bypass/solver-cdp-watchdog.sh boot
#   */5 * * * * /home/user/Qwen2API/bypass/solver-cdp-watchdog.sh
#
# Лог: /home/user/Qwen2API/bypass/solver-cdp-watchdog.log

LOG="/home/user/Qwen2API/bypass/solver-cdp-watchdog.log"
LOCK="/tmp/solver-cdp-watchdog.lock"
RECHECK_DELAY=10      # сек между двумя проверками перед рестартом
CURL_TIMEOUT=5
MODE="${1:-cron}"     # boot | cron

ts() { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "$(ts) $*" >> "$LOG"; }

# Не даём двум копиям работать одновременно (boot + cron)
exec 9>"$LOCK"
flock -n 9 || exit 0

# Кап на размер лога (~200KB): оставляем хвост
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 200000 ]; then
    tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

cdp_alive() {
    local port="$1"
    curl -s -m "$CURL_TIMEOUT" -o /dev/null -w "%{http_code}" \
        "http://127.0.0.1:${port}/json/version" 2>/dev/null | grep -q "^200$"
}

# host-порт CDP контейнера: единственный проброшенный порт из диапазона 95xx
container_cdp_port() {
    docker inspect "$1" \
        --format '{{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{(index $b 0).HostPort}} {{end}}{{end}}' \
        2>/dev/null | tr ' ' '\n' | grep -E '^95[0-9]{2}$' | head -1
}

CONTAINERS=$(docker ps --filter "name=qwen2api-chrome-solver" --format '{{.Names}}')
[ -z "$CONTAINERS" ] && { log "WARN: контейнеры qwen2api-chrome-solver-* не найдены"; exit 0; }

declare -A DEAD_PORT
for c in $CONTAINERS; do
    port=$(container_cdp_port "$c")
    if [ -z "$port" ]; then
        log "WARN: $c — не нашёл проброшенный CDP-порт, пропуск"
        continue
    fi
    cdp_alive "$port" || DEAD_PORT[$c]=$port
done

# Всё живо — тихо выходим (в boot-режиме отметимся в логе)
if [ ${#DEAD_PORT[@]} -eq 0 ]; then
    [ "$MODE" = "boot" ] && log "BOOT: все CDP живы, рестарт не нужен"
    exit 0
fi

# Повторная проверка упавших — отсекаем транзиентные тормоза
sleep "$RECHECK_DELAY"
for c in "${!DEAD_PORT[@]}"; do
    port=${DEAD_PORT[$c]}
    if cdp_alive "$port"; then
        log "INFO: $c (:$port) ожил при повторной проверке — не трогаем"
        continue
    fi
    log "RESTART: $c (:$port) — CDP не отвечает дважды, docker restart"
    docker restart "$c" >/dev/null 2>&1 \
        && log "OK: $c перезапущен" \
        || log "ERROR: docker restart $c не удался"
done
exit 0
