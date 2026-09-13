#!/usr/bin/env bash
# Чистка распухающих баз профиля Chrome в солверах пула.
#
# History, DIPS и предиктор навигации этому браузеру не нужны, но Chromium
# дописывает их постоянно и они раздувают профиль (а он теперь живёт в RAM).
#
# Профиль лежит в tmpfs и исчезает вместе с контейнером, поэтому чистим не его,
# а диск-копию /config/.chromium-disk, из которой entrypoint восстанавливает
# профиль при старте. Перед остановкой сохраняем свежий профиль на диск, иначе
# потеряем изменения сессии с момента последнего синка.
#
# Канал теряет максимум ОДИН слот из восьми: занятые пропускаем, идём строго
# по одному, после старта ждём возвращения слота в пул.
set -uo pipefail

DOCKER_DIR=/home/user/Qwen2API/docker
HEALTH=http://localhost:9100/health
SETTLE=60          # сколько ждать после старта контейнера
START_TRIES=3      # столько раз пробуем поднять контейнер, прежде чем сдаться
MAX_FAILURES=1     # после стольких неудач подряд прекращаем проход
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

cd "$DOCKER_DIR" || { echo "нет каталога $DOCKER_DIR"; exit 1; }

# health отвечает до ~9 с под нагрузкой, поэтому таймаут щедрый
health=$(curl -s -m 30 "$HEALTH" 2>/dev/null)
if [ -z "$health" ]; then
    echo "канал не отвечает — выходим, ничего не трогаем"
    exit 0
fi

busy_ports=$(printf '%s' "$health" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print(' '.join(str(a.get('cdpPort')) for a in d.get('accounts', []) if a.get('busy')))
" 2>/dev/null)

failures=0
cleaned=0
skipped=0

for n in 8 7 6 5 4 3 2 ""; do
    svc="chrome-solver${n:+-$n}"
    ctr="qwen2api-chrome-solver${n:+-$n}"
    cfg="chrome-solver-config${n:+-$n}"
    port=$(( n == 0 ? 9563 : 9562 + n ))   # solver → 9563, solver-N → 9562+N

    if [[ " $busy_ports " == *" $port "* ]]; then
        echo "$svc: занят запросом, пропускаем"
        skipped=$((skipped + 1))
        continue
    fi

    before=$(du -sm "$cfg/.chromium-disk" 2>/dev/null | cut -f1)
    if [ "$DRY_RUN" = 1 ]; then
        hist=$(du -sm "$cfg/.chromium-disk/Default/History" 2>/dev/null | cut -f1)
        echo "$svc: [dry-run] порт $port свободен, диск-копия ${before:-0}M, History ${hist:-0}M — была бы очищена"
        cleaned=$((cleaned + 1))
        continue
    fi

    # Сохраняем актуальный профиль из RAM, иначе остановка контейнера потеряет
    # изменения сессии, накопленные после последнего синка.
    docker exec "$ctr" bash -c '
            set -e
            test -s /config/.config/chromium/Default/Cookies
            rm -rf /config/.chromium-disk.new
            cp -a /config/.config/chromium /config/.chromium-disk.new
            rm -rf /config/.chromium-disk
            mv /config/.chromium-disk.new /config/.chromium-disk
        ' >/dev/null 2>&1 || echo "$svc: синк перед чисткой не удался, чистим прежнюю копию"

    docker stop "$ctr" >/dev/null 2>&1

    D="$cfg/.chromium-disk/Default"
    rm -f "$D/History" "$D/History-journal" "$D/DIPS" "$D/DIPS-wal" \
          "$D/Network Action Predictor" 2>/dev/null
    rm -rf "$D/Site Characteristics Database" \
           "$cfg/.chromium-disk/segmentation_platform" 2>/dev/null

    # Одной попытки мало: в ночь на 13.09 контейнер завершился штатно
    # (ExitCode 0) и не встал за отведённое время, из-за чего проход оборвался
    # на последнем солвере. Пробуем несколько раз, прежде чем сдаться.
    started=no
    for try in $(seq 1 "$START_TRIES"); do
        docker compose -f docker-compose.yml -f docker-compose.pool.yml up -d "$svc" >/dev/null 2>&1
        sleep "$SETTLE"
        if [ "$(docker inspect -f '{{.State.Running}}' "$ctr" 2>/dev/null)" = "true" ]; then
            started=yes
            [ "$try" -gt 1 ] && echo "$svc: поднялся с попытки $try"
            break
        fi
        echo "$svc: попытка $try из $START_TRIES не удалась"
    done

    if [ "$started" != yes ]; then
        echo "$svc: контейнер не поднялся за $START_TRIES попыток"
        failures=$((failures + 1))
        [ "$failures" -ge "$MAX_FAILURES" ] && { echo "прекращаем проход"; exit 1; }
        continue
    fi

    after=$(du -sm "$cfg/.chromium-disk" 2>/dev/null | cut -f1)
    echo "$svc: очищен, диск-копия ${before:-0}M → ${after:-0}M"
    cleaned=$((cleaned + 1))
done

echo "готово: очищено $cleaned, пропущено занятых $skipped"
