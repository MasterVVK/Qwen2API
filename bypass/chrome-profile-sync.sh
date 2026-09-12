#!/usr/bin/env bash
# Сохранение профилей Chrome из RAM на диск (инкрементально).
#
# Профиль каждого солвера живёт в tmpfs (/config/.config/chromium), чтобы Chrome
# не молотил диск своими sqlite/leveldb базами. Копия на диске нужна, чтобы
# сессии Qwen пережили перезапуск: entrypoint разворачивает её в tmpfs до
# старта Chrome.
#
# Копировать профиль целиком нельзя — 137 МБ × 8 контейнеров на каждый прогон
# давали 97 МБ реальной записи, то есть ~9 ГБ в сутки (треть всей записи
# машины). Поэтому rsync с --link-dest: неизменённые файлы становятся
# жёсткими ссылками на прежнюю копию и не пишутся вовсе, на диск ложится
# только дельта. Подмена каталога одним mv, так что оборванный прогон
# оставляет прежнюю рабочую копию, а не обрубок.
#
# Запускается от root: профиль в tmpfs виден с хоста только через
# /proc/<pid>/root. rsync -a от root сохраняет владельца 1000:1000.
set -uo pipefail

DOCKER_DIR=/home/user/Qwen2API/docker
MIN_AGE=120        # контейнер моложе — ещё разворачивает профиль, не трогаем

synced=0; skipped=0; failed=0

for n in "" -2 -3 -4 -5 -6 -7 -8; do
    ctr="qwen2api-chrome-solver${n}"
    cfg="$DOCKER_DIR/chrome-solver-config${n}"

    [ "$(docker inspect -f '{{.State.Running}}' "$ctr" 2>/dev/null)" = "true" ] || continue

    started=$(docker inspect -f '{{.State.StartedAt}}' "$ctr" 2>/dev/null)
    if [ -n "$started" ]; then
        age=$(( $(date +%s) - $(date -d "$started" +%s 2>/dev/null || echo 0) ))
        if [ "$age" -lt "$MIN_AGE" ]; then
            echo "$ctr: стартовал $age с назад, пропускаем"
            skipped=$((skipped + 1)); continue
        fi
    fi

    pid=$(docker inspect -f '{{.State.Pid}}' "$ctr" 2>/dev/null)
    src="/proc/$pid/root/config/.config/chromium"

    # Профиль без Cookies — не профиль: рабочую копию таким не перезаписываем.
    if [ ! -s "$src/Default/Cookies" ]; then
        echo "$ctr: в RAM нет Cookies, копию на диске не трогаем"
        skipped=$((skipped + 1)); continue
    fi

    rm -rf "$cfg/.chromium-disk.new"
    if rsync -a --delete \
             ${cfg:+--link-dest="$cfg/.chromium-disk"} \
             "$src/" "$cfg/.chromium-disk.new/" 2>/dev/null; then
        rm -rf "$cfg/.chromium-disk.old"
        [ -d "$cfg/.chromium-disk" ] && mv "$cfg/.chromium-disk" "$cfg/.chromium-disk.old"
        mv "$cfg/.chromium-disk.new" "$cfg/.chromium-disk"
        rm -rf "$cfg/.chromium-disk.old"
        synced=$((synced + 1))
    else
        echo "$ctr: rsync не удался"
        rm -rf "$cfg/.chromium-disk.new"
        failed=$((failed + 1))
    fi
done

echo "профилей сохранено: $synced, пропущено: $skipped, с ошибкой: $failed"
