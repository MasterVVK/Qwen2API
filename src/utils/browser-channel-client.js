/**
 * Browser-channel delegation. For models that get blocked by the Aliyun WAF during peak
 * hours, route the completion through the UI-driving browser channel (bypass/browser-channel.js)
 * instead of the server-side axios call. The browser issues the real frontend request, so the
 * WAF never challenges it. The novel tool keeps calling this proxy (/v1) unchanged — it just
 * delegates the configured models.
 *
 * Env:
 *   BROWSER_CHANNEL_URL     e.g. http://172.25.0.1:9100  (host gateway, from inside the container)
 *   BROWSER_CHANNEL_MODELS  comma list of model ids to route via the browser, e.g. qwen3.7-max
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { logger } = require('./logger')
const accountManager = require('./account.js')
const { createUsageObject } = require('./precise-tokenizer.js')

// pull the assistant text out of the channel's response so we can estimate tokens for stats.
// stream → concatenate SSE delta.content; non-stream → choices[0].message.content.
function extractAssistantText(body, isStream) {
    try {
        if (isStream) {
            let out = ''
            for (const line of body.split('\n')) {
                const m = line.match(/^data:\s?(.+)$/)
                if (!m || m[1].trim() === '[DONE]') continue
                try { const c = JSON.parse(m[1])?.choices?.[0]?.delta?.content; if (c) out += c } catch (_) {}
            }
            return out
        }
        return JSON.parse(body)?.choices?.[0]?.message?.content || ''
    } catch (_) { return '' }
}

const BC_URL = process.env.BROWSER_CHANNEL_URL || 'http://172.25.0.1:9100'
const BC_MODELS = (process.env.BROWSER_CHANNEL_MODELS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
// image delegation: route /v1/images/generations through the UI-drive channel.
// BROWSER_CHANNEL_IMAGE=true routes ALL image gens; or list specific models in
// BROWSER_CHANNEL_IMAGE_MODELS. Server-side t2i is WAF-blocked, so the channel is the path.
const BC_IMAGE_ALL = /^(1|true|yes|on)$/i.test(String(process.env.BROWSER_CHANNEL_IMAGE || ''))
const BC_IMAGE_MODELS = (process.env.BROWSER_CHANNEL_IMAGE_MODELS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

const useBrowserChannel = model => BC_MODELS.length > 0 && BC_MODELS.includes(String(model || '').toLowerCase())
const useBrowserChannelImage = model => BC_IMAGE_ALL || (BC_IMAGE_MODELS.length > 0 && BC_IMAGE_MODELS.includes(String(model || '').toLowerCase()))

// POST {prompt, ratio} to the channel's /image and resolve {url, width, height}.
// ratio is the qwen aspect string ("16:9", "1:1", ...) or undefined for qwen's default.
function imageViaChannel({ prompt, ratio }) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ prompt: String(prompt || ''), ratio: ratio || undefined })
        const u = new URL(BC_URL + '/image')
        logger.info(`delegating image to browser-channel (ratio=${ratio || 'default'}, ${String(prompt || '').length} chars)`, 'BROWSER')
        const upstream = http.request({
            method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            timeout: 25 * 60 * 1000,
        }, up => {
            let body = ''
            up.on('data', c => body += c)
            up.on('end', () => {
                let json = null
                try { json = JSON.parse(body) } catch (_) {}
                if (up.statusCode >= 400 || !json || !json.url) {
                    const msg = (json && (json.error?.message || json.error)) || `browser-channel image failed (${up.statusCode})`
                    const err = new Error(msg); err.status = (up.statusCode === 400 || up.statusCode === 429) ? up.statusCode : 502
                    return reject(err)
                }
                logger.success(`browser-channel image ${json.width}x${json.height}`, 'BROWSER')
                resolve(json)
            })
        })
        upstream.on('error', e => reject(Object.assign(new Error(e.message), { status: 502 })))
        upstream.on('timeout', () => { upstream.destroy(new Error('browser-channel image timeout')) })
        upstream.write(payload); upstream.end()
    })
}

// The channel reads the image bytes inside chat.qwen.ai, because the bare CDN link can 404 when fetched
// outside the browser (24.11). Such images are served by this proxy from data/generated (route in
// server.js) and pruned after a few days on the next save.
const GENERATED_DIR = path.join(__dirname, '../../data/generated')
const GENERATED_TTL_MS = 3 * 24 * 3600 * 1000
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

function storeChannelImage(img) {
    fs.mkdirSync(GENERATED_DIR, { recursive: true })
    const now = Date.now()
    for (const f of fs.readdirSync(GENERATED_DIR)) {
        const p = path.join(GENERATED_DIR, f)
        if (now - fs.statSync(p).mtimeMs > GENERATED_TTL_MS) fs.rmSync(p, { force: true })
    }
    const name = `${crypto.randomUUID()}.${IMAGE_EXT[img.mime] || 'png'}`
    fs.writeFileSync(path.join(GENERATED_DIR, name), Buffer.from(img.b64, 'base64'))
    return name
}

// Link handed to the caller: our own copy when the channel sent bytes, otherwise the CDN link.
function channelImageUrl(req, img) {
    if (!img.b64) return img.url
    return `${req.protocol}://${req.get('host')}/generated/${storeChannelImage(img)}`
}

// flatten OpenAI/qwen messages into a single prompt string (system + user, in order)
function buildContent(messages) {
    return (messages || []).map(m => {
        const c = m && m.content
        if (typeof c === 'string') return c
        if (Array.isArray(c)) return c.map(p => (p && (p.text || p.content)) || '').join('')
        return ''
    }).filter(s => s && s.trim()).join('\n\n')
}

// POST to the browser channel and relay its response (OpenAI SSE or JSON) straight to res
function delegate(req, res, model) {
    model = model || req.body.requestedModel || req.body.model
    const { stream } = req.body
    const content = buildContent(req.body.messages)
    // honour the no-think variant: proxy computes req.enable_thinking from the model (id=43
    // qwen3.7-max-thinking → true, id=44 qwen3.7-max → false) → drives the Thinking/Fast toggle
    const thinking = req.enable_thinking !== undefined ? !!req.enable_thinking : /thinking/i.test(String(model))
    const payload = JSON.stringify({ model, content, thinking, stream: !!stream })
    const u = new URL(BC_URL + '/complete')
    logger.info(`delegating model ${model} to browser-channel (${content.length} chars)`, 'BROWSER')
    const upstream = http.request({
        method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 25 * 60 * 1000,                 // qwen3.7-max thinks 10-15 min
    }, up => {
        // the channel tells us which pool account handled this (x-pool-email); browser traffic
        // skips the axios path, so attribute estimated token usage here to keep per-account stats
        // (the dashboard) accurate. Tee the response so we can both relay it AND read its text.
        const email = up.headers['x-pool-email'] || ''
        res.writeHead(up.statusCode || 200, { 'Content-Type': up.headers['content-type'] || (stream ? 'text/event-stream' : 'application/json') })
        const bufs = []
        up.on('data', c => { bufs.push(c); res.write(c) })
        up.on('end', () => {
            try { res.end() } catch (_) {}
            logger.success(`browser-channel done for ${model}`, 'BROWSER')
            try {
                if (email && (up.statusCode || 200) < 400) {
                    const outText = extractAssistantText(Buffer.concat(bufs).toString('utf8'), !!stream)
                    const usage = createUsageObject(req.body.messages || content, outText, null)
                    accountManager.accumulateStats(email, 'chat', { input: Number(usage.prompt_tokens) || 0, output: Number(usage.completion_tokens) || 0, requests: 1 })
                    logger.info(`usage → ${email}: ${usage.prompt_tokens}+${usage.completion_tokens} tok (browser)`, 'BROWSER')
                }
            } catch (e) { logger.error(`browser-channel usage attribute failed: ${e.message}`, 'BROWSER') }
        })
    })
    upstream.on('error', e => { logger.error(`browser-channel error: ${e.message}`, 'BROWSER'); if (!res.headersSent) res.status(502).json({ error: { type: 'browser_channel_error', message: e.message } }); else try { res.end() } catch (_) {} })
    upstream.on('timeout', () => { upstream.destroy(new Error('browser-channel timeout')) })
    upstream.write(payload); upstream.end()
}

module.exports = { useBrowserChannel, delegate, useBrowserChannelImage, imageViaChannel, channelImageUrl, GENERATED_DIR }
