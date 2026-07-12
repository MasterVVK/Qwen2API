#!/usr/bin/env node
/**
 * Config-driven pool provisioning. bypass/pool.json is the SINGLE SOURCE OF TRUTH for the
 * browser-channel account pool. This generates docker/docker-compose.pool.yml (one chrome-solver
 * clone container per pool entry, with its proxy / CDP port / noVNC ports / profile volume derived
 * from the entry) and applies it. docker compose recreates ONLY services whose config changed —
 * so adding an account or changing its proxy reconfigures just that one container; the others (and
 * an in-flight run) are untouched.
 *
 *   add/change an account → edit bypass/pool.json → `node bypass/provision-pool.js`
 *
 * The PRIMARY container (qwen2api-chrome-solver) stays hand-managed in the base docker-compose.yml.
 * Pass --login to auto-login any freshly-created clone (token-inject via pool-login.js).
 *
 * Per-account fields read from pool.json: ctr, cdpPort, proxy ("direct" or http://ip:port), email.
 * Derived: profile dir chrome-solver-config-<suffix>, noVNC host ports, container service name.
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const PRIMARY = 'qwen2api-chrome-solver'
const pool = JSON.parse(fs.readFileSync(path.join(__dirname, 'pool.json'), 'utf8'))
const clones = pool.filter(a => a.ctr && a.ctr !== PRIMARY)
const suffixOf = ctr => ctr.replace(/^qwen2api-chrome-solver-?/, '') || ctr

// proxy is sourced from data/data.json (the account's proxy, editable via the dashboard) keyed by
// email — single source of truth. Falls back to the pool.json entry's proxy if the account has none.
let dataProxy = {}
try {
    for (const ac of (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'data.json'), 'utf8')).accounts || []))
        if (ac.email && ac.proxy) dataProxy[ac.email] = ac.proxy
} catch (e) { console.log('warn: could not read data/data.json proxies:', e.message) }
const proxyFor = a => (a.email && dataProxy[a.email]) || a.proxy

function service(a) {
    const suffix = suffixOf(a.ctr)
    const cfg = `chrome-solver-config-${suffix}`
    const idx = Number(a.cdpPort) - 9564                       // 0-based clone index (9564 = first clone)
    const nv1 = 3014 + idx * 2, nv2 = nv1 + 1                  // derived noVNC host ports
    const proxy = proxyFor(a)
    const proxyFlag = (proxy && proxy !== 'direct') ? ` --proxy-server=${proxy}` : ''
    return `  chrome-solver-${suffix}:
    container_name: ${a.ctr}
    image: lscr.io/linuxserver/chromium:latest
    runtime: nvidia
    security_opt:
      - seccomp:unconfined
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Moscow
      - SELKIES_ENCODER=jpeg
      - MAX_RES=1920x1080
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=all
      - CHROME_CLI=/config/.config/chromium --start-maximized --remote-debugging-port=9561${proxyFlag} about:blank
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "44"
      - "109"
    volumes:
      - ./${cfg}:/config
    ports:
      - "127.0.0.1:${a.cdpPort}:${a.cdpPort}"   # CDP bridge (socat) — ${a.email || a.name} / ${proxy || 'direct'}
      - "192.168.0.58:${nv1}:3000"   # noVNC http
      - "192.168.0.58:${nv2}:3001"   # noVNC https
    shm_size: "1gb"
    restart: unless-stopped`
}

// 1) generate the pool compose file
const yaml = `# AUTO-GENERATED from bypass/pool.json by provision-pool.js — DO NOT EDIT BY HAND.\n# Edit pool.json then re-run: node bypass/provision-pool.js\nservices:\n${clones.map(service).join('\n\n')}\n`
const outPath = path.join(ROOT, 'docker', 'docker-compose.pool.yml')
fs.writeFileSync(outPath, yaml)
console.log(`generated docker/docker-compose.pool.yml — ${clones.length} clones: ${clones.map(a => `${suffixOf(a.ctr)}(${proxyFor(a) || 'direct'})`).join(', ')}`)

// 2) ensure profile dirs exist (owned by the container's PUID/PGID 1000)
const fresh = []
for (const a of clones) {
    const dir = path.join(ROOT, `chrome-solver-config-${suffixOf(a.ctr)}`)
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); try { execFileSync('chown', ['1000:1000', dir]) } catch (e) {} fresh.push(a); console.log(`created profile dir ${dir}`) }
}

// 3) apply — compose recreates ONLY services whose definition changed
const composeArgs = ['compose', '-p', 'qwen2api', '--project-directory', ROOT, '-f', 'docker/docker-compose.yml', '-f', 'docker/docker-compose.pool.yml', 'up', '-d']
console.log('$ docker', composeArgs.join(' '))
execFileSync('docker', composeArgs, { cwd: ROOT, stdio: 'inherit' })

// 4) optional: auto-login freshly-created clones
if (process.argv.includes('--login')) {
    for (const a of fresh.length ? fresh : clones) {
        console.log(`\n--- login ${a.email} @ ${a.ctr} ---`)
        try { execFileSync('node', [path.join(__dirname, 'pool-login.js'), a.ctr, String(a.cdpPort), a.email], { stdio: 'inherit' }) } catch (e) {}
    }
}
console.log('\ndone. (channel picks up pool.json on its next restart; clone containers are now in sync)')
