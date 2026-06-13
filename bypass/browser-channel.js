#!/usr/bin/env node
/**
 * Browser channel — runs qwen prompts by DRIVING THE CHAT UI like a human, inside the
 * logged-in chrome-solver session, and reading the answer back. This is the ONE approach
 * that does NOT trigger the Aliyun WAF captcha: the real frontend issues the request (with
 * correct bx-ua/FY/timing/TLS), and we only use REAL X input (xdotool) + bare CDP DOM reads.
 *
 * Root cause (diagnosed 2026-06-11): the captcha is provoked by automation SIGNALS, not the
 * account/IP — CDP Page.navigate, Runtime.enable, CDP Input events, raw fetch, cookie resets.
 * A human in noVNC never hits it. So we mimic a human: NO navigate, NO Runtime.enable, NO CDP
 * Input, NO fetch, NO setCookie — only xdotool (keyboard/mouse via XTEST) and Runtime.evaluate
 * for reading. Proven: New Chat → pick model → paste prompt → Enter → read answer, captcha-free.
 *
 * HTTP: POST /complete {model, content, stream?}  → SSE (OpenAI-ish) or JSON {content}
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
// Each account = its own chrome-solver container with a distinct logged-in qwen account, a
// distinct host-side CDP port (socat → that container's chromium :9561) and its own proxy
// egress. The HTTP request queue serializes everything, so instead of threading an account
// object through every function we keep ONE set of "active" bindings (CTR/CDP_PORT/DBG/DISP/
// client/off) and swap them per request via useAccount(). Pool is read from bypass/pool.json;
// absent → a single account on the legacy 9563 port, i.e. identical to the old behaviour.
function mkAccount(o) {
    return {
        name: o.name || o.ctr, ctr: o.ctr, cdpPort: Number(o.cdpPort) || 9563,
        dbg: Number(o.dbg) || 9561, disp: o.disp || ':1', proxy: o.proxy || null,
        client: null, off: null, coolUntil: 0, lastUsed: 0,
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
let CUR = POOL[0]
// active bindings mirror CUR; the rest of the file reads/mutates these directly
let CTR = CUR.ctr, CDP_PORT = CUR.cdpPort, DBG = CUR.dbg, DISP = CUR.disp, client = CUR.client, off = CUR.off, queue = Promise.resolve()

function useAccount(a) {
    if (a !== CUR) { CUR.client = client; CUR.off = off; CUR = a; client = a.client; off = a.off }   // save outgoing, load incoming
    CTR = a.ctr; CDP_PORT = a.cdpPort; DBG = a.dbg; DISP = a.disp
}
const available = a => Date.now() >= a.coolUntil
function selectAccount() {
    const pool = POOL.filter(available)
    const from = pool.length ? pool : POOL.slice()        // all cooling → least-bad (oldest used)
    from.sort((x, y) => x.lastUsed - y.lastUsed)           // round-robin by least-recently-used
    const a = from[0]; a.lastUsed = Date.now(); return a
}
function coolAccount(a, ms, why) { a.coolUntil = Date.now() + ms; log(`account ${a.name} cooling ${Math.round(ms / 60000)}min (${why})`) }
// run `fn(account)` on a selected account; on account-level failures (daily quota, dead CDP)
// cool that account and retry on the next one. Content/network errors propagate unchanged.
async function withAccount(fn) {
    let lastErr
    for (let i = 0; i < POOL.length; i++) {
        const a = selectAccount(); useAccount(a)
        if (POOL.length > 1) log(`using account ${a.name} (cdp ${a.cdpPort})`)
        try { return await fn(a) }
        catch (e) {
            lastErr = e
            // account-level failures → cool this account and try the next one. usage_limit is the
            // daily quota (long cool); drive_failed/completion_stalled/cdp = a flaky or stuck
            // container (short cool). content_filter/upstream_unreachable are NOT account-level —
            // they propagate unchanged (content moderation, network outage).
            if (e.message === 'usage_limit') { coolAccount(a, 14 * 3600 * 1000, 'usage_limit'); continue }
            if (['CDP connect failed', 'drive_failed', 'completion_stalled', 'qwen_error'].includes(e.message)) { coolAccount(a, 5 * 60 * 1000, e.message); continue }
            throw e
        }
    }
    throw lastErr
}

// ── infra ──
function ensureSocat(ctr = CTR, cdpPort = CDP_PORT, dbg = DBG) {
    try { execFileSync('docker', ['exec', '-u', 'root', ctr, 'sh', '-c', `which socat >/dev/null 2>&1 || (apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq socat xclip xdotool >/dev/null 2>&1)`], { stdio: 'pipe', timeout: 90000 }) } catch (e) {}
    try { execFileSync('docker', ['exec', ctr, 'sh', '-c', `pgrep -f 'TCP-LISTEN:${cdpPort}' >/dev/null || setsid nohup socat TCP-LISTEN:${cdpPort},fork,reuseaddr TCP:127.0.0.1:${dbg} >/dev/null 2>&1 < /dev/null & sleep 1`], { stdio: 'pipe' }) } catch (e) {}
}
const xdo = cmd => { try { return execFileSync('docker', ['exec', '-e', `DISPLAY=${DISP}`, CTR, 'sh', '-c', cmd], { stdio: 'pipe' }).toString() } catch (e) { return '' } }
const setClip = text => { try { execFileSync('docker', ['exec', '-i', '-e', `DISPLAY=${DISP}`, CTR, 'sh', '-c', 'xclip -selection clipboard'], { input: text, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (e) {} }

async function getClient() {
    if (client) { try { await client.Runtime.evaluate({ expression: '1' }); return client } catch (e) { try { await client.close() } catch (_) {} client = null; off = null } }
    ensureSocat()
    for (let i = 0; i < 50 && !client; i++) { try { client = await CDP({ host: '127.0.0.1', port: CDP_PORT }) } catch (e) { await sleep(300) } }
    if (!client) throw new Error('CDP connect failed')
    // NOTE: deliberately NO Runtime.enable / Page.enable / navigate — those are the WAF triggers.
    log('CDP connected (read-only)')
    return client
}
const ev = async expr => (await client.Runtime.evaluate({ returnByValue: true, expression: expr })).result.value
// awaiting variant — for evals whose expression is an async IIFE returning a Promise
const evA = async expr => (await client.Runtime.evaluate({ returnByValue: true, awaitPromise: true, expression: expr })).result.value

// ── xdotool input (real keyboard/mouse) ──
async function activateAndOffset() {
    const loc = xdo(`xdotool mousemove 500 400; xdotool getmouselocation --shell 2>/dev/null`)
    const wm = loc.match(/WINDOW=(\d+)/)
    if (wm) xdo(`xdotool windowactivate ${wm[1]} 2>/dev/null; xdotool windowfocus ${wm[1]} 2>/dev/null; true`)
    await sleep(300)
    // measure screen→css offset via a real pointer event
    await ev(`window.__le=null;document.onmousemove=e=>{window.__le=[Math.round(e.clientX),Math.round(e.clientY)]}`)
    for (const py of [400, 350, 300]) {
        xdo(`xdotool mousemove 501 ${py}`); await sleep(180)
        const p = await ev(`window.__le`)
        if (p) { off = { x: 501 - p[0], y: py - p[1] }; return off }
    }
    off = { x: 0, y: 87 }; return off
}
const clickScreen = async (x, y) => { xdo(`xdotool mousemove ${Math.round(x)} ${Math.round(y)}; xdotool click 1`); await sleep(400) }
async function clickCss(sel) {
    const r = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];})()`)
    if (!r) return false
    await clickScreen(r[0] + off.x, r[1] + off.y); return true
}
async function clickByText(text, opts = {}) {
    const r = await ev(`(()=>{const e=[...document.querySelectorAll("*")].filter(x=>x.children.length===0&&x.textContent.trim()===${JSON.stringify(text)}&&x.getBoundingClientRect().width>0)[0];if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];})()`)
    if (!r) return false
    await clickScreen(r[0] + off.x, r[1] + off.y); return true
}

// ── chat actions ──
async function ensureNoCaptcha() {
    if (!(await captcha.isCaptcha(client))) return true
    log('WAF captcha appeared — auto-solving (retries)...')
    const ok = await captcha.solve(client, { maxTries: 25, offset: off, log: m => log('  captcha:', m) })
    log(ok ? 'captcha cleared' : 'captcha NOT cleared after retries')
    return ok
}
async function newChat() {
    const r = await ev(`(()=>{const b=[...document.querySelectorAll("button,a,div,span")].find(e=>/^\\s*New Chat\\s*$/.test(e.textContent)&&e.textContent.length<15&&e.getBoundingClientRect().width>0);if(!b)return null;const x=b.getBoundingClientRect();return [Math.round(x.x+x.width/2),Math.round(x.y+x.height/2)];})()`)
    if (r) { await clickScreen(r[0] + off.x, r[1] + off.y); await sleep(1500) }
}
// "Temporary Chat" = the right-most header icon: chat is NOT saved to history. Clicking it
// opens a FRESH temporary chat each time (keeps the model). Retry until the URL confirms it.
const isTemp = () => ev(`/temporary-chat=true/.test(location.href)`)
// the page failed to LOAD — proxy/internet down (chrome error page / ERR_TUNNEL_CONNECTION_FAILED)
const pageError = () => ev(`(()=>{const u=location.href||'';const b=(document.body&&document.body.innerText)||'';return /^chrome-error|^about:neterror/i.test(u)||/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|This site can.t be reached|can.t be reached/i.test(b);})()`)
// Open a fresh "Temporary Chat" (not saved to history) by navigating the ADDRESS BAR with
// real keyboard input (xdotool Ctrl+L → type URL → Enter). This is real navigation like a
// human typing a URL — NOT CDP Page.navigate (which would trip the WAF). Captcha-free.
async function temporaryChat() {
    // navigating to a fresh ?temporary-chat=true page also RESETS any sticky composer mode
    // (e.g. "Create Image" left over from a previous image request) back to plain text.
    for (let attempt = 0; attempt < 6; attempt++) {
        xdo(`xdotool windowactivate $(xdotool getmouselocation --shell 2>/dev/null | sed -n 's/WINDOW=//p') 2>/dev/null; true`)
        xdo('xdotool key ctrl+l'); await sleep(700)
        xdo('xdotool type --clearmodifiers --delay 20 "https://chat.qwen.ai/?temporary-chat=true"'); await sleep(500)
        xdo('xdotool key Return')
        for (let i = 0; i < 14; i++) { await sleep(900); if (await isTemp().catch(() => false)) break }
        // proxy/internet down → keep re-navigating; it recovers the moment the connection returns
        if (await pageError().catch(() => false)) {
            log(`upstream unreachable (proxy/internet down) — attempt ${attempt + 1}, waiting for connection`)
            await sleep(8000); continue
        }
        if (await isTemp().catch(() => false)) {
            for (let i = 0; i < 20; i++) { if (await ev(`!!document.querySelector("textarea")`).catch(() => false)) break; await sleep(500) }
            log('temporary chat: on'); return true
        }
        log(`temporary chat attempt ${attempt + 1} → off, retrying`)
    }
    // persistent connection failure → fail fast with a retriable error (the novel retries with
    // backoff) instead of feeding a dead page into selectModel/sendPrompt and hanging.
    if (await pageError().catch(() => false)) { log('upstream unreachable — proxy/internet down, bailing'); throw new Error('upstream_unreachable') }
    log('temporary chat: off (could not enter — translation may be unreliable)')
    return false
}
const MODEL_LABEL = { 'qwen3.7-max': 'Qwen3.7-Max', 'qwen3.7-max-thinking': 'Qwen3.7-Max', 'qwen3.7-plus': 'Qwen3.7-Plus', 'qwen3.6-plus': 'Qwen3.6-Plus', 'qwen3-max': 'Qwen3.7-Max' }
// the model header label; the selector sits top-LEFT and shifts (x≈116 in a temporary chat)
const curModel = () => ev(`(()=>{const e=[...document.querySelectorAll("*")].find(x=>x.children.length<5&&/Qwen3\\.[67]-(Max|Plus)/.test(x.textContent)&&x.textContent.replace(/\\s/g,"").length<20&&x.getBoundingClientRect().y<120&&x.getBoundingClientRect().x<700);return e?e.textContent.trim():"";})()`)
async function selectModel(model) {
    const label = MODEL_LABEL[(model || '').toLowerCase()] || 'Qwen3.7-Max'
    for (let attempt = 0; attempt < 4; attempt++) {
        if (await curModel() === label) { if (attempt) log('model =>', label); return true }
        // open the top-left model dropdown (located dynamically — its x shifts per view)
        const sel = await ev(`(()=>{const e=[...document.querySelectorAll("*")].filter(x=>x.children.length<5&&/Qwen3\\.[67]-(Max|Plus)/.test(x.textContent)&&x.textContent.replace(/\\s/g,"").length<20&&x.getBoundingClientRect().y<120&&x.getBoundingClientRect().x<700&&x.getBoundingClientRect().width<200)[0];if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];})()`)
        if (sel) { await clickScreen(sel[0] + off.x, sel[1] + off.y); await sleep(1300) }
        await clickByText(label); await sleep(1300)
        if (await curModel() === label) { log('model =>', label); return true }
        xdo('xdotool key Escape'); await sleep(500)   // close stuck dropdown, retry
    }
    log('model =>', await curModel(), `(WANTED ${label}!)`)
    return false
}
// "Thinking" vs "Fast" toggle at the composer (right of the textarea). want=true → Thinking
// (reasoning), want=false → Fast (no reasoning, for the no-think model id=44 qwen3.7-max).
const thinkSel = `(()=>{const t=document.querySelector("textarea");if(!t)return null;const tr=t.getBoundingClientRect();return [...document.querySelectorAll("*")].filter(x=>x.children.length<=2&&/^(Thinking|Fast)$/.test(x.textContent.trim())&&x.getBoundingClientRect().width>0&&Math.abs(x.getBoundingClientRect().y-tr.y)<70&&x.getBoundingClientRect().x>tr.x)[0]||null;})()`
const curThink = () => ev(`(()=>{const e=${thinkSel};return e?e.textContent.trim():"";})()`)
async function setThinkingMode(want) {
    const label = want ? 'Thinking' : 'Fast'
    for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await curThink()
        if (!cur) { log('thinking toggle not found'); return false }
        if (cur === label) { if (attempt) log('thinking =>', label); return true }
        const tg = await ev(`(()=>{const e=${thinkSel};if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];})()`)
        if (tg) { await clickScreen(tg[0] + off.x, tg[1] + off.y); await sleep(1000) }
        await clickByText(label); await sleep(900)
        if (await curThink() === label) { log('thinking =>', label); return true }
        xdo('xdotool key Escape'); await sleep(400)
    }
    log('thinking => failed to set', label)
    return false
}
// the composer send button (blue ↑). Clicking it submits whatever is in the composer — inline
// text OR a file attachment — whereas Enter does NOT submit a file attachment with empty text.
async function clickSendBtn() {
    const r = await ev(`(()=>{const sb=[...document.querySelectorAll(".chat-prompt-send-button,[class*=send-button]")].find(e=>!/disabled/.test((e.className||'').toString())&&e.getBoundingClientRect().width>0);if(!sb)return null;const b=sb.getBoundingClientRect();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];})()`)
    if (!r) return false
    await clickScreen(r[0] + off.x, r[1] + off.y); return true
}
async function sendPrompt(content) {
    setClip(content); await sleep(300)
    await clickCss('textarea'); await sleep(400)
    // a paste larger than ~150KB is auto-converted by qwen into a FILE attachment ("Pasted_Text…txt")
    // — give it time to attach, then submit via the send button (Enter won't submit a file).
    xdo('xdotool key ctrl+v'); await sleep(1800)
    for (let i = 0; i < 3; i++) {
        if (!(await clickSendBtn())) xdo('xdotool key Return')
        await sleep(2500)
        // submitted = generation running (stop button / "Thinking"), OR a response already appeared
        // (fast answers finish before we look — was a false "not submitted" → drive_failed).
        if (await ev(`(()=>{const gen=!!document.querySelector("[class*=stop-icon],[class*=stopButton]")||/Thinking/i.test(document.body.innerText||"");const resp=[...document.querySelectorAll(".response-message-content")].some(e=>e.innerText.trim().length>0);return gen||resp;})()`).catch(() => false)) return true
        log('send not submitted yet — retry')
    }
    return false
}
async function readResponse(onDelta) {
    // Heavy chapter edits THINK for ~20 min (response stays empty), THEN stream a long answer.
    // So we can't finish on a timer or on "empty for a while" — wait for generation to actually
    // STOP (the composer's stop-button disappears) after having produced content. Fallbacks:
    // content unchanged for 30s, or the hard RESP_TIMEOUT_MS.
    let last = '', stableCount = 0, sawGenerating = false, stallCount = 0
    const t0 = Date.now()
    while (Date.now() - t0 < RESP_TIMEOUT_MS) {
        await sleep(3000)
        if (await captcha.isCaptcha(client)) { await ensureNoCaptcha() }
        // "generating" = the composer's send-button is in STOP mode (present and NOT disabled);
        // when the answer is done it reverts to ".send-button.disabled" (empty composer). This
        // survives long thinking PAUSES (the stop button stays), unlike the stable-timer guess.
        const st = await ev(`(()=>{const b=document.body.innerText||"";const m=[...document.querySelectorAll(".response-message-content")].map(e=>e.innerText.trim()).filter(Boolean);const sb=document.querySelector(".send-button,[class*=send-button]");const generating=(!!sb&&!/disabled/.test(sb.className||""))||!!document.querySelector("[class*=stop-icon],[class*=stopButton]");const err=/Oops! There was an issue|unexpected error occurred|Content Security Warning|inappropriate content|出错了|网络错误/i.test(b);const contentBlock=/Content Security Warning|inappropriate content|内容安全|违规内容/i.test(b);return {text:m[m.length-1]||"",generating,err,contentBlock};})()`)
        const t = st.text
        if (t.length > last.length && onDelta) onDelta(t.slice(last.length))
        if (t === last && t.length > 0) stableCount++; else stableCount = 0
        last = t
        if (st.generating) sawGenerating = true
        // qwen error with no usable content → bail fast, REGARDLESS of generating (the send-button
        // can get stuck in stop-mode). Distinguish a content-moderation block from a generic Oops.
        if (st.err && t.length === 0) {
            if (st.contentBlock) { log('content blocked by qwen moderation'); throw new Error('content_filter') }
            log('qwen error (Oops) — bailing'); throw new Error('qwen_error')
        }
        // completion never started / didn't resume after a captcha: no content AND not generating
        // for ~150s → don't sit on the 50-min timeout, bail so the novel retries fast
        if (t.length === 0 && !st.generating) stallCount++; else stallCount = 0
        if (stallCount >= 50) { log('no generation/response 150s after send — stalled, bailing'); throw new Error('completion_stalled') }
        // finished = produced content AND (generation stopped after we saw it run, OR stable 30s)
        if (t.length > 0 && ((!st.generating && sawGenerating) || stableCount >= 20)) break
    }
    return last
}

async function runViaUI(opts, onDelta) {
    await getClient()
    await activateAndOffset()
    // qwen content moderation is NON-DETERMINISTIC (same input passes/blocks at random), so a
    // content_filter is retried internally a few times; only a PERSISTENT block propagates up as
    // content_filter → the proxy turns it into a PROHIBITED_CONTENT error → the novel skips the
    // chapter. No content is streamed before content_filter (it throws at 0 chars), so retry is clean.
    const MAX_CONTENT_RETRIES = 3
    let lastErr
    for (let attempt = 1; attempt <= MAX_CONTENT_RETRIES; attempt++) {
        await ensureNoCaptcha()
        await temporaryChat()
        // selectModel/sendPrompt failures are ACCOUNT-level (flaky clone, UI not drivable) — throw
        // drive_failed so withAccount() cools this account and fails over to the next one, instead
        // of proceeding with the wrong model / a stuck composer and wedging the queue for 50 min.
        if (!(await selectModel(opts.model))) throw new Error('drive_failed')
        await setThinkingMode(opts.thinking !== false)   // default Thinking; no-think models pass thinking:false
        await ensureNoCaptcha()
        if (!(await sendPrompt(opts.content != null ? String(opts.content) : ''))) throw new Error('drive_failed')
        await sleep(2500)
        await ensureNoCaptcha()           // in case sending somehow triggered it
        try {
            return await readResponse(onDelta)
        } catch (e) {
            lastErr = e
            if (e.message === 'content_filter' && attempt < MAX_CONTENT_RETRIES) {
                log(`content blocked — internal retry ${attempt + 1}/${MAX_CONTENT_RETRIES} (moderation is non-deterministic)`)
                continue
            }
            throw e
        }
    }
    throw lastErr
}

// ── image generation (Create Image mode) ──
// the "+" button left of the composer opens the tools menu (Create Image / Create Video / …)
async function clickPlus() {
    const r = await ev(`(()=>{const t=document.querySelector("textarea");if(!t)return null;const tr=t.getBoundingClientRect();const b=[...document.querySelectorAll("button,[role=button],div")].filter(e=>{const r=e.getBoundingClientRect();return e.querySelector("svg")&&r.width>15&&r.width<55&&Math.abs(r.y+r.height/2-(tr.y+tr.height/2))<40&&r.x<tr.x;}).sort((a,b)=>a.getBoundingClientRect().x-b.getBoundingClientRect().x)[0];if(!b)return null;const r=b.getBoundingClientRect();return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)];})()`)
    if (!r) return false
    await clickScreen(r[0] + off.x, r[1] + off.y); await sleep(1300); return true
}
// aspect-ratio chip near the composer (shows e.g. "16:9"); click it then the target ratio
async function setImageRatio(ratio) {
    if (!ratio) return
    const sel = await ev(`(()=>{const e=[...document.querySelectorAll("*")].filter(x=>x.children.length<=2&&/^\\s*(16:9|1:1|9:16|4:3|3:4)\\s*$/.test(x.textContent.trim())&&x.getBoundingClientRect().width>0&&x.getBoundingClientRect().y>350)[0];if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];})()`)
    if (!sel) { log('ratio selector not found'); return }
    await clickScreen(sel[0] + off.x, sel[1] + off.y); await sleep(1000)
    const ok = await clickByText(ratio); await sleep(800)
    log('ratio =>', ok ? ratio : 'failed')
}
// poll for the generated image; return the FULL-RES original URL + true dimensions.
// The generated image is served from cdn.qwenlm.ai/output/.../t2i/...png?key=<JWT>; the UI
// appends &x-oss-process=image/resize,...,w_450 to shrink it for display. We strip that
// param (keeping the ?key auth) to recover the original (e.g. 2688x1536 for 16:9), and load
// the stripped URL in-page to read its real naturalWidth/Height. alicdn imgs are qwen's
// preset-suggestion thumbnails, NOT our image — excluded.
async function readImage(onDelta) {
    const t0 = Date.now()
    while (Date.now() - t0 < RESP_TIMEOUT_MS) {
        await sleep(4000)
        if (await captcha.isCaptcha(client)) await ensureNoCaptcha()
        // daily image-generation quota on the logged-in account — distinct from a transient error
        if (await ev(`/daily usage limit|usage limit\\. Please wait/i.test(document.body.innerText||"")`).catch(() => false)) throw new Error('usage_limit')
        if (await ev(`/Oops! There was an issue|Content Security Warning|inappropriate content/i.test(document.body.innerText||"")`).catch(() => false)) throw new Error('qwen_error')
        const r = await evA(`(async()=>{
            const im=[...document.querySelectorAll("img")].filter(i=>/cdn\\.qwenlm\\.ai\\/output|\\/t2i\\//i.test(i.src||"")&&i.naturalWidth>50);
            const i=im[im.length-1]; if(!i) return null;
            const orig=i.src.split("x-oss-process")[0].replace(/[?&]$/,"");
            const dim=await new Promise(res=>{const t=new Image();t.onload=()=>res([t.naturalWidth,t.naturalHeight]);t.onerror=()=>res(null);t.src=orig;setTimeout(()=>res(null),8000);});
            return {src:orig, w:dim?dim[0]:i.naturalWidth, h:dim?dim[1]:i.naturalHeight};
        })()`)
        if (r) { log(`image: ${r.w}x${r.h} (full-res)`); return r }
    }
    return null
}
// open "+" menu and pick "Create Image" — robust against the menu not being rendered yet
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

// ── HTTP ──
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/health')) {
        const now = Date.now()
        const accounts = POOL.map(a => ({ name: a.name, cdpPort: a.cdpPort, proxy: a.proxy, available: now >= a.coolUntil, coolForMin: a.coolUntil > now ? Math.round((a.coolUntil - now) / 60000) : 0 }))
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, pool: accounts.length, accounts }))
    }
    if (req.method === 'POST' && req.url.startsWith('/complete')) {
        const chunks = []; req.on('data', d => chunks.push(d))
        req.on('end', () => {
            let body; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch (e) { res.writeHead(400); return res.end('bad json') }
            const wantStream = body.stream !== false
            queue = queue.then(async () => {
                const id = 'chatcmpl-' + Math.random().toString(36).slice(2, 10), created = Math.floor(Date.now() / 1000)
                if (wantStream) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
                const send = c => { if (wantStream && c) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { content: c }, finish_reason: null }] })}\n\n`) }
                try {
                    const text = await withAccount(() => runViaUI(body, send))
                    if (wantStream) { res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`); res.write('data: [DONE]\n\n'); res.end() }
                    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] })) }
                    log(`done: ${text.length} chars`)
                } catch (e) {
                    log('error:', e.message)
                    // persistent content block → PROHIBITED_CONTENT (400) so the novel SKIPS the chapter;
                    // proxy/internet down → 503 so the novel RETRIES with backoff; else generic 502.
                    const blocked = e.message === 'content_filter'
                    const unreachable = e.message === 'upstream_unreachable'
                    const code = blocked ? 400 : unreachable ? 503 : 502
                    const errMsg = blocked ? 'PROHIBITED_CONTENT: qwen content moderation blocked this input after retries'
                        : unreachable ? 'upstream unreachable: proxy/internet down (retry)' : e.message
                    const type = blocked ? 'content_filter' : unreachable ? 'service_unavailable' : 'browser_channel_error'
                    try {
                        if (wantStream) { res.write(`data: ${JSON.stringify({ error: { message: errMsg, type } })}\n\n`); res.end() }
                        else { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: errMsg, type } })) }
                    } catch (_) {}
                }
            }).catch(e => log('queue error', e.message))
        })
        return
    }
    if (req.method === 'POST' && req.url.startsWith('/image')) {
        const chunks = []; req.on('data', d => chunks.push(d))
        req.on('end', () => {
            let body; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch (e) { res.writeHead(400); return res.end('bad json') }
            queue = queue.then(async () => {
                try {
                    const img = await withAccount(() => generateImage({ content: body.prompt || body.content, ratio: body.ratio }))
                    res.writeHead(200, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ url: img ? img.src : '', width: img ? img.w : 0, height: img ? img.h : 0 }))
                    log(`image done: ${img ? `${img.w}x${img.h}` : 'none'}`)
                } catch (e) {
                    log('image error:', e.message)
                    // daily quota on the account → 429 with a clear message; else 502
                    const limited = e.message === 'usage_limit'
                    const code = limited ? 429 : 502
                    const errMsg = limited ? 'IMAGE_USAGE_LIMIT: qwen daily image-generation limit reached on this account' : e.message
                    try { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: errMsg })) } catch (_) {}
                }
            }).catch(e => log('queue error', e.message))
        })
        return
    }
    res.writeHead(404); res.end('not found')
})
// bind all interfaces so the dockerised qwen2api proxy can reach us via the host gateway
server.listen(LISTEN, process.env.BROWSER_CHANNEL_HOST || '0.0.0.0', () => log(`browser-channel (UI-drive) on :${LISTEN} — pool: ${POOL.map(a => `${a.name}@${a.cdpPort}`).join(', ')}`))
// watchdog: keep the socat CDP bridge alive proactively on EVERY pool container (it gets wiped
// on container recreate / can die) so the next request doesn't eat a reconnect. Safe — only
// touches socat, not the browser.
setInterval(() => { for (const a of POOL) { try { ensureSocat(a.ctr, a.cdpPort, a.dbg) } catch (e) {} } }, 120000)
process.on('SIGTERM', () => { try { if (client) client.close() } catch (e) {} process.exit(0) })
