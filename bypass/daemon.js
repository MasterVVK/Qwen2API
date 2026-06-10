#!/usr/bin/env node
/**
 * Captcha bypass daemon for Qwen2API — per-account via spawned headless chromium.
 *
 * Architecture:
 *   - chrome-headless container provides chromium binary (long-running shell)
 *   - For each bypass: docker exec spawns a fresh headless chromium process with
 *     its own --user-data-dir, --proxy-server, --remote-debugging-port
 *   - Daemon connects to that port via CDP, drives the captcha flow, kills the process.
 *   - Each bypass = isolated browser → proper proxy per account, no shared state.
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const CDP = require('chrome-remote-interface')

const PORT = 9099
const CHROME_CTR = process.env.CHROME_CTR || 'qwen2api-chrome-headless'
const PID_FILE = '/tmp/qwen2api-bypass-daemon.pid'

const QWEN_API = process.env.QWEN_API_URL || 'http://127.0.0.1:3001'
const QWEN_KEY = process.env.QWEN_ADMIN_KEY || 'sk-123456'

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://192.168.0.60:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5vl:7b'

const NAV_TIMEOUT_MS = 20000
const DRAG_FORCE_RIGHT_PX = 500
const POST_DRAG_WAIT_MS = 3500
const COOKIES_POLL_RETRIES = 8
const COOKIES_POLL_INTERVAL_MS = 2000
const PORT_RANGE_START = 9300
const PORT_RANGE_END = 9499

// state
const inflight = new Map()             // email → Promise
const history = new Map()              // email → [{ts, ok, ms, x5sec_prefix?, error?, step?}]
const allocatedPorts = new Set()

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function pushHistory(email, rec) {
    const key = email || '*'
    const list = history.get(key) || []
    list.unshift({ ts: Date.now(), ...rec })
    if (list.length > 50) list.length = 50
    history.set(key, list)
}

function httpRequest(url, opts = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url)
        const lib = u.protocol === 'https:' ? require('https') : require('http')
        const req = lib.request({
            method: opts.method || 'GET',
            hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            headers: opts.headers || {},
            timeout: opts.timeout || 60000,
        }, res => {
            const chunks = []
            res.on('data', c => chunks.push(c))
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
        })
        req.on('error', reject)
        req.on('timeout', () => req.destroy(new Error('timeout')))
        if (opts.body) req.write(opts.body)
        req.end()
    })
}

function allocatePort() {
    for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
        if (!allocatedPorts.has(p)) {
            allocatedPorts.add(p)
            return p
        }
    }
    throw new Error('no free debug ports')
}

function sanitizeEmail(email) {
    return email.replace(/[^a-z0-9]/gi, '_')
}

async function waitForCDP(port, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            const r = await httpRequest(`http://127.0.0.1:${port}/json/version`, { timeout: 1000 })
            if (r.status === 200) return JSON.parse(r.body.toString())
        } catch (e) { /* not ready */ }
        await sleep(300)
    }
    throw new Error(`CDP did not come up on :${port} within ${timeoutMs}ms`)
}

// ───────── pipeline pieces ─────────

async function triggerCaptchaForAccount(email) {
    const res = await httpRequest(
        `${QWEN_API}/api/captcha/_trigger?email=${encodeURIComponent(email)}`,
        {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${QWEN_KEY}`, 'Content-Type': 'application/json' },
            body: '{}',
            timeout: 25000,
        }
    )
    if (res.status !== 200) throw new Error(`_trigger HTTP ${res.status}: ${res.body.toString().slice(0, 200)}`)
    const j = JSON.parse(res.body.toString())
    if (!j.captcha) throw new Error('no-captcha (upstream healthy — refresh not needed)')
    return j.url
}

async function getAccountInfo(email) {
    const res = await httpRequest(`${QWEN_API}/api/getAllAccounts`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${QWEN_KEY}` },
        timeout: 10000,
    })
    if (res.status !== 200) throw new Error(`getAllAccounts HTTP ${res.status}`)
    const data = JSON.parse(res.body.toString())
    const list = Array.isArray(data) ? data : (data.data || data.accounts || [])
    const acc = list.find(a => a.email === email)
    if (!acc) throw new Error(`account ${email} not found`)
    return { token: acc.token, proxy: acc.proxy || null }
}

