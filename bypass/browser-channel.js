#!/usr/bin/env node
/**
 * Browser channel (CONCURRENT) — runs qwen prompts by DRIVING THE CHAT UI like a human inside a
 * pool of logged-in chrome-solver containers. Same WAF-safe approach as the serial version (only
 * xdotool real input + bare Runtime.evaluate reads; NO navigate/Runtime.enable/CDP Input/fetch).
 *
 * Difference from the serial channel: each account is driven by its OWN driver context (its own
 * CDP client, screen offset, container, display), so up to POOL.length requests run AT THE SAME
 * TIME on different accounts. An incoming request acquires a free, non-cooling account; if all are
 * busy it waits; account-level failures (quota/stuck) cool that account and fail over to another.
 *
 * HTTP: POST /complete {model, content, stream?}  → SSE (OpenAI-ish) or JSON {content}
 *       POST /image    {prompt, ratio?}           → {url, width, height}
 *       GET  /health
 * Env: SOLVER_CTR (default qwen2api-chrome-solver), BROWSER_CHANNEL_PORT (default 9100)
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const CDP = require('chrome-remote-interface')
const captcha = require('./captcha-solve')

const DEFAULT_CTR = process.env.SOLVER_CTR || 'qwen2api-chrome-solver'
const LISTEN = Number(process.env.BROWSER_CHANNEL_PORT || 9100)
const RESP_TIMEOUT_MS = Number(process.env.BC_RESP_TIMEOUT_MS || 50 * 60 * 1000) // qwen3.7-max thinks 10-15 min
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString(), '[bc]', ...a)

// ── account pool ──
function mkAccount(o) {
    return {
        name: o.name || o.ctr, ctr: o.ctr, cdpPort: Number(o.cdpPort) || 9563,
        dbg: Number(o.dbg) || 9561, disp: o.disp || ':1', proxy: o.proxy || null, email: o.email || null,
        client: null, off: null, coolUntil: 0, coolReason: null, lastUsed: 0, busy: false, driver: null,
        ok: 0, fail: 0, lastError: null,   // status counters (surfaced in /health)
    }
}
function loadPool() {
    try {
        const arr = JSON.parse(fs.readFileSync(path.join(__dirname, 'pool.json'), 'utf8'))
        if (Array.isArray(arr) && arr.length) return arr.map(mkAccount)
    } catch (e) { /* no pool.json → single-account fallback */ }
    return [mkAccount({ name: 'solver', ctr: DEFAULT_CTR, cdpPort: 9563 })]
}
const POOL = loadPool()
function coolAccount(a, ms, why) { a.coolUntil = Date.now() + ms; a.coolReason = why; log(`account ${a.name} cooling ${Math.round(ms / 60000)}min (${why})`) }

// Force the container's virtual display to 1920×1080 — matching the proven solver-1 (whose
// display got sized to 1920 when its noVNC was opened). Fresh clones default to 1024×768 (no
// noVNC client), and the captcha/UI-drive was tuned on 1920. Idempotent: skips if already 1920
// wide (never disturbs solver-1's 1920xNNN). One docker exec; re-maximizes chromium too.
function ensureResolution(ctr, disp) {
    try {
        const cur = execFileSync('docker', ['exec', '-e', `DISPLAY=${disp}`, ctr, 'sh', '-c', 'xrandr 2>/dev/null | sed -n "s/.*current \\([0-9]*\\) x.*/\\1/p"'], { stdio: 'pipe' }).toString().trim()
        if (cur === '1920') return
        execFileSync('docker', ['exec', '-e', `DISPLAY=${disp}`, ctr, 'sh', '-c', 'xrandr --newmode "1920x1080_60" 173.00 1920 2048 2248 2576 1080 1083 1088 1120 -hsync +vsync 2>/dev/null; xrandr --addmode screen 1920x1080_60 2>/dev/null; xrandr --output screen --mode 1920x1080_60 2>/dev/null; W=$(xdotool search --onlyvisible --class chromium | head -1); [ -n "$W" ] && { xdotool windowsize "$W" 1920 1080; xdotool windowmove "$W" 0 0; }'], { stdio: 'pipe', timeout: 15000 })
    } catch (e) {}
}

