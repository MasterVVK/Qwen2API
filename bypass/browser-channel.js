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
const { execFileSync } = require('child_process')
const CDP = require('chrome-remote-interface')
const captcha = require('./captcha-solve')

const CTR = process.env.SOLVER_CTR || 'qwen2api-chrome-solver'
const DBG = 9561, CDP_PORT = 9563, DISP = ':1'
const LISTEN = Number(process.env.BROWSER_CHANNEL_PORT || 9100)
const RESP_TIMEOUT_MS = Number(process.env.BC_RESP_TIMEOUT_MS || 50 * 60 * 1000) // qwen3.7-max thinks 10-15 min
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString(), '[bc]', ...a)

let client = null, off = null, queue = Promise.resolve()

// ── infra ──
function ensureSocat() {
    try { execFileSync('docker', ['exec', '-u', 'root', CTR, 'sh', '-c', `which socat >/dev/null 2>&1 || (apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq socat xclip xdotool >/dev/null 2>&1)`], { stdio: 'pipe', timeout: 90000 }) } catch (e) {}
    try { execFileSync('docker', ['exec', CTR, 'sh', '-c', `pgrep -f 'TCP-LISTEN:${CDP_PORT}' >/dev/null || setsid nohup socat TCP-LISTEN:${CDP_PORT},fork,reuseaddr TCP:127.0.0.1:${DBG} >/dev/null 2>&1 < /dev/null & sleep 1`], { stdio: 'pipe' }) } catch (e) {}
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
    for (let i = 0; i < 2; i++) {
        if (!(await clickSendBtn())) xdo('xdotool key Return')
        await sleep(2500)
        if (await ev(`!!document.querySelector("[class*=stop-icon],[class*=stopButton]")||/Thinking/i.test(document.body.innerText)`).catch(() => false)) return
        log('send not submitted yet — retry')
    }
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
        await selectModel(opts.model)
        await setThinkingMode(opts.thinking !== false)   // default Thinking; no-think models pass thinking:false
        await ensureNoCaptcha()
        await sendPrompt(opts.content != null ? String(opts.content) : '')
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

// ── HTTP ──
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/health')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })) }
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
                    const text = await runViaUI(body, send)
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
    res.writeHead(404); res.end('not found')
})
// bind all interfaces so the dockerised qwen2api proxy can reach us via the host gateway
server.listen(LISTEN, process.env.BROWSER_CHANNEL_HOST || '0.0.0.0', () => log(`browser-channel (UI-drive) on :${LISTEN} — container ${CTR}`))
// watchdog: keep the socat CDP bridge alive proactively (it gets wiped on container recreate /
// can die) so the next request doesn't eat a reconnect. Safe — only touches socat, not the browser.
setInterval(() => { try { ensureSocat() } catch (e) {} }, 120000)
process.on('SIGTERM', () => { try { if (client) client.close() } catch (e) {} process.exit(0) })