async function visionStart(pngBase64) {
    const prompt = `На скриншоте есть горизонтальная серая закруглённая полоса с круглой иконкой ">>" в её левой части. Дай ТОЧНЫЕ пиксельные координаты центра иконки ">>". Ответ СТРОГО в JSON: {"start_x": N, "start_y": N}`
    const res = await httpRequest(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: OLLAMA_MODEL, prompt, images: [pngBase64], stream: false,
            options: { temperature: 0 },
        }),
        timeout: 90000,
    })
    if (res.status !== 200) throw new Error(`ollama HTTP ${res.status}`)
    const j = JSON.parse(res.body.toString())
    const m = j.response.match(/\{[^}]+\}/)
    if (!m) throw new Error(`vision JSON not found: ${j.response.slice(0, 200)}`)
    const coords = JSON.parse(m[0])
    if (!Number.isFinite(coords.start_x) || !Number.isFinite(coords.start_y))
        throw new Error(`bad coords: ${m[0]}`)
    return coords
}

async function dragViaCDP(Input, startX, startY, endX, endY) {
    const steps = 40
    const dx = endX - startX
    const dy = endY - startY
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: startX, y: startY })
    await sleep(150)
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(80)
    for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const p = (1 - Math.cos(Math.PI * t)) / 2
        const x = Math.round(startX + dx * p)
        const y = Math.round(startY + dy * p + (Math.random() * 3 - 1.5))
        await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
        const baseDelay = 15 + 25 * (1 - Math.abs(2 * t - 1))
        await sleep(Math.round(baseDelay + (Math.random() * 10 - 5)))
    }
    await sleep(80)
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: endX, y: endY, button: 'left', buttons: 0, clickCount: 1 })
}

async function applyCookies(email, cookies) {
    const out = {}
    for (const c of cookies) {
        if (c.name === 'token') continue   // JWT goes via Authorization header
        out[c.name] = c.value
    }
    const cookieHeader = Object.entries(out).map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await httpRequest(`${QWEN_API}/api/captcha/_apply?email=${encodeURIComponent(email)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${QWEN_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookieHeader }),
        timeout: 10000,
    })
    if (res.status !== 200) throw new Error(`apply HTTP ${res.status}: ${res.body.toString().slice(0, 200)}`)
    return out['x5sec'] ? out['x5sec'].slice(0, 30) : null
}

// ───────── spawn chromium per bypass ─────────

function spawnChromium({ port, proxy, userDataDir }) {
    const args = [
        'exec', '-d', CHROME_CTR,
        '/usr/bin/chromium-browser',
        '--headless=new',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // Stealth flags — reduce automation fingerprint visible to Aliyun
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--no-default-browser-check',
        '--no-first-run',
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${port}`,
        '--window-size=1920,952',  // match the slider geometry we know works
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    ]
    if (proxy) args.push(`--proxy-server=${proxy}`)
    args.push('about:blank')
    execFileSync('docker', args, { stdio: 'pipe' })
}

function killChromium(userDataDir) {
    // pkill any chromium that uses this user-data-dir (idempotent)
    try {
        execFileSync('docker', [
            'exec', CHROME_CTR,
            'sh', '-c', `pkill -f 'user-data-dir=${userDataDir}' 2>/dev/null; rm -rf "${userDataDir}"`,
        ], { stdio: 'pipe' })
    } catch (e) { /* best-effort */ }
}

// ───────── orchestration per-account ─────────

