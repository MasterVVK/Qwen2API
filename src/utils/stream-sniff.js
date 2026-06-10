const { PassThrough } = require('stream')
const { detectBlock } = require('./captcha-trigger')

/**
 * Read ahead up to 4KB from an upstream stream to determine if it's a WAF block.
 * If a block is detected, returns { block, restoredStream: null } and drains the
 * source. If clean, returns { block: null, restoredStream } — a new readable that
 * replays the sniffed bytes followed by the rest of the original stream.
 *
 * Kept dependency-free (only stream + detectBlock) so it stays unit-testable
 * without pulling in the account-manager side effects of request.js.
 */
function sniffOrRestore(stream, opts = {}) {
    const maxBytes = opts.maxBytes || 4096
    const timeoutMs = opts.timeoutMs || 5000
    return new Promise((resolve) => {
        const chunks = []
        let total = 0
        let done = false
        let upstreamEnded = false
        const finalize = (block) => {
            if (done) return
            done = true
            clearTimeout(timer)
            stream.removeListener('data', onData)
            stream.removeListener('end', onEnd)
            stream.removeListener('error', onErr)
            if (block) {
                stream.resume()
                resolve({ block, restoredStream: null })
            } else {
                const restored = new PassThrough()
                for (const c of chunks) restored.write(c)
                if (upstreamEnded) {
                    // upstream already finished — no more data is coming
                    restored.end()
                } else {
                    stream.on('data', c => restored.write(c))
                    stream.on('end', () => restored.end())
                    stream.on('error', err => restored.destroy(err))
                }
                resolve({ block: null, restoredStream: restored })
            }
        }
        const onData = c => {
            chunks.push(c); total += c.length
            if (total >= maxBytes) {
                const text = Buffer.concat(chunks).toString('utf8').slice(0, maxBytes)
                finalize(detectBlock(text))
            }
        }
        const onEnd = () => {
            upstreamEnded = true
            const text = Buffer.concat(chunks).toString('utf8')
            finalize(detectBlock(text))
        }
        const onErr = () => finalize(null)
        const timer = setTimeout(() => {
            // Took too long — assume not a block, restore stream as-is
            finalize(null)
        }, timeoutMs)
        stream.on('data', onData)
        stream.on('end', onEnd)
        stream.on('error', onErr)
    })
}

module.exports = { sniffOrRestore }