// socat CDP bridge inside a container (kept top-level so the watchdog can touch every container)
function ensureSocat(ctr, cdpPort, dbg) {
    try { execFileSync('docker', ['exec', '-u', 'root', ctr, 'sh', '-c', `which socat >/dev/null 2>&1 || (apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq socat xclip xdotool >/dev/null 2>&1)`], { stdio: 'pipe', timeout: 90000 }) } catch (e) {}
    try { execFileSync('docker', ['exec', ctr, 'sh', '-c', `pgrep -f 'TCP-LISTEN:${cdpPort}' >/dev/null || setsid nohup socat TCP-LISTEN:${cdpPort},fork,reuseaddr TCP:127.0.0.1:${dbg} >/dev/null 2>&1 < /dev/null & sleep 1`], { stdio: 'pipe' }) } catch (e) {}
}

// ── per-account driver: ALL UI-driving scoped to one account/container, so drivers run concurrently ──
function createDriver(a) {
    const dlog = (...m) => log(`[${a.name}]`, ...m)
    const xdo = cmd => { try { return execFileSync('docker', ['exec', '-e', `DISPLAY=${a.disp}`, a.ctr, 'sh', '-c', cmd], { stdio: 'pipe' }).toString() } catch (e) { return '' } }
    const setClip = text => { try { execFileSync('docker', ['exec', '-i', '-e', `DISPLAY=${a.disp}`, a.ctr, 'sh', '-c', 'xclip -selection clipboard'], { input: text, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (e) {} }

    async function getClient() {
        if (a.client) { try { await a.client.Runtime.evaluate({ expression: '1' }); return a.client } catch (e) { try { await a.client.close() } catch (_) {} a.client = null; a.off = null } }
        ensureSocat(a.ctr, a.cdpPort, a.dbg)
        for (let i = 0; i < 50 && !a.client; i++) { try { a.client = await CDP({ host: '127.0.0.1', port: a.cdpPort }) } catch (e) { await sleep(300) } }
        if (!a.client) throw new Error('CDP connect failed')
        dlog('CDP connected (read-only)')
        return a.client
    }
    // CDP evals are wrapped in a 30s timeout: a hung Runtime.evaluate (dead socat/CDP) must NOT
    // freeze readResponse forever (that defeats RESP_TIMEOUT). On timeout we throw eval_timeout,
    // which withAccount treats as an account-level failure → cool + failover.
    const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('eval_timeout') })])
    const ev = expr => withTimeout(a.client.Runtime.evaluate({ returnByValue: true, expression: expr }).then(r => r.result.value), 30000)
    const evA = expr => withTimeout(a.client.Runtime.evaluate({ returnByValue: true, awaitPromise: true, expression: expr }).then(r => r.result.value), 30000)

    async function activateAndOffset() {
        ensureResolution(a.ctr, a.disp); await sleep(200)   // match proven solver-1 (1920) before calibrating offset
        const loc = xdo(`xdotool mousemove 500 400; xdotool getmouselocation --shell 2>/dev/null`)
        const wm = loc.match(/WINDOW=(\d+)/)
        if (wm) xdo(`xdotool windowactivate ${wm[1]} 2>/dev/null; xdotool windowfocus ${wm[1]} 2>/dev/null; true`)
        await sleep(300)
        await ev(`window.__le=null;document.onmousemove=e=>{window.__le=[Math.round(e.clientX),Math.round(e.clientY)]}`)
        for (const py of [400, 350, 300]) {
            xdo(`xdotool mousemove 501 ${py}`); await sleep(180)
            const p = await ev(`window.__le`)
            if (p) { a.off = { x: 501 - p[0], y: py - p[1] }; return a.off }
        }
        a.off = { x: 0, y: 87 }; return a.off
    }
    const clickScreen = async (x, y) => { xdo(`xdotool mousemove ${Math.round(x)} ${Math.round(y)}; xdotool click 1`); await sleep(400) }
    async function clickCss(sel) {
        const r = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];})()`)
        if (!r) return false
        await clickScreen(r[0] + a.off.x, r[1] + a.off.y); return true
    }
    async function clickByText(text, opts = {}) {
        const r = await ev(`(()=>{const e=[...document.querySelectorAll("*")].filter(x=>x.children.length===0&&x.textContent.trim()===${JSON.stringify(text)}&&x.getBoundingClientRect().width>0)[0];if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];})()`)
        if (!r) return false
        await clickScreen(r[0] + a.off.x, r[1] + a.off.y); return true
    }

    async function ensureNoCaptcha() {
        if (!(await captcha.isCaptcha(a.client))) return true
        dlog('WAF captcha appeared — auto-solving (retries)...')
        const ok = await captcha.solve(a.client, { maxTries: 25, offset: a.off, ctr: a.ctr, disp: a.disp, log: m => dlog('  captcha:', m) })
        dlog(ok ? 'captcha cleared' : 'captcha NOT cleared after retries')
        return ok
    }
    const isTemp = () => ev(`/temporary-chat=true/.test(location.href)`)
    const pageError = () => ev(`(()=>{const u=location.href||'';const b=(document.body&&document.body.innerText)||'';return /^chrome-error|^about:neterror/i.test(u)||/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|This site can.t be reached|can.t be reached/i.test(b);})()`)
    async function temporaryChat() {
        for (let attempt = 0; attempt < 6; attempt++) {
            xdo(`xdotool windowactivate $(xdotool getmouselocation --shell 2>/dev/null | sed -n 's/WINDOW=//p') 2>/dev/null; true`)
            xdo('xdotool key ctrl+l'); await sleep(700)
            xdo('xdotool type --clearmodifiers --delay 20 "https://chat.qwen.ai/?temporary-chat=true"'); await sleep(500)
            xdo('xdotool key Return')
            for (let i = 0; i < 14; i++) { await sleep(900); if (await isTemp().catch(() => false)) break }
            if (await pageError().catch(() => false)) {
                dlog(`upstream unreachable (proxy/internet down) — attempt ${attempt + 1}, waiting for connection`)
                await sleep(8000); continue
            }
            if (await isTemp().catch(() => false)) {
                for (let i = 0; i < 20; i++) { if (await ev(`!!document.querySelector("textarea")`).catch(() => false)) break; await sleep(500) }
                dlog('temporary chat: on'); return true
            }
            dlog(`temporary chat attempt ${attempt + 1} → off, retrying`)
        }
        if (await pageError().catch(() => false)) { dlog('upstream unreachable — proxy/internet down, bailing'); throw new Error('upstream_unreachable') }
        dlog('temporary chat: off (could not enter — translation may be unreliable)')
        return false
    }
    const MODEL_LABEL = { 'qwen3.7-max': 'Qwen3.7-Max', 'qwen3.7-max-thinking': 'Qwen3.7-Max', 'qwen3.7-plus': 'Qwen3.7-Plus', 'qwen3.6-plus': 'Qwen3.6-Plus', 'qwen3-max': 'Qwen3.7-Max' }
    const curModel = () => ev(`(()=>{const e=[...document.querySelectorAll("*")].find(x=>x.children.length<5&&/Qwen3\\.[67]-(Max|Plus)/.test(x.textContent)&&x.textContent.replace(/\\s/g,"").length<20&&x.getBoundingClientRect().y<120&&x.getBoundingClientRect().x<700);return e?e.textContent.trim():"";})()`)
    async function selectModel(model) {
        const label = MODEL_LABEL[(model || '').toLowerCase()] || 'Qwen3.7-Max'
        for (let attempt = 0; attempt < 4; attempt++) {
            if (await curModel() === label) { if (attempt) dlog('model =>', label); return true }
            const sel = await ev(`(()=>{const e=[...document.querySelectorAll("*")].filter(x=>x.children.length<5&&/Qwen3\\.[67]-(Max|Plus)/.test(x.textContent)&&x.textContent.replace(/\\s/g,"").length<20&&x.getBoundingClientRect().y<120&&x.getBoundingClientRect().x<700&&x.getBoundingClientRect().width<200)[0];if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];})()`)
            if (sel) { await clickScreen(sel[0] + a.off.x, sel[1] + a.off.y); await sleep(1300) }
            await clickByText(label); await sleep(1300)
            if (await curModel() === label) { dlog('model =>', label); return true }
            xdo('xdotool key Escape'); await sleep(500)
        }
        dlog('model =>', await curModel(), `(WANTED ${label}!)`)
        return false
    }
    const thinkSel = `(()=>{const t=document.querySelector("textarea");if(!t)return null;const tr=t.getBoundingClientRect();return [...document.querySelectorAll("*")].filter(x=>x.children.length<=2&&/^(Thinking|Fast)$/.test(x.textContent.trim())&&x.getBoundingClientRect().width>0&&Math.abs(x.getBoundingClientRect().y-tr.y)<70&&x.getBoundingClientRect().x>tr.x)[0]||null;})()`
    const curThink = () => ev(`(()=>{const e=${thinkSel};return e?e.textContent.trim():"";})()`)
    async function setThinkingMode(want) {
        const label = want ? 'Thinking' : 'Fast'
        for (let attempt = 0; attempt < 3; attempt++) {
            const cur = await curThink()
            if (!cur) { dlog('thinking toggle not found'); return false }
            if (cur === label) { if (attempt) dlog('thinking =>', label); return true }
            const tg = await ev(`(()=>{const e=${thinkSel};if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];})()`)
            if (tg) { await clickScreen(tg[0] + a.off.x, tg[1] + a.off.y); await sleep(1000) }
            await clickByText(label); await sleep(900)
            if (await curThink() === label) { dlog('thinking =>', label); return true }
            xdo('xdotool key Escape'); await sleep(400)
        }
        dlog('thinking => failed to set', label)
        return false
    }
    async function clickSendBtn() {
        const r = await ev(`(()=>{const sb=[...document.querySelectorAll(".chat-prompt-send-button,[class*=send-button]")].find(e=>!/disabled/.test((e.className||'').toString())&&e.getBoundingClientRect().width>0);if(!sb)return null;const b=sb.getBoundingClientRect();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];})()`)
        if (!r) return false
        await clickScreen(r[0] + a.off.x, r[1] + a.off.y); return true
    }
    async function sendPrompt(content) {
        setClip(content); await sleep(300)
        await clickCss('textarea'); await sleep(400)
        // a paste >~150KB becomes a FILE attachment whose UPLOAD takes several seconds; the send
        // button is a NO-OP until the upload finishes. Poll: each round (re)click send and check
        // whether generation ACTUALLY started — stop icon appears or a response shows. Never key off
        // the body "Thinking" text (that's the Thinking/Fast toggle label). Enter won't submit a file.
        xdo('xdotool key ctrl+v'); await sleep(1500)
        for (let i = 0; i < 14; i++) {
            if (!(await clickSendBtn())) xdo('xdotool key Return')
            await sleep(2500)
            if (await ev(`(()=>{const stop=!!document.querySelector("[class*=icon-stop],[class*=stop-icon],[class*=stopButton]");const resp=[...document.querySelectorAll(".response-message-content")].some(e=>e.innerText.trim().length>0);return stop||resp;})()`).catch(() => false)) return true
            if (i === 4 || i === 9) dlog('waiting for send to take (file still uploading?)')
        }
        return false
    }
    async function readResponse(onDelta) {
        let last = '', stableCount = 0, sawGenerating = false, stallCount = 0, emptyGenCount = 0
        const t0 = Date.now()
        while (Date.now() - t0 < RESP_TIMEOUT_MS) {
            await sleep(3000)
            if (await captcha.isCaptcha(a.client)) { await ensureNoCaptcha() }
            const st = await ev(`(()=>{const b=document.body.innerText||"";const m=[...document.querySelectorAll(".response-message-content")].map(e=>e.innerText.trim()).filter(Boolean);const generating=!!document.querySelector("[class*=icon-stop],[class*=stop-icon],[class*=stopButton]");const err=/Oops! There was an issue|unexpected error occurred|Content Security Warning|inappropriate content|出错了|网络错误/i.test(b);const contentBlock=/Content Security Warning|inappropriate content|内容安全|违规内容/i.test(b);return {text:m[m.length-1]||"",generating,err,contentBlock};})()`)
            const t = st.text
            if (t.length > last.length && onDelta) onDelta(t.slice(last.length))
            if (t === last && t.length > 0) stableCount++; else stableCount = 0
            last = t
            if (st.generating) sawGenerating = true
            if (st.err && t.length === 0) {
                if (st.contentBlock) { dlog('content blocked by qwen moderation'); throw new Error('content_filter') }
                dlog('qwen error (Oops) — bailing'); throw new Error('qwen_error')
            }
            if (t.length === 0 && !st.generating) stallCount++; else stallCount = 0
            if (stallCount >= 50) { dlog('no generation/response 150s after send — stalled, bailing'); throw new Error('completion_stalled') }
            // server-side generation hang: stop-icon shows "generating" but NO content for >35 min
            // (legit heavy thinking produces content within ~20-25 min). Bail → cool + failover,
            // instead of riding the full 50-min timeout (or hanging if an eval wedged).
            if (st.generating && t.length === 0) emptyGenCount++; else emptyGenCount = 0
            if (emptyGenCount >= 700) { dlog('generating but empty >35min — server-side stall, bailing'); throw new Error('completion_stalled') }
            if (t.length > 0 && ((!st.generating && sawGenerating) || stableCount >= 20)) break
        }
        return last
    }
    async function runViaUI(opts, onDelta) {
        await getClient()
        await activateAndOffset()
        const MAX_CONTENT_RETRIES = 3
        let lastErr
        for (let attempt = 1; attempt <= MAX_CONTENT_RETRIES; attempt++) {
            await ensureNoCaptcha()
            await temporaryChat()
            if (!(await selectModel(opts.model))) throw new Error('drive_failed')
            await setThinkingMode(opts.thinking !== false)
            await ensureNoCaptcha()
            if (!(await sendPrompt(opts.content != null ? String(opts.content) : ''))) throw new Error('drive_failed')
            await sleep(2500)
            await ensureNoCaptcha()
            try {
                return await readResponse(onDelta)
            } catch (e) {
                lastErr = e
                if (e.message === 'content_filter' && attempt < MAX_CONTENT_RETRIES) {
                    dlog(`content blocked — internal retry ${attempt + 1}/${MAX_CONTENT_RETRIES} (moderation is non-deterministic)`)
                    continue
                }
                throw e
            }
        }
        throw lastErr
    }

    // ── image generation (Create Image mode) ──
    async function clickPlus() {
        const r = await ev(`(()=>{const t=document.querySelector("textarea");if(!t)return null;const tr=t.getBoundingClientRect();const b=[...document.querySelectorAll("button,[role=button],div")].filter(e=>{const r=e.getBoundingClientRect();return e.querySelector("svg")&&r.width>15&&r.width<55&&Math.abs(r.y+r.height/2-(tr.y+tr.height/2))<40&&r.x<tr.x;}).sort((a,b)=>a.getBoundingClientRect().x-b.getBoundingClientRect().x)[0];if(!b)return null;const r=b.getBoundingClientRect();return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)];})()`)
        if (!r) return false
        await clickScreen(r[0] + a.off.x, r[1] + a.off.y); await sleep(1300); return true
    }
    async function setImageRatio(ratio) {
        if (!ratio) return
        const sel = await ev(`(()=>{const e=[...document.querySelectorAll("*")].filter(x=>x.children.length<=2&&/^\\s*(16:9|1:1|9:16|4:3|3:4)\\s*$/.test(x.textContent.trim())&&x.getBoundingClientRect().width>0&&x.getBoundingClientRect().y>350)[0];if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];})()`)
        if (!sel) { dlog('ratio selector not found'); return }
        await clickScreen(sel[0] + a.off.x, sel[1] + a.off.y); await sleep(1000)
        const ok = await clickByText(ratio); await sleep(800)
        dlog('ratio =>', ok ? ratio : 'failed')
    }
    async function readImage() {
        const t0 = Date.now()
        while (Date.now() - t0 < RESP_TIMEOUT_MS) {
            await sleep(4000)
            if (await captcha.isCaptcha(a.client)) await ensureNoCaptcha()
            if (await ev(`/daily usage limit|usage limit\\. Please wait/i.test(document.body.innerText||"")`).catch(() => false)) throw new Error('usage_limit')
            if (await ev(`/Oops! There was an issue|Content Security Warning|inappropriate content/i.test(document.body.innerText||"")`).catch(() => false)) throw new Error('qwen_error')
            const r = await evA(`(async()=>{
                const im=[...document.querySelectorAll("img")].filter(i=>/cdn\\.qwenlm\\.ai\\/output|\\/t2i\\//i.test(i.src||"")&&i.naturalWidth>50);
                const i=im[im.length-1]; if(!i) return null;
                const orig=i.src.split("x-oss-process")[0].replace(/[?&]$/,"");
                const dim=await new Promise(res=>{const t=new Image();t.onload=()=>res([t.naturalWidth,t.naturalHeight]);t.onerror=()=>res(null);t.src=orig;setTimeout(()=>res(null),8000);});
                return {src:orig, w:dim?dim[0]:i.naturalWidth, h:dim?dim[1]:i.naturalHeight};
            })()`)
            if (r) { dlog(`image: ${r.w}x${r.h} (full-res)`); return r }
        }
        return null
    }
    async function openCreateImage() {
        for (let attempt = 0; attempt < 3; attempt++) {
            await clickPlus()
            for (let i = 0; i < 8; i++) { if (await ev(`/Create Image/.test(document.body.innerText||"")`).catch(() => false)) break; await sleep(400) }
            if (await clickByText('Create Image')) { await sleep(900); return true }
            xdo('xdotool key Escape'); await sleep(400)
        }
        return false
    }
    async function generateImage(opts) {
        await getClient()
        await activateAndOffset()
        await ensureNoCaptcha()
        await temporaryChat()
        if (!(await openCreateImage())) throw new Error('create_image_not_found')
        await setImageRatio(opts.ratio)
        await sendPrompt(opts.content != null ? String(opts.content) : '')
        await sleep(2000)
        await ensureNoCaptcha()
        return readImage()
    }

    return { runViaUI, generateImage }
}
function driverFor(a) { return a.driver || (a.driver = createDriver(a)) }

// ── concurrent dispatch: each request takes a free account; up to POOL.length run at once ──
function pickFree(tried) {
    const now = Date.now()
    const free = POOL.filter(x => !x.busy && now >= x.coolUntil && !tried.has(x))
    free.sort((x, y) => x.lastUsed - y.lastUsed)   // least-recently-used first
    return free[0] || null
}
async function acquireAccount(tried) {
    for (;;) {
        const a = pickFree(tried)
        if (a) { a.busy = true; a.lastUsed = Date.now(); return a }
        // none free right now: wait only if some not-yet-tried account is busy (will free up).
        // if every remaining account is cooling/tried, give up so the caller can fail the request.
        if (!POOL.some(x => !tried.has(x) && x.busy)) return null
        await sleep(800)
    }
}
async function withAccount(fn) {
    const tried = new Set()
    let lastErr
    for (let i = 0; i < POOL.length; i++) {
        const a = await acquireAccount(tried)
        if (!a) break
        tried.add(a)
        if (POOL.length > 1) log(`using account ${a.name} (cdp ${a.cdpPort})`)
        try { const r = await fn(driverFor(a), a); a.busy = false; a.ok++; return r }
        catch (e) {
            a.busy = false; a.fail++; a.lastError = e.message; lastErr = e
            if (e.message === 'usage_limit') { coolAccount(a, 14 * 3600 * 1000, 'usage_limit'); continue }
            if (['CDP connect failed', 'drive_failed', 'completion_stalled', 'qwen_error', 'eval_timeout'].includes(e.message)) { coolAccount(a, 5 * 60 * 1000, e.message); continue }
            throw e
        }
    }
    throw lastErr || new Error('no_account_available')
}

// ── HTTP ──
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/health')) {
        const now = Date.now()
        const accounts = POOL.map(a => ({ name: a.name, cdpPort: a.cdpPort, proxy: a.proxy, busy: a.busy, available: now >= a.coolUntil, coolForMin: a.coolUntil > now ? Math.round((a.coolUntil - now) / 60000) : 0, coolReason: a.coolUntil > now ? a.coolReason : null, ok: a.ok, fail: a.fail, lastError: a.lastError }))
        const free = accounts.filter(x => x.available && !x.busy).length
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, pool: accounts.length, free, accounts }))
    }
    if (req.method === 'POST' && req.url.startsWith('/complete')) {
        const chunks = []; req.on('data', d => chunks.push(d))
        req.on('end', async () => {
            let body; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch (e) { res.writeHead(400); return res.end('bad json') }
            const wantStream = body.stream !== false
            const id = 'chatcmpl-' + Math.random().toString(36).slice(2, 10), created = Math.floor(Date.now() / 1000)
            // report which pool account handled this so the proxy can attribute token usage to it.
            // writeHead is LAZY (set once, on first stream chunk or at the end) so the x-pool-email
            // header carries the account picked inside withAccount() — for stream and non-stream alike.
            let usedEmail = '', headDone = false
            const streamHead = () => { if (!headDone) { headDone = true; res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'x-pool-email': usedEmail }) } }
            const send = c => { if (wantStream) { streamHead(); if (c) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { content: c }, finish_reason: null }] })}\n\n`) } }
            try {
                const text = await withAccount((drv, a) => { usedEmail = a.email || ''; return drv.runViaUI(body, send) })
                if (wantStream) { streamHead(); res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`); res.write('data: [DONE]\n\n'); res.end() }
                else { res.writeHead(200, { 'Content-Type': 'application/json', 'x-pool-email': usedEmail }); res.end(JSON.stringify({ id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] })) }
                log(`done: ${text.length} chars [${usedEmail || '?'}]`)
            } catch (e) {
                log('error:', e.message)
                const blocked = e.message === 'content_filter'
                const unreachable = e.message === 'upstream_unreachable'
                const code = blocked ? 400 : unreachable ? 503 : 502
                const errMsg = blocked ? 'PROHIBITED_CONTENT: qwen content moderation blocked this input after retries'
                    : unreachable ? 'upstream unreachable: proxy/internet down (retry)' : e.message
                const type = blocked ? 'content_filter' : unreachable ? 'service_unavailable' : 'browser_channel_error'
                try {
                    if (wantStream) { streamHead(); res.write(`data: ${JSON.stringify({ error: { message: errMsg, type } })}\n\n`); res.end() }
                    else { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: errMsg, type } })) }
                } catch (_) {}
            }
        })
        return
    }
    if (req.method === 'POST' && req.url.startsWith('/image')) {
        const chunks = []; req.on('data', d => chunks.push(d))
        req.on('end', async () => {
            let body; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch (e) { res.writeHead(400); return res.end('bad json') }
            try {
                const img = await withAccount((drv) => drv.generateImage({ content: body.prompt || body.content, ratio: body.ratio }))
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ url: img ? img.src : '', width: img ? img.w : 0, height: img ? img.h : 0 }))
                log(`image done: ${img ? `${img.w}x${img.h}` : 'none'}`)
            } catch (e) {
                log('image error:', e.message)
                const limited = e.message === 'usage_limit'
                const code = limited ? 429 : 502
                const errMsg = limited ? 'IMAGE_USAGE_LIMIT: qwen daily image-generation limit reached on this account' : e.message
                try { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: errMsg })) } catch (_) {}
            }
        })
        return
    }
    res.writeHead(404); res.end('not found')
})
server.listen(LISTEN, process.env.BROWSER_CHANNEL_HOST || '0.0.0.0', () => log(`browser-channel (CONCURRENT) on :${LISTEN} — pool(${POOL.length}): ${POOL.map(a => `${a.name}@${a.cdpPort}`).join(', ')}`))
// watchdog: keep the socat CDP bridge alive on EVERY pool container
setInterval(() => { for (const a of POOL) { try { ensureSocat(a.ctr, a.cdpPort, a.dbg) } catch (e) {} } }, 120000)
process.on('SIGTERM', () => { for (const a of POOL) { try { if (a.client) a.client.close() } catch (e) {} } process.exit(0) })