async function runBypassForAccount(email, providedCaptchaUrl) {
    const t0 = Date.now()
    let step = 'init'
    let port = null
    let userDataDir = null
    let client = null

    try {
        step = 'account-info'
        const { token, proxy } = await getAccountInfo(email)
        if (!token) throw new Error('account has no JWT token')

        let captchaUrl
        if (providedCaptchaUrl) {
            step = 'use-provided-url'
            captchaUrl = providedCaptchaUrl
        } else {
            step = 'trigger'
            captchaUrl = await triggerCaptchaForAccount(email)
        }

        step = 'spawn-chromium'
        port = allocatePort()
        userDataDir = `/tmp/profile-${sanitizeEmail(email)}-${Date.now()}`
        spawnChromium({ port, proxy, userDataDir })

        step = 'wait-cdp'
        await waitForCDP(port, 15000)

        step = 'cdp-connect'
        client = await CDP({ host: '127.0.0.1', port })
        const { Network, Page, Input } = client
        await Network.enable()
        await Page.enable()

        step = 'cookie-inject'
        await Network.setCookie({
            domain: 'chat.qwen.ai', name: 'token', value: token,
            path: '/', secure: true, httpOnly: false, sameSite: 'Lax',
            expires: Math.floor(Date.now() / 1000) + 86400 * 30,
        })

        step = 'navigate'
        const loadPromise = Page.loadEventFired()
        await Page.navigate({ url: captchaUrl })
        await Promise.race([loadPromise, sleep(NAV_TIMEOUT_MS)])

        step = 'wait-slider-ready'
        // Poll DOM until the "Loading..." state goes away (Aliyun JS challenge finished).
        // For accounts without proxy (host IP), the challenge can take 20-30s.
        const sliderReadyDeadline = Date.now() + 35000
        let slidersReady = false
        let lastDomState = null
        while (Date.now() < sliderReadyDeadline) {
            try {
                const r = await client.Runtime.evaluate({
                    expression: `(() => {
                        const t = (document.body && document.body.innerText) || '';
                        return { hasLoading: t.includes('Loading'), hasSlide: t.includes('slide to verify'), len: t.length };
                    })()`,
                    returnByValue: true,
                })
                lastDomState = r.result.value || {}
                if (lastDomState.hasSlide && !lastDomState.hasLoading) { slidersReady = true; break }
            } catch (e) { /* navigating */ }
            await sleep(500)
        }
        console.log(`  wait-slider-ready: ready=${slidersReady} state=${JSON.stringify(lastDomState)}`)
        if (!slidersReady) {
            throw new Error(`captcha slider did not render in 35s — Aliyun JS challenge stuck (state=${JSON.stringify(lastDomState)})`)
        }

        // Strategy: try fast hardcoded coords first (works for our fixed 1920×952 viewport),
        // fall back to vision-LLM only if drag didn't produce x5sec. This avoids the
        // slow Ollama call on most attempts and reduces load.
        const HARDCODED_COORDS = { start_x: 833, start_y: 535, source: 'hardcoded' }

        // helper: do drag with given coords, poll for x5sec for up to N seconds
        async function dragAndCheckCookies(coords, pollSecs) {
            await dragViaCDP(Input, coords.start_x, coords.start_y,
                coords.start_x + DRAG_FORCE_RIGHT_PX, coords.start_y)
            await sleep(POST_DRAG_WAIT_MS)
            const pollAttempts = Math.ceil(pollSecs * 1000 / COOKIES_POLL_INTERVAL_MS)
            for (let a = 1; a <= pollAttempts; a++) {
                const { cookies: all } = await Network.getAllCookies()
                const qwenCookies = all.filter(c =>
                    c.domain === 'chat.qwen.ai' || c.domain === '.qwen.ai' || c.domain.endsWith('.qwen.ai')
                )
                if (qwenCookies.some(x => x.name === 'x5sec')) {
                    return qwenCookies
                }
                if (a < pollAttempts) await sleep(COOKIES_POLL_INTERVAL_MS)
            }
            return null
        }

        // helper: save screenshot for debug
        async function snapshotFor(tag) {
            try {
                const { data: png } = await Page.captureScreenshot({ format: 'png' })
                const dbgPath = `/tmp/bypass-${tag}-${sanitizeEmail(email)}-${Date.now()}.png`
                fs.writeFileSync(dbgPath, Buffer.from(png, 'base64'))
                return png
            } catch (e) { return null }
        }

        // ─── attempt 1: hardcoded coords ───
        step = 'drag-hardcoded'
        await snapshotFor('shot')                     // before drag
        console.log(`  trying hardcoded coords (${HARDCODED_COORDS.start_x}, ${HARDCODED_COORDS.start_y})`)
        let cookies = await dragAndCheckCookies(HARDCODED_COORDS, 6)  // 6s wait
        if (cookies) console.log(`  hardcoded coords worked ✓`)

        // ─── attempt 2: vision fallback ───
        if (!cookies) {
            console.log(`  hardcoded failed, falling back to vision`)
            step = 'reload-for-vision'
            // reload page to reset captcha state for a clean second attempt
            const loadPromise2 = Page.loadEventFired()
            await Page.navigate({ url: captchaUrl })
            await Promise.race([loadPromise2, sleep(NAV_TIMEOUT_MS)])
            // brief wait for slider to render again
            const deadline2 = Date.now() + 30000
            while (Date.now() < deadline2) {
                try {
                    const r = await client.Runtime.evaluate({
                        expression: `(() => { const t=(document.body&&document.body.innerText)||''; return { hasLoading: t.includes('Loading'), hasSlide: t.includes('slide to verify') }; })()`,
                        returnByValue: true,
                    })
                    const s = r.result.value || {}
                    if (s.hasSlide && !s.hasLoading) break
                } catch (e) {}
                await sleep(500)
            }

            step = 'vision'
            const png = await snapshotFor('shot-v')
            if (!png) throw new Error('failed to capture screenshot for vision')
            const coords = await visionStart(png)
            console.log(`  vision: (${coords.start_x}, ${coords.start_y})`)
            // sanity-check
            if (coords.start_x < 200 || coords.start_x > 1500 || coords.start_y < 400 || coords.start_y > 650) {
                throw new Error(`vision returned out-of-bounds coords (${coords.start_x}, ${coords.start_y})`)
            }

            step = 'drag-vision'
            cookies = await dragAndCheckCookies(coords, 16)  // 16s wait — full poll
            if (cookies) console.log(`  vision coords worked ✓`)
        }

        await snapshotFor('post')                    // after drag (debug)

        if (!cookies) {
            throw new Error(`extract: x5sec did not land after hardcoded + vision attempts`)
        }

        step = 'apply'
        const x5prefix = await applyCookies(email, cookies)

        const ms = Date.now() - t0
        pushHistory(email, { ok: true, ms, x5sec_prefix: x5prefix })
        console.log(`[${new Date().toISOString()}] bypass ok in ${ms}ms for ${email} (x5sec ${x5prefix}...)`)
        return { ok: true, ms, x5sec_prefix: x5prefix, email }
    } catch (e) {
        const ms = Date.now() - t0
        pushHistory(email, { ok: false, ms, error: e.message, step })
        console.error(`[${new Date().toISOString()}] bypass FAIL at step=${step} after ${ms}ms for ${email}: ${e.message}`)
        return { ok: false, ms, error: e.message, step, email }
    } finally {
        try { if (client) await client.close() } catch (e) {}
        if (userDataDir) killChromium(userDataDir)
        if (port) allocatedPorts.delete(port)
    }
}

