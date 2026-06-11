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
const { logger } = require('./logger')

const BC_URL = process.env.BROWSER_CHANNEL_URL || 'http://172.25.0.1:9100'
const BC_MODELS = (process.env.BROWSER_CHANNEL_MODELS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

const useBrowserChannel = model => BC_MODELS.length > 0 && BC_MODELS.includes(String(model || '').toLowerCase())

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
        res.writeHead(up.statusCode || 200, { 'Content-Type': up.headers['content-type'] || (stream ? 'text/event-stream' : 'application/json') })
        up.pipe(res)
        up.on('end', () => logger.success(`browser-channel done for ${model}`, 'BROWSER'))
    })
    upstream.on('error', e => { logger.error(`browser-channel error: ${e.message}`, 'BROWSER'); if (!res.headersSent) res.status(502).json({ error: { type: 'browser_channel_error', message: e.message } }); else try { res.end() } catch (_) {} })
    upstream.on('timeout', () => { upstream.destroy(new Error('browser-channel timeout')) })
    upstream.write(payload); upstream.end()
}

module.exports = { useBrowserChannel, delegate }
