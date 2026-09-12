# Развёртывание на хосте

Файлы, которые живут вне репозитория — в `/etc/systemd/system` и
`/etc/logrotate.d`. Здесь лежат их копии, чтобы после переустановки машины не
восстанавливать по памяти.

## systemd

| юнит | что делает |
|---|---|
| `chrome-profile-sync.{service,timer}` | каждые 15 мин сохраняет профили Chrome из tmpfs на диск (`bypass/chrome-profile-sync.sh`) |
| `chrome-profile-cleanup.{service,timer}` | в 03:00 UTC чистит History/DIPS в диск-копиях профилей (`bypass/chrome-profile-cleanup.sh`) |
| `novelbins-logrotate.{service,timer}` | раз в час проверяет размер логов novelbins |

Установка:

```sh
sudo cp deploy/systemd/* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chrome-profile-sync.timer chrome-profile-cleanup.timer novelbins-logrotate.timer
```

`chrome-profile-sync` работает от root: профиль солвера лежит в tmpfs и виден с
хоста только через `/proc/<pid>/root`.

## logrotate

```sh
sudo cp deploy/logrotate/novelbins /etc/logrotate.d/novelbins
```

Штатный `logrotate.timer` ходит раз в сутки, а `celery_llm.log` растёт примерно
на 170 МБ в день — отсюда отдельный почасовой таймер.
