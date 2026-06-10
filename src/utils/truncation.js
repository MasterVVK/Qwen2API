/**
 * Detect a truncated thinking response (upstream Qwen has a hard cap on
 * completion tokens; thinking-mode sometimes spends the whole budget on
 * reasoning and returns an unclosed <think> block with finish_reason='stop').
 * Returns null if content looks complete, or { reason } describing the issue.
 *
 * Heuristics:
 *   - <think> opened but no </think> at all
 *   - <think> appears after the last </think> (second thinking section
 *     started but never closed)
 *
 * Kept in its own module so it stays unit-testable without pulling in the
 * account-manager side effects of the chat controller.
 */
const detectTruncation = (content) => {
    if (typeof content !== 'string' || !content) return null
    const lastOpen = content.lastIndexOf('<think>')
    if (lastOpen === -1) return null
    const lastClose = content.lastIndexOf('</think>')
    if (lastClose === -1 || lastClose < lastOpen) {
        return { reason: 'thinking_truncated' }
    }
    return null
}

module.exports = { detectTruncation }
