# Auto-sync browser-channel pool from dashboard accounts

When an account is added via the qwen2api dashboard (`:3001`) it lands in `data/data.json`. These
units make the **browser-channel pool** (`:9100`, driven by `bypass/pool.json`) follow automatically —
no manual `provision-pool.js` / restart.

Flow: dashboard → `data/data.json` changes → **`qwen2api-pool-sync.path`** fires →
**`qwen2api-pool-sync.service`** runs `bypass/sync-pool.js` → for each new account it allocates a
container + CDP port, appends `pool.json`, runs `provision-pool.js --login` (creates the chrome-solver
clone and token-logs it in), then sends **SIGHUP** to `qwen2api-browser-channel` which hot-reloads the
new account into rotation **without a restart** (no dropped in-flight edit request).

## Install

```sh
sudo cp qwen2api-pool-sync.path qwen2api-pool-sync.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qwen2api-pool-sync.path
```

Requires: the `user` account can run `docker` and has passwordless `sudo systemctl kill` (for the SIGHUP).

## Notes

- Idempotent: if no dashboard account is missing from the pool, `sync-pool.js` exits immediately, so
  it is safe that token refreshes rewrite `data.json` frequently.
- Only **adds** accounts. Removing a dashboard account does not tear down its clone (avoids killing a
  busy container) — that stays manual.
- Login sets the account JWT in **both** `localStorage.token` and a `token` cookie on `.qwen.ai`
  (the cookie became required after 2026-06-13; without it the SPA renders logged-out). See
  `pool-login.js`.
