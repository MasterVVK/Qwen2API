/**
 * Single source of truth for the headers we send to chat.qwen.ai.
 *
 * These mimic the official Qwen web client (User-Agent, sec-ch-ua, Version,
 * bx-v, Timezone, …) and act as a request fingerprint. Keeping them in one
 * place means the chat, generate-id and image/video paths can never drift
 * apart — and if the upstream client bumps a value, it's a one-line change.
 *
 * @param {object} opts
 * @param {string} opts.token        - account JWT (Bearer)
 * @param {string} opts.chatBaseUrl  - upstream base, used for Origin/Referer
 * @param {string} [opts.cookieHeader] - Cookie header; set only when truthy
 * @param {string} [opts.accept='application/json'] - Accept header
 */
function buildUpstreamHeaders({ token, chatBaseUrl, cookieHeader, accept = 'application/json' }) {
    return {
        'Authorization': `Bearer ${token}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        "Connection": "keep-alive",
        "Accept": accept,
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Content-Type": "application/json",
        "Timezone": "Mon Dec 08 2025 17:28:55 GMT+0800",
        "sec-ch-ua": "\"Microsoft Edge\";v=\"143\", \"Chromium\";v=\"143\", \"Not A(Brand\";v=\"24\"",
        "source": "web",
        "Version": "0.1.13",
        "bx-v": "2.5.31",
        "Origin": chatBaseUrl,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Referer": `${chatBaseUrl}/c/guest`,
        "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        ...(cookieHeader ? { "Cookie": cookieHeader } : {}),
    }
}

module.exports = { buildUpstreamHeaders }