function runBypassDeduped(email, captchaUrl) {
    const key = email || '*'
    if (inflight.has(key)) return inflight.get(key)
    const p = runBypassForAccount(email, captchaUrl).finally(() => { inflight.delete(key) })
    inflight.set(key, p)
    return p
}

// ───────── HTTP server ─────────

const server = http.createServer(async (req, res) => {
    const send = (status, json) => {
        const body = JSON.stringify(json)
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
        res.end(body)
    }
    try {
        const url = new URL(req.url, 'http://x')

        if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true })

        if (req.method === 'GET' && url.pathname === '/status') {
            const accounts = {}
            for (const [em, list] of history.entries()) {
                accounts[em] = { history: list.slice(0, 20), inflight: inflight.has(em) }
            }
            return send(200, { accounts, inflightCount: inflight.size })
        }

        if (req.method === 'POST' && url.pathname === '/refresh') {
            const email = (url.searchParams.get('email') || '').trim()
            if (!email) return send(400, { ok: false, error: 'email query param required' })

            let captchaUrl = null
            if (req.headers['content-length'] && parseInt(req.headers['content-length'], 10) > 0) {
                try {
                    const chunks = []
                    for await (const c of req) chunks.push(c)
                    if (chunks.length) {
                        const body = JSON.parse(Buffer.concat(chunks).toString())
                        if (body && typeof body.captchaUrl === 'string') captchaUrl = body.captchaUrl
                    }
                } catch (e) { /* ignore */ }
            }

            const wasRunning = inflight.has(email)
            const result = await runBypassDeduped(email, captchaUrl)
            return send(result.ok ? 200 : 500, { ...result, wasAlreadyRunning: wasRunning })
        }

        send(404, { error: 'not found' })
    } catch (e) {
        send(500, { error: e.message })
    }
})

// Self-supervision: ensure no previous daemon is squatting on the port.
function checkAndCleanupOldPid() {
    try {
        const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
        if (oldPid && oldPid !== process.pid) {
            try {
                process.kill(oldPid, 0)  // probe — throws ESRCH if dead
                console.log(`[${new Date().toISOString()}] terminating previous daemon pid=${oldPid}`)
                process.kill(oldPid, 'SIGTERM')
                // wait briefly for it to release the port
                const deadline = Date.now() + 3000
                while (Date.now() < deadline) {
                    try { process.kill(oldPid, 0) } catch (e) { break }
                    require('child_process').execSync('sleep 0.1')
                }
            } catch (e) { /* already dead */ }
        }
    } catch (e) { /* no pid file */ }
    try { fs.writeFileSync(PID_FILE, String(process.pid)) } catch (e) {}
}

checkAndCleanupOldPid()

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[${new Date().toISOString()}] bypass daemon (spawned-chromium edition) listening on :${PORT}`)
    console.log(`[${new Date().toISOString()}] pid=${process.pid} → ${PID_FILE}`)
    console.log(`[${new Date().toISOString()}] Chromium container: ${CHROME_CTR}`)
    console.log(`[${new Date().toISOString()}] Qwen2API: ${QWEN_API}`)
})

process.on('SIGTERM', () => {
    try { fs.unlinkSync(PID_FILE) } catch (e) {}
    process.exit(0)
})
process.on('SIGINT', () => {
    try { fs.unlinkSync(PID_FILE) } catch (e) {}
    process.exit(0)
})
