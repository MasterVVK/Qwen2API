/**
 * SSXMOD Cookie 管理器 + per-account captcha cookies storage
 */

const fs = require('fs')
const path = require('path')
const { generateCookies } = require('./cookie-generator')
const { logger } = require('./logger')

// ───────────────────── base SSXMOD generator (unchanged) ─────────────────────
let currentCookies = {
    ssxmod_itna: '',
    ssxmod_itna2: '',
    timestamp: 0
}
const REFRESH_INTERVAL = 15 * 60 * 1000
let refreshTimer = null

function refreshCookies() {
    try {
        const result = generateCookies()
        currentCookies = {
            ssxmod_itna: result.ssxmod_itna,
            ssxmod_itna2: result.ssxmod_itna2,
            timestamp: result.timestamp
        }
        logger.info('SSXMOD Cookie 已刷新', 'SSXMOD')
    } catch (error) {
        logger.error('SSXMOD Cookie 刷新失败', 'SSXMOD', '', error.message)
    }
}

// ───────────────────── per-account cookies (NEW in step 3) ───────────────────
// Map<email, { cookieHeader: string, updatedAt: number }>
const accountCookies = new Map()

// Legacy single override (backward compat for current env-based setup)
let runtimeCookieOverride = null
let runtimeCookieAppliedAt = null

// Persistence
const PERSIST_PATH = path.resolve(__dirname, '../../data/captcha-cookies.json')
let saveTimer = null

function _scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(_doSave, 300)
}

function _doSave() {
    saveTimer = null
    try {
        const out = {}
        for (const [email, rec] of accountCookies.entries()) {
            out[email] = rec
        }
        fs.mkdirSync(path.dirname(PERSIST_PATH), { recursive: true })
        fs.writeFileSync(PERSIST_PATH + '.tmp', JSON.stringify(out, null, 2))
        fs.renameSync(PERSIST_PATH + '.tmp', PERSIST_PATH)
    } catch (e) {
        logger.error(`persist captcha-cookies failed: ${e.message}`, 'SSXMOD')
    }
}

function _loadFromDisk() {
    try {
        if (!fs.existsSync(PERSIST_PATH)) return
        const raw = fs.readFileSync(PERSIST_PATH, 'utf8')
        const obj = JSON.parse(raw)
        let count = 0
        for (const [email, rec] of Object.entries(obj || {})) {
            if (rec && typeof rec.cookieHeader === 'string') {
                accountCookies.set(email, {
                    cookieHeader: rec.cookieHeader,
                    updatedAt: Number(rec.updatedAt) || Date.now(),
                })
                count++
            }
        }
        if (count > 0) {
            logger.success(`loaded ${count} per-account captcha cookies from disk`, 'SSXMOD')
        }
    } catch (e) {
        logger.error(`load captcha-cookies failed: ${e.message}`, 'SSXMOD')
    }
}

// ────────────────────── public API ──────────────────────

function initSsxmodManager() {
    refreshCookies()
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = setInterval(refreshCookies, REFRESH_INTERVAL)
    logger.info(`SSXMOD 管理器已启动，刷新间隔: ${REFRESH_INTERVAL / 1000 / 60} 分钟`, 'SSXMOD')
    _loadFromDisk()
}

function getSsxmodItna() {
    if (process.env.SSXMOD_ITNA_OVERRIDE) return process.env.SSXMOD_ITNA_OVERRIDE
    return currentCookies.ssxmod_itna
}
function getSsxmodItna2() {
    if (process.env.SSXMOD_ITNA2_OVERRIDE) return process.env.SSXMOD_ITNA2_OVERRIDE
    return currentCookies.ssxmod_itna2
}
function getCookies() { return { ...currentCookies } }

/**
 * Build Cookie header for an outbound request.
 * Priority:
 *   1. per-account cookies (account.email is the key)
 *   2. legacy single runtimeCookieOverride
 *   3. process.env.COOKIE_HEADER_OVERRIDE
 *   4. generated SSXMOD-only
 */
function getCookieHeader(account) {
    const email = account && account.email
    if (email && accountCookies.has(email)) {
        return accountCookies.get(email).cookieHeader
    }
    if (runtimeCookieOverride) return runtimeCookieOverride
    if (process.env.COOKIE_HEADER_OVERRIDE) return process.env.COOKIE_HEADER_OVERRIDE
    return `ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`
}

// Per-account setter — used by /api/captcha/_apply
function setAccountCookies(email, cookieHeader) {
    if (!email || typeof cookieHeader !== 'string' || !cookieHeader.length) return false
    accountCookies.set(email, { cookieHeader, updatedAt: Date.now() })
    _scheduleSave()
    return true
}

function clearAccountCookies(email) {
    const had = accountCookies.delete(email)
    if (had) _scheduleSave()
    return had
}

/**
 * Info snapshot — used by /api/captcha/status.
 * Returns either info for one email or a list of all known accounts.
 */
function getAccountCookieInfo(email) {
    if (email) {
        const rec = accountCookies.get(email)
        if (!rec) return null
        const x5sec = _extractCookieValue(rec.cookieHeader, 'x5sec')
        return {
            email,
            length: rec.cookieHeader.length,
            updatedAt: rec.updatedAt,
            ageMs: Date.now() - rec.updatedAt,
            x5secPrefix: x5sec ? x5sec.slice(0, 30) : null,
        }
    }
    const out = []
    for (const [em] of accountCookies.entries()) {
        out.push(getAccountCookieInfo(em))
    }
    return out
}

function _extractCookieValue(header, name) {
    const re = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)
    const m = header.match(re)
    return m ? m[1] : null
}

// ─── legacy single runtime override (backward compat) ───
function setRuntimeCookieOverride(headerValue) {
    runtimeCookieOverride = headerValue || null
    runtimeCookieAppliedAt = headerValue ? Date.now() : null
}

function getRuntimeCookieInfo() {
    if (runtimeCookieOverride) {
        return {
            active: true, source: 'runtime',
            appliedAt: runtimeCookieAppliedAt,
            ageMs: runtimeCookieAppliedAt ? (Date.now() - runtimeCookieAppliedAt) : null,
            length: runtimeCookieOverride.length,
        }
    }
    if (process.env.COOKIE_HEADER_OVERRIDE) {
        return {
            active: true, source: 'env',
            appliedAt: null, ageMs: null,
            length: process.env.COOKIE_HEADER_OVERRIDE.length,
        }
    }
    return { active: false, source: 'generated', appliedAt: null, ageMs: null, length: 0 }
}

function stopRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer)
        refreshTimer = null
        logger.info('SSXMOD 定时刷新已停止', 'SSXMOD')
    }
}

module.exports = {
    initSsxmodManager,
    getSsxmodItna,
    getSsxmodItna2,
    getCookieHeader,
    getCookies,
    refreshCookies,
    stopRefresh,
    // legacy single
    setRuntimeCookieOverride,
    getRuntimeCookieInfo,
    // per-account (step 3)
    setAccountCookies,
    clearAccountCookies,
    getAccountCookieInfo,
}
