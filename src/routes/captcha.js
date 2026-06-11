/**
 * Captcha bypass endpoints — per-account.
 * The actual bypass pipeline runs on the host (bypass/daemon.js) — these endpoints
 * proxy to it, plus expose per-account cookie hot-swap.
 */
const express = require('express')
const http = require('http')
const path = require('path')
const axios = require('axios')
const router = express.Router()
const { apiKeyVerify, adminKeyVerify } = require('../middlewares/authorization.js')
const {
    setRuntimeCookieOverride, getRuntimeCookieInfo, getCookieHeader,
    setAccountCookies, clearAccountCookies, getAccountCookieInfo,
} = require('../utils/ssxmod-manager')
const { getProxyAgent, getChatBaseUrl } = require('../utils/proxy-helper')
const accountManager = require('../utils/account.js')
const { logger } = require('../utils/logger')
const { DAEMON_URL } = require('../utils/daemon-client')

function daemonRequest(reqPath, opts = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(DAEMON_URL + reqPath)
        const req = http.request({
            method: opts.method || 'GET',
            hostname: u.hostname, port: u.port,
            path: u.pathname + u.search,
            headers: { 'Content-Type': 'application/json' },
            timeout: opts.timeout || 90000,
        }, res => {
            const chunks = []
            res.on('data', c => chunks.push(c))
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }) }
                catch (e) { reject(new Error(`bad daemon response: ${e.message}`)) }
            })
        })
        req.on('error', reject)
        req.on('timeout', () => req.destroy(new Error('daemon timeout')))
        if (opts.body) req.write(JSON.stringify(opts.body))
        req.end()
    })
}

// ─── POST /api/captcha/_apply?email=X ─── push fresh cookie-jar from daemon
// Per-account if `email` query is present, falls back to legacy single override otherwise.
router.post('/captcha/_apply', adminKeyVerify, express.json({ limit: '64kb' }), (req, res) => {
    const { cookieHeader } = req.body || {}
    const email = (req.query.email || req.body?.email || '').trim()
    if (typeof cookieHeader !== 'string' || cookieHeader.length < 20) {
        return res.status(400).json({ error: 'cookieHeader missing or too short' })
    }
    if (email) {
        setAccountCookies(email, cookieHeader)
        logger.success(`per-account cookie-jar updated for ${email} (${cookieHeader.length} bytes)`, 'CAPTCHA')
        return res.json({ ok: true, email, length: cookieHeader.length })
    }
    setRuntimeCookieOverride(cookieHeader)
    logger.success(`runtime cookie-jar updated (${cookieHeader.length} bytes)`, 'CAPTCHA')
    return res.json({ ok: true, length: cookieHeader.length })
})

// ─── DELETE /api/captcha/_apply?email=X ─── clear per-account cookies (for debug/manual)
router.delete('/captcha/_apply', adminKeyVerify, (req, res) => {
    const email = (req.query.email || '').trim()
    if (!email) return res.status(400).json({ error: 'email query required' })
    const had = clearAccountCookies(email)
    res.json({ ok: true, email, removed: had })
})

// ─── GET /api/captcha/status ─── overall snapshot
router.get('/captcha/status', adminKeyVerify, async (req, res) => {
    const runtime = getRuntimeCookieInfo()
    const accountsCookies = getAccountCookieInfo()

    // attach all known accounts (even those without cookies) — useful for UI
    const allEmails = (accountManager.accountTokens || []).map(a => a.email).filter(Boolean)
    const known = new Set(accountsCookies.map(c => c.email))
    for (const em of allEmails) {
        if (!known.has(em)) {
            accountsCookies.push({ email: em, length: 0, updatedAt: null, ageMs: null, x5secPrefix: null })
        }
    }

    let daemon = null
    try {
        const r = await daemonRequest('/status', { timeout: 5000 })
        daemon = r.body
    } catch (e) {
        daemon = { error: e.message }
    }
    res.json({ runtime, accounts: accountsCookies, daemon, daemonUrl: DAEMON_URL })
})

