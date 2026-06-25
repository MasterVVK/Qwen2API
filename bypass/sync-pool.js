#!/usr/bin/env node
/**
 * Auto-sync the browser-channel pool with the qwen2api dashboard accounts.
 *
 * The dashboard (:3001) writes accounts to data/data.json. The browser-channel pool is driven by
 * bypass/pool.json (one chrome-solver clone per entry). This bridges the two: every dashboard
 * account NOT yet in pool.json gets a container + CDP port allocated, appended to pool.json,
 * provisioned (container created & token-login via provision-pool.js --login), then the running
 * channel is hot-reloaded (SIGHUP) so the new account joins rotation WITHOUT a restart — an
 * in-flight edit request is never dropped.
 *
 * Idempotent & cheap: if no dashboard account is missing from the pool it exits immediately, so it
 * is safe to fire on every data.json change (token refreshes rewrite the file frequently).
 *
 * Only ADDS accounts. Removing a dashboard account does NOT tear down its clone (avoids killing a
 * busy container); that stays a manual op. Trigger: systemd path unit on data/data.json.
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const POOL_PATH = path.join(__dirname, 'pool.json')
const DATA_PATH = path.join(ROOT, 'data', 'data.json')
const PRIMARY = 'qwen2api-chrome-solver'
const log = (...a) => console.log(new Date().toISOString(), '[sync-pool]', ...a)

const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'))
const accounts = (JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')).accounts) || []

const haveEmail = new Set(pool.map(a => (a.email || '').toLowerCase()).filter(Boolean))
const usedNames = new Set(pool.map(a => a.name))
let maxPort = pool.reduce((m, a) => Math.max(m, Number(a.cdpPort) || 0), 9563)
const localpart = e => (e.split('@')[0] || e).replace(/[^a-z0-9]+/gi, '').toLowerCase() || 'acc'

const fresh = []
for (const ac of accounts) {
    const email = (ac.email || '').toLowerCase()
    if (!email || haveEmail.has(email)) continue
    const cdpPort = ++maxPort                 // next free CDP port (9568, 9569, …)
    const ctr = `${PRIMARY}-${cdpPort - 9562}` // suffix matches existing scheme: 9564→2 … 9567→5
    let name = localpart(email), n = name, i = 2
    while (usedNames.has(n)) n = `${name}-${i++}`
    usedNames.add(n)
    const entry = { name: n, ctr, cdpPort, proxy: ac.proxy || 'direct', email: ac.email }
    pool.push(entry); fresh.push(entry)
    log(`+ ${ac.email} → ${ctr} cdp ${cdpPort} proxy ${entry.proxy}`)
}

if (!fresh.length) { log('no new accounts — pool in sync'); process.exit(0) }

// 1) persist pool.json atomically (provision-pool.js reads it as its source of truth)
fs.writeFileSync(POOL_PATH + '.tmp', JSON.stringify(pool, null, 4) + '\n')
fs.renameSync(POOL_PATH + '.tmp', POOL_PATH)
log(`pool.json updated → ${pool.length} accounts (+${fresh.length})`)

// 2) create the clone container(s) + token-inject login
try {
    execFileSync('node', [path.join(__dirname, 'provision-pool.js'), '--login'], { cwd: ROOT, stdio: 'inherit' })
} catch (e) { log('provision-pool failed:', e.message); process.exit(1) }

// 3) hot-reload the running channel (no restart → no dropped in-flight edit)
try {
    execFileSync('sudo', ['-n', 'systemctl', 'kill', '-s', 'HUP', 'qwen2api-browser-channel.service'], { stdio: 'inherit' })
    log('SIGHUP → browser-channel; new account(s) now in rotation')
} catch (e) { log('SIGHUP failed (channel picks up pool.json on next restart):', e.message) }
log('done.')
