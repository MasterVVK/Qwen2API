# Qwen2API — fork-документация

> Эта версия — приватный форк апстрима [Rfym21/Qwen2API](https://github.com/Rfym21/Qwen2API).
> Документ самодостаточный: всё, что нужно для эксплуатации именно этой
> инсталляции, описано здесь. Базовое описание моделей и OpenAI-совместимости
> можно посмотреть в апстрим-репо.

## TL;DR — чем форк отличается от апстрима

Апстрим оптимизирован под **массовое использование**: десятки аккаунтов,
LRU-ротация, отдельный CLI-канал для thinking-режимов, минимум вмешательства
в HTTP-слой.

Этот форк оптимизирован под **обход WAF на небольшом пуле аккаунтов**
(сейчас 5). Главные отличия:

| Аспект | Апстрим | Этот форк |
|---|---|---|
| Cookie `x5sec` (Aliyun WAF) | не управляется | **per-account**, JSON-persistent, авто-bypass |
| Slide-капча Aliyun | нет автоматизации | **end-to-end auto** (headless chromium + vision-LLM) |
| Ответ при блокировке | пустой 200 + `content: null` | **HTTP 503 + `Retry-After`** |
| Truncation thinking-ответов | `finish_reason: stop` (мусор) | `finish_reason: length` + `incomplete_details` |
| Прокси | один общий `PROXY_URL` | **per-account proxy** (поле `proxy` у каждого) |
| CLI-канал thinking-моделей | используется | не задействован (всё через web-channel) |
| Мониторинг | logger | + health-loop, taps на daemon-логе, captcha-UI |

Если нужно «много аккаунтов с rotation, без капчи» — апстрим. Если
«5 аккаунтов работают 24/7 несмотря на WAF» — этот форк.

## Подключение

| Параметр | Значение |
|---|---|
| Base URL | `http://localhost:3001/v1` |
| API key | `sk-123456` (admin: дашборд + API + `/api/captcha/*`) |
| Дашборд | `http://localhost:3001/` |
| Captcha UI | `http://localhost:3001/api/captcha/ui?key=sk-123456` |
| Bypass-daemon | `http://192.168.0.58:9099` (внутренний, не наружу) |

Любой OpenAI-клиент:
```bash
OPENAI_BASE_URL=http://localhost:3001/v1
OPENAI_API_KEY=sk-123456
```

## Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│ Клиент (OpenAI SDK / curl)                                  │
└───────────────────────────┬─────────────────────────────────┘
                            │ /v1/chat/completions
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ qwen2api  (Node/Express, контейнер qwen2api, :3001 → :3000) │
│  ├─ chat-middleware  — проброс gen-params                   │
│  ├─ controllers/chat — stream/non-stream, truncation detect │
│  ├─ utils/request    — sniffOrRestore: WAF-детектор stream'а│
│  ├─ utils/ssxmod-mgr — per-account cookie store (JSON)      │
│  └─ routes/captcha   — REST для captcha-pipeline            │
└───────┬──────────────────────────────┬──────────────────────┘
        │ upstream HTTPS               │ POST /refresh?email=X
        │ via per-account proxy        ▼
        │                ┌─────────────────────────────────────┐
        │                │ bypass/daemon.js  (host, :9099)     │
        │                │  per-account dedup, history         │
        │                └──────────────┬──────────────────────┘
        │                               │ docker exec
        │                               ▼
        │                ┌─────────────────────────────────────┐
        │                │ qwen2api-chrome-headless            │
        │                │  spawn chromium per bypass:         │
        │                │   --proxy-server=<account.proxy>    │
        │                │   --user-data-dir=/tmp/profile-N    │
        │                │   --remote-debugging-port=9300+N    │
        │                │  → CDP → slide drag (833,535)       │
        │                │  → fallback: vision-LLM (Ollama)    │
        │                └──────────────┬──────────────────────┘
        │                               │ x5sec cookie
        │                               ▼
        │                POST /api/captcha/_apply?email=X
        │                (даemon push'ит свежий cookie qwen2api)
        ▼
   chat.qwen.ai
```

## Контейнеры

В compose'е три сервиса. У каждого своя роль — почему именно три, разъяснено
в строках «Зачем».

| Контейнер | Образ | Сеть/порты | Роль |
|---|---|---|---|
| `qwen2api` | `rfym21/qwen2api:latest` (+ bind-mount `./src`) | `3001:3000` | API-сервер (Node/Express), всё что трогает клиент |
| `qwen2api-chrome` | `lscr.io/linuxserver/chromium` | `192.168.0.58:3010-3011` | **noVNC windowed chromium** для ручных операций |
| `qwen2api-chrome-headless` | `zenika/alpine-chrome` | `network_mode: host` | **Chromium runtime для bypass-daemon** |

### Зачем `qwen2api-chrome` (windowed/noVNC)
Доступен на `https://192.168.0.58:3011` (self-signed). Используется для:
- ручной проверки upstream'a через тот же прокси, что и аккаунт;
- руководящего прохождения капчи если daemon упёрся (резерв);
- быстрого визуального дебага верстки captcha-страницы Aliyun.

В **автоматическом bypass-пайплайне не задействован**.

### Зачем `qwen2api-chrome-headless` (отдельный контейнер)
Bypass-daemon на хосте, ему нужен binary chromium для каждого аккаунта
со своим прокси. Решение в лоб — гонять chromium прямо в `qwen2api-chrome` —
**не работает**: chromium 148+ запрещает `Target.createBrowserContext`
через TCP CDP когда основной chromium запущен в non-headless режиме
(security policy, обходить не разумно).

Поэтому второй контейнер: `entrypoint: sleep`, висит без полезной нагрузки,
а daemon на каждый bypass делает:
```bash
docker exec qwen2api-chrome-headless chromium \
  --headless --user-data-dir=/tmp/profile-N \
  --proxy-server=http://192.168.0.5x:8888 \
  --remote-debugging-port=$((9300 + N))
```
Каждый bypass — отдельный процесс с уникальным профилем, портом и прокси.
`network_mode: host` — чтобы daemon (тоже на хосте) дотягивался до CDP
через `127.0.0.1:9300+N`.

Образ `zenika/alpine-chrome` выбран как самый лёгкий с chromium-binary'ём
из коробки (без X-сервера, без графики).

## Аккаунты и прокси

Аккаунты живут в `data/data.json` (поле `accounts`). У каждого:
- `email`, `password`, `token` (JWT), `expires_at`
- `proxy: "http://192.168.0.5x:8888"` — индивидуальный HTTP-прокси
  (tinyproxy), либо пусто → выход через host IP контейнера

Текущий пул — **5 аккаунтов** через 3 прокси-узла (.56/.61/.62) +
прямой выход. У каждого аккаунта свой `x5sec` cookie, привязанный
к IP его прокси. Подмешать чужой `x5sec` нельзя — WAF проверяет
связку JWT + cookie + IP-сегмент.

**SOCKS5 не поддерживается** (импортируется только `https-proxy-agent`).
Только HTTP-прокси.

## Captcha-pipeline

### Обычный flow
1. Клиент → `POST /v1/chat/completions`.
2. `request.js` → upstream через прокси этого аккаунта.
3. `sniffOrRestore` читает первые 4 КБ стрима, ищет `FAIL_SYS_USER_VALIDATE`.
4. Если **есть блок** — `triggerInBackground({email, captchaUrl})` (без
   ожидания) + ответ клиенту: `503 + Retry-After: 30 + {error.code: "waf_block"}`.
5. Daemon делает bypass за ~15-25 сек, пушит свежий cookie через
   `/api/captcha/_apply`, qwen2api сохраняет в `data/captcha-cookies.json`.
6. Следующий запрос клиента (после Retry-After) идёт уже с свежим `x5sec`.

### Что делает daemon
1. Берёт `account.proxy` из `data.json`.
2. Спавнит **отдельный headless chromium** через `docker exec qwen2api-chrome-headless`
   с уникальными `--user-data-dir`, `--proxy-server`, `--remote-debugging-port` (9300+N).
3. Через CDP инжектит JWT cookie, идёт на captcha URL.
4. Ждёт прорисовки слайдера (до 35 сек).
5. **Hardcoded drag (833, 535)** — основной путь, ~95% попыток.
6. Polls `x5sec` 6 сек. Если не появился — `Page.reload` +
   **vision-fallback** (Ollama, `qwen2.5vl:7b` на `192.168.0.58`),
   парсит координаты из ответа, ещё один drag.
7. Закрывает chromium, отвечает в qwen2api.

### Per-email dedup
Если для одного email-а пришло 5 одновременных запросов — bypass
запускается **один раз**, результат шарится. Для разных email-ов —
параллельно.

## Endpoints (форк-специфичные)

Все требуют `Authorization: Bearer sk-123456`.

| Method | Path | Назначение |
|---|---|---|
| `POST` | `/api/captcha/_apply?email=X` | Daemon пушит свежий cookie для аккаунта |
| `DELETE` | `/api/captcha/_apply?email=X` | Очистить cookie аккаунта (форс reauth) |
| `GET` | `/api/captcha/status` | Состояние всех cookie + история bypass'ов |
| `POST` | `/api/captcha/refresh?email=X` | Ручной триггер bypass |
| `POST` | `/api/captcha/_trigger?email=X` | Probe upstream именно этим аккаунтом (без retry-loop, для диагностики) |
| `GET` | `/api/captcha/ui` | HTML-таблица с кнопкой "refresh" на каждом аккаунте |

## Контроль версий

Форк ведётся в **MasterVVK/Qwen2API** (remote `mine`), апстрим Rfym21
подключён как `origin` для подтягивания обновлений.

```bash
git remote -v
#   mine    https://github.com/MasterVVK/Qwen2API.git   (форк — сюда пушим)
#   origin  https://github.com/Rfym21/Qwen2API.git       (апстрим — отсюда тянем)

# повседневная работа
git push mine main

# подтянуть обновления апстрима и влить в форк
git fetch origin
git merge origin/main        # или: git rebase origin/main
```

**Не коммитим** (в `.gitignore`): `chrome-config/`, `chrome-headless-data/`
(runtime-профиль chromium с куками/паролями/SSL-ключом), `.env`, `data/`,
`*.log`, `node_modules`.

## Эксплуатация

```bash
cd /home/user/Qwen2API

# логи приложения
docker logs -f qwen2api
docker logs --tail 50 qwen2api

# ВАЖНО: всегда указывай --project-directory (корень проекта), иначе
# относительные volumes (./src) и env_file (.env) отрезолвятся от docker/
# и контейнер стартует с пустым /app/src.
DC="docker compose -f docker/docker-compose.yml --project-directory /home/user/Qwen2API --project-name qwen2api"

# рестарт qwen2api (после правки src/ — restart перечитывает примонтированный код)
$DC restart qwen2api

# применить изменения compose (healthcheck, новые сервисы) — recreate
$DC up -d qwen2api

# рестарт chrome-контейнеров (редко)
$DC restart chrome chrome-headless

# bypass-daemon (под systemd — авто-старт после ребута, логи в journald)
sudo systemctl status qwen2api-bypass
sudo systemctl restart qwen2api-bypass
journalctl -u qwen2api-bypass -f          # вместо tail -f daemon.log
bash bypass/restart-daemon.sh             # обёртка: systemd, иначе nohup-fallback
curl -sS http://192.168.0.58:9099/healthz
curl -sS http://192.168.0.58:9099/status | jq .

# установка systemd-юнита (однократно)
sudo cp bypass/qwen2api-bypass.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qwen2api-bypass

# captcha-статус и ручной refresh
curl -sS -H "Authorization: Bearer sk-123456" \
  http://localhost:3001/api/captcha/status | jq .
curl -sS -X POST -H "Authorization: Bearer sk-123456" \
  "http://localhost:3001/api/captcha/refresh?email=qoder@synntes.com" | jq .
```

## Прокси (tinyproxy)

```bash
# логи на прокси-хосте
ssh user@192.168.0.56 'sudo tail -f /var/log/tinyproxy/tinyproxy.log'

# рестарт
ssh user@192.168.0.56 'sudo systemctl restart tinyproxy'
ssh user@192.168.0.56 'sudo cat /etc/tinyproxy/tinyproxy.conf | grep -v ^#'
```

Tinyproxy на `0.0.0.0:8888`, разрешён доступ из `192.168.0.0/24`, без авторизации.
Аналогично — на `.61` и `.62`.

## Curl-примеры

### Текст с thinking
```bash
curl -sS http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-123456" -H "Content-Type: application/json" \
  -d '{"model":"qwen3-max-thinking","messages":[{"role":"user","content":"Объясни энтропию"}],"max_tokens":64000,"temperature":0.7,"top_p":0.95}'
```

### Картинка
```bash
curl -sS http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-123456" -H "Content-Type: application/json" \
  -d '{"model":"qwen3-max-image","messages":[{"role":"user","content":"кот на крыше, закат"}],"size":"1328*1328"}'
```

### Image-edit
```bash
'{"model":"qwen3-max-image-edit","messages":[{"role":"user","content":[
  {"type":"text","text":"перенеси сцену в день"},
  {"type":"image","image":"https://cdn.qwenlm.ai/.../source.png?key=..."}
]}]}'
```

### Видео (t2v, ~2 мин, MP4 5 сек)
```bash
'{"model":"qwen3-max-video","messages":[{"role":"user","content":"описание сцены"}]}'
```

## Что делает клиент при 503

При WAF-блокировке qwen2api отдаёт:
```http
HTTP/1.1 503 Service Unavailable
Retry-After: 30
Content-Type: application/json

{"error":{"type":"captcha_required","code":"waf_block",
  "message":"Upstream Aliyun WAF requires captcha verification..."}}
```

Клиент должен **сам ретрайнуть** через `Retry-After` секунд. Bypass за
это время отработает, и следующий запрос пройдёт. Внутри qwen2api ретрая
нет принципиально — клиент видит состояние upstream'a как есть.

## Truncation detection (для thinking-моделей)

Upstream Qwen имеет жёсткий cap completion-токенов ~16-20k (даже при
`max_tokens: 64000`). Если thinking-режим расходует бюджет на reasoning
и не успевает дописать финальный ответ, приходит `<think>...` без
`</think>` и без финального текста, но с честным `finish_reason: stop`
от upstream'a.

Форк это ловит: `detectTruncation(content)` в `src/controllers/chat.js`
проверяет наличие незакрытого `<think>` и, если есть, заменяет на:
```json
{
  "finish_reason": "length",
  "incomplete_details": { "reason": "thinking_truncated" }
}
```

Клиент по стандартному `finish_reason: "length"` сам решает: split,
retry, fail.

## Замеренные характеристики

| Операция | Время | Размер |
|---|---|---|
| Чат (короткий) | 2-5 сек | — |
| Чат + thinking (~5k hanzi → перевод) | ~3 мин | ~20k tokens completion |
| Картинка 1328² | ~18 сек | 2-3 МБ PNG |
| Edit картинки | ~25 сек | 1.5 МБ PNG (1024²) |
| Видео 5 сек | ~2 мин 10 сек | 6.5 МБ MP4 |
| **Bypass slide-капчи (E2E)** | **15-25 сек** | — |

Upstream-cap completion: **~16-20k токенов**.

## Известные ограничения

1. **`x5sec` TTL ~30 минут**, иногда меньше (наблюдалось от 15 мин у
   `qoder@synntes.com`). Bypass запускается реактивно — клиент при
   первом запросе после протухания получает 503, при втором — успех.
2. **Vision-fallback зависит от Ollama** на `192.168.0.58`. Если Ollama
   рестартанули — модель надо подгрузить (`ollama run qwen2.5vl:7b`),
   иначе fallback фолбэка нет. Hardcoded coords (833,535) работают
   независимо.
3. **noVNC-chromium тормозит** при удалённом доступе (для ручных проверок
   используется редко).
4. **Daemon на host'е, не в Docker.** Управляется `bypass/restart-daemon.sh`,
   PID в `/tmp/qwen2api-bypass-daemon.pid`.
5. **CLI-канал апстрима не задействован.** Все запросы — через web channel.

## Файлы форка (что добавлено/переписано)

| Файл | Назначение |
|---|---|
| `bypass/daemon.js` | Host-сайд daemon (~480 строк), HTTP-сервер на :9099 |
| `bypass/start.sh`, `restart-daemon.sh` | Запуск/перезапуск daemon |
| `public/captcha.html` | UI таблица аккаунтов с кнопками refresh |
| `src/routes/captcha.js` | REST: `_apply`, `status`, `refresh`, `_trigger`, `ui` |
| `src/utils/captcha-trigger.js` | Inline-детектор + dedup'нутый trigger |
| `src/utils/ssxmod-manager.js` | Per-account cookie store + JSON persist |
| `src/utils/request.js` | `sniffOrRestore`: 4КБ-sniff на WAF-сигнатуру |
| `src/controllers/chat.js` | 503/Retry-After + truncation detection |
| `src/middlewares/chat-middleware.js` | Проброс OpenAI gen-params |
| `docker/docker-compose.yml` | + сервис `chrome-headless` (network_mode: host) |
| `data/captcha-cookies.json` | Persistent store per-account cookies |

## Env-переменные форка

В дополнение к апстримным (`API_KEY`, `ACCOUNTS`, `LOG_LEVEL`, …):

| Variable | Назначение | Default |
|---|---|---|
| `COOKIE_HEADER_OVERRIDE` | Legacy: глобальный cookie (рудимент, использовался до per-account) | — |
| `SSXMOD_ITNA_OVERRIDE` | Legacy: override ssxmod_itna | — |
| `DEBUG_RAW_UPSTREAM` | Дамп raw upstream response в лог (диагностика) | `0` |
| `CAPTCHA_DAEMON_URL` | URL daemon'а для inline-trigger | `http://192.168.0.58:9099` |
| `QWEN_ADMIN_KEY` | Admin key для `/api/captcha/*` (по умолчанию = API_KEY) | `API_KEY` |
| `OLLAMA_MODEL` | Vision-модель fallback'а | `qwen2.5vl:7b` |
| `CHROME_CTR` | Имя контейнера для `docker exec` (headless) | `qwen2api-chrome-headless` |

## Background — короткая историческая справка

(Подробности — в git log; здесь только хронология решений.)

- **2026-06-08** — апстрим начал получать пустые ответы. Диагноз: Aliyun-WAF
  требует cookie `x5sec`, выставляемый только slide-капчей.
- **2026-06-09 (день)** — ручной обход: `COOKIE_HEADER_OVERRIDE` + один
  глобальный `x5sec` для всех 5 аккаунтов. Работало, но протухало раз в
  ~30 минут, ручное обновление через chromium-БД.
- **2026-06-09 (вечер)** — автоматизация: первая версия `bypass/daemon.js`,
  CDP через TCP. Споткнулись о chromium 148+ запрет на
  `Target.createBrowserContext` в non-headless.
- **2026-06-10** — финальная архитектура: отдельный `qwen2api-chrome-headless`
  контейнер, daemon спавнит chromium через `docker exec` с уникальным
  user-data-dir + proxy + port. Vision-LLM как fallback. Per-account
  cookie store. Inline-детектор в `request.js` с авто-триггером bypass.
  503/Retry-After на стороне клиента.
- **2026-06-10 (позже)** — truncation detection: при незакрытом `<think>`
  возвращаем `finish_reason: length` вместо `stop`.