// ─── POST /api/captcha/refresh?email=X ─── manual trigger via daemon
router.post('/captcha/refresh', adminKeyVerify, async (req, res) => {
    const email = (req.query.email || req.body?.email || '').trim()
    const qs = email ? `?email=${encodeURIComponent(email)}` : ''
    try {
        const r = await daemonRequest('/refresh' + qs, { method: 'POST', timeout: 120000 })
        res.status(r.status).json(r.body)
    } catch (e) {
        logger.error(`bypass refresh failed: ${e.message}`, 'CAPTCHA')
        res.status(502).json({ ok: false, error: e.message })
    }
})

// ─── POST /api/captcha/_trigger?email=X ─── probe upstream via specific account
// Used by daemon to obtain a captcha URL bound to the account's proxy/IP.
// Does NOT pass through chat-middleware/retry-and-wait → avoids deadlock.
router.post('/captcha/_trigger', adminKeyVerify, async (req, res) => {
    const email = (req.query.email || req.body?.email || '').trim()
    if (!email) return res.status(400).json({ error: 'email query param required' })

    const account = accountManager.getAccountByEmail(email)
    if (!account || !account.token) {
        return res.status(404).json({ error: `account not found or no token: ${email}` })
    }

    const chatBaseUrl = getChatBaseUrl()
    const proxyAgent = getProxyAgent(account)
    const chat_id = '00000000-0000-0000-0000-' + Date.now().toString().padStart(12, '0')

    const config = {
        headers: {
            'Authorization': `Bearer ${account.token}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Origin': chatBaseUrl,
            'Referer': `${chatBaseUrl}/`,
            'Cookie': getCookieHeader(account),
        },
        responseType: 'text',
        timeout: 20000,
    }
    if (proxyAgent) { config.httpsAgent = proxyAgent; config.proxy = false }

    const payload = {
        stream: false, chat_id,
        chat_type: 't2t', model: 'qwen3-235b-a22b',
        messages: [{ role: 'user', content: 'hi' }],
    }
    const url = `${chatBaseUrl}/api/v2/chat/completions?chat_id=${chat_id}`

    try {
        const upstream = await axios.post(url, payload, config)
        const raw = typeof upstream.data === 'string' ? upstream.data : JSON.stringify(upstream.data)
        const m = raw.match(/"url":"([^"]+)"/)
        // Variant 1 — JSON FAIL_SYS_USER_VALIDATE with an inline punish URL.
        if (raw.includes('FAIL_SYS_USER_VALIDATE') && m) {
            const captchaUrl = m[1].replace(/^https:\/\/chat\.qwen\.ai:443\//, 'https://chat.qwen.ai/').replace('//api', '/api')
            logger.warn(`_trigger ${email}: WAF json-variant (url captured)`, 'CAPTCHA')
            return res.json({ captcha: true, url: captchaUrl, variant: 'json', account: email, proxy: account.proxy || '(global)' })
        }
        // Variant 2 — Aliyun WAF HTML interstitial page (no inline URL; captcha loads via JS).
        if (raw.includes('aliyun_waf') || raw.includes('aliyunCaptcha')) {
            logger.warn(`_trigger ${email}: WAF html-variant (client-side Aliyun captcha — not auto-solvable)`, 'CAPTCHA')
            return res.json({ captcha: true, url: null, variant: 'html', account: email, proxy: account.proxy || '(global)' })
        }
        logger.info(`_trigger ${email}: no WAF (raw ${raw.length}B starts: ${raw.slice(0, 60).replace(/\s+/g, ' ')})`, 'CAPTCHA')
        return res.json({ captcha: false, account: email })
    } catch (err) {
        const status = err.response?.status || 0
        return res.status(502).json({ error: err.message, upstreamStatus: status })
    }
})

// ─── GET /api/captcha/ui ─── standalone UI
router.get('/captcha/ui', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../../public/captcha.html'))
})

module.exports = router
