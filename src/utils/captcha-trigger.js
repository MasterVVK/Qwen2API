/**
 * Auto-trigger captcha bypass when upstream responds with WAF block.
 * Per-account deduplication — multiple concurrent requests for the same email
 * share the same in-flight bypass. Different emails run in parallel.
 */
const http = require('http')
const { logger } = require('./logger')
const { DAEMON_URL } = require('./daemon-client')

const COOLDOWN_MS = 30 * 1000 // don't re-trigger more often than once per 30s per email

// Per-email state
const lastTriggerAt = new Map() // email → ts
// Per-email inflight Promise — used by both triggerInBackground (fire-and-forget)
// and triggerAndWait (synchronous). Same key dedup.
const inflightBypass = new Map() // email → Promise<bypassResult>

function _bypassHTTP(email, timeoutMs, captchaUrl) {
    return new Promise((resolve, reject) => {
        const params = new URLSearchParams()
        if (email) params.set('email', email)
        const path = '/refresh' + (params.toString() ? '?' + params.toString() : '')
        const u = new URL(DAEMON_URL + path)
        const body = captchaUrl ? JSON.stringify({ captchaUrl }) : null
        const req = http.request({
            method: 'POST',
            hostname: u.hostname, port: u.port,
            path: u.pathname + u.search,
            headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
            timeout: timeoutMs,
        }, res => {
            const chunks = []
            res.on('data', c => chunks.push(c))
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
                catch (e) { reject(new Error(`bad daemon response: ${e.message}`)) }
            })
        })
        req.on('error', reject)
        req.on('timeout', () => req.destroy(new Error('bypass daemon timeout')))
        if (body) req.write(body)
        req.end()
    })
}

/**
 * Run a bypass for the given email and return its result.
 * Concurrent callers for the same email share one in-flight run.
 * @param {object} [opts]
 * @param {string} [opts.email] - account email; if omitted, daemon uses default
 * @param {number} [opts.timeoutMs=90000]
 */
async function triggerAndWait(opts = {}) {
    const email = opts.email || ''
    const captchaUrl = opts.captchaUrl || null
    const key = email || '*'
    const timeoutMs = opts.timeoutMs || 90000

    if (inflightBypass.has(key)) return inflightBypass.get(key)

    logger.warn(`bypass: starting${email ? ` for ${email}` : ''}${captchaUrl ? ' (URL inlined)' : ''}`, 'CAPTCHA')
    lastTriggerAt.set(key, Date.now())

    const promise = _bypassHTTP(email, timeoutMs, captchaUrl)
        .then(j => {
            if (j.ok) {
                logger.success(`bypass: ok in ${j.ms}ms${email ? ` (${email})` : ''} (x5sec ${j.x5sec_prefix}...)`, 'CAPTCHA')
            } else {
                logger.error(`bypass: failed ${j.error}${email ? ` (${email})` : ''} (step=${j.step})`, 'CAPTCHA')
            }
            return j
        })
        .catch(err => {
            logger.error(`bypass: exception${email ? ` (${email})` : ''}: ${err.message}`, 'CAPTCHA')
            return { ok: false, error: err.message, step: 'http' }
        })
        .finally(() => { inflightBypass.delete(key) })

    inflightBypass.set(key, promise)
    return promise
}

/**
 * Fire-and-forget background trigger — used by inline detector when the caller
 * doesn't want to wait. Implements its own cooldown to avoid hammering the daemon.
 */
function triggerInBackground(reason, opts = {}) {
    const email = opts.email || ''
    const captchaUrl = opts.captchaUrl || null
    const key = email || '*'
    const now = Date.now()
    if (inflightBypass.has(key)) return
    const last = lastTriggerAt.get(key) || 0
    if (now - last < COOLDOWN_MS) return

    logger.warn(`auto-trigger captcha bypass (${reason})${email ? ` for ${email}` : ''}`, 'CAPTCHA')
    triggerAndWait({ email, captchaUrl, timeoutMs: 90000 })
}

/**
 * Inspect raw upstream text for WAF block signatures.
 * Returns:
 *   null         — no block
 *   { kind: 'slide-captcha', url }  — captcha block, url is the slide URL
 *   { kind: 'hard-block' }          — generic Bad_Request, no URL to use
 */
function detectBlock(rawText) {
    if (!rawText || typeof rawText !== 'string') return null
    if (rawText.includes('FAIL_SYS_USER_VALIDATE')) {
        const m = rawText.match(/"url":"([^"]+)"/)
        let url = null
        if (m) {
            url = m[1].replace(/^https:\/\/chat\.qwen\.ai:443\//, 'https://chat.qwen.ai/').replace('//api', '/api')
        }
        return { kind: 'slide-captcha', url }
    }
    // Aliyun WAF HTML challenge page — a SECOND block format (besides the JSON
    // FAIL_SYS_USER_VALIDATE variant above). Served as a full HTML captcha page
    // (<!doctypehtml>…aliyun_waf_aa…#aliyunCaptcha-sliding-slider…). It has NO
    // inline punish URL (captcha loads via JS), so we trigger the bypass with
    // url=null — the daemon re-probes the upstream to obtain a solvable URL.
    // Without this, the HTML page slipped through as block=none → empty content
    // (Completion: 0) → upstream_mute → endless retries, no bypass, chapter fails.
    if (rawText.includes('aliyun_waf') || rawText.includes('aliyunCaptcha')) {
        return { kind: 'slide-captcha', url: null }
    }
    if (rawText.includes('"code":"Bad_Request"') && rawText.includes('Internal error')) {
        return { kind: 'hard-block', url: null }
    }
    return null
}

module.exports = { triggerInBackground, triggerAndWait, detectBlock }
