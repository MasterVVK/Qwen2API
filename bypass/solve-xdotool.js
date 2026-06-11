#!/usr/bin/env node
/**
 * HTML-variant captcha solver using REAL X input (xdotool) instead of CDP mouse
 * events — defeats Aliyun's behavioral check that flags CDP-synthetic trajectories
 * (wrong screenX/movementX). CDP is used only to read the page (navigate, gap
 * image, geometry, x5sec). The drag is performed by the real cursor via xdotool
 * on a headful chromium running on Xvfb :95 inside the host-networked container.
 *
 * Usage: node solve-xdotool.js <email>
 */
const { execFileSync, execSync } = require('child_process')
const CDP = require('chrome-remote-interface')
const fs = require('fs')
const { detectGap } = require('./gap-detect')

const CTR = 'qwen2api-chrome-solver'    // dedicated linuxserver chromium: real RTX 3090 + working X input on :1
const DISP = ':1'
const DBG = 9561                        // the container's own chromium debug port (CHROME_CLI)
const PORT = 9563                       // host-reachable via socat bridge
const QWEN_API = 'http://127.0.0.1:3001'
const QWEN_KEY = 'sk-123456'
const EMAIL = process.argv[2] || 'qwen@2140101.ru'
const API_URL = 'https://chat.qwen.ai/api/v2/chat/completions?chat_id=00000000-0000-0000-0000-000000000000'
const sleep = ms => new Promise(r => setTimeout(r, ms))

// mouse-offset → piece-x calibration curve (deterministic for the Aliyun 300px UI)
const CURVE = [[0, 0], [40, 9], [90, 36], [140, 80], [190, 143], [240, 223], [262, 248]]
const invert = pt => { for (let i = 1; i < CURVE.length; i++) { const [o0, p0] = CURVE[i - 1], [o1, p1] = CURVE[i]; if (pt <= p1) return o0 + (pt - p0) * (o1 - o0) / (p1 - p0) } return CURVE[CURVE.length - 1][0] }

function http(url, opts = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url); const lib = require(u.protocol === 'https:' ? 'https' : 'http')
        const req = lib.request({ method: opts.method || 'GET', hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: opts.headers || {}, timeout: 15000 },
            res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() })) })
        req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); if (opts.body) req.write(opts.body); req.end()
    })
}
const xdo = cmd => execFileSync('docker', ['exec', '-e', `DISPLAY=${DISP}`, CTR, 'sh', '-c', cmd], { stdio: 'pipe' }).toString()

async function getAccount(email) {
    const r = await http(`${QWEN_API}/api/getAllAccounts`, { headers: { Authorization: `Bearer ${QWEN_KEY}` } })
    const list = JSON.parse(r.body); const arr = Array.isArray(list) ? list : (list.data || list.accounts || [])
    const a = arr.find(x => x.email === email); if (!a) throw new Error('account not found'); return { token: a.token, proxy: a.proxy || null }
}

async function main() {
    const { token, proxy } = await getAccount(EMAIL)
    console.log(`account=${EMAIL} proxy=${proxy || '(host)'}`)

    // Use the container's own chromium (CHROME_CLI on :1 — real GPU + working X input,
    // proxy baked in). Just ensure the socat CDP bridge is up, then drive it via CDP.
    void proxy
    try { execFileSync('docker', ['exec', CTR, 'sh', '-c', `pkill -f 'TCP-LISTEN:${PORT}' 2>/dev/null; true`], { stdio: 'pipe' }) } catch (e) {}
    await sleep(600)
    execFileSync('docker', ['exec', '-d', CTR, 'sh', '-c', `socat TCP-LISTEN:${PORT},fork,reuseaddr TCP:127.0.0.1:${DBG} 2>/dev/null`], { stdio: 'pipe' })
    for (let i = 0; i < 40; i++) { try { const v = await http(`http://127.0.0.1:${PORT}/json/version`, { timeout: 1000 }); if (v.status === 200) break } catch (e) {} await sleep(300) }

    const client = await CDP({ host: '127.0.0.1', port: PORT })
    const { Network, Page, Runtime } = client
    await Network.enable(); await Page.enable()
    if (process.env.DBG) {
        await Runtime.enable()
        Runtime.consoleAPICalled(p => { try {
            const s = p.args.map(a => a.value !== undefined ? JSON.stringify(a.value) : (a.preview ? JSON.stringify((a.preview.properties || []).reduce((o, pr) => (o[pr.name] = pr.value, o), {})) : '')).join(' ')
            if (/verif|F0\d\d|success|risk|code/i.test(s)) console.log(`  captcha→ ${s.slice(0, 220)}`)
        } catch (e) {} })
    }
    // clear only the Aliyun WAF verification cookie so we face a fresh challenge,
    // but keep the rest of the session (clearing everything makes the captcha unsolvable)
    try { for (const n of ['x5sec', 'acw_tc', 'acw_sc__v2']) await Network.deleteCookies({ name: n, domain: '.qwen.ai' }).catch(() => {}) } catch (e) {}
    await Network.setCookie({ domain: 'chat.qwen.ai', name: 'token', value: token, path: '/', secure: true, sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 86400 })
    await Page.navigate({ url: API_URL })

    // wait for captcha render
    let ready = false
    for (let i = 0; i < 40; i++) {
        const r = await Runtime.evaluate({ returnByValue: true, expression: `!!document.querySelector('#aliyunCaptcha-puzzle') && !!document.querySelector('#aliyunCaptcha-sliding-slider')` })
        if (r.result.value) { ready = true; break }
        await sleep(500)
    }
    if (!ready) { console.log('captcha did not render'); await client.close(); return }
    await sleep(800)

    // geometry + DPR
    const geo = (await Runtime.evaluate({ returnByValue: true, expression: `(() => {
        const r = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
        const img = document.querySelector('#aliyunCaptcha-img'), sl = document.querySelector('#aliyunCaptcha-sliding-slider');
        return { dpr: window.devicePixelRatio, img: r(img), slider: r(sl) };
    })()` })).result.value
    // save bg + piece for gap detection
    const imgs = (await Runtime.evaluate({ returnByValue: true, expression: `(() => { const b=document.querySelector('#aliyunCaptcha-img'), p=document.querySelector('#aliyunCaptcha-puzzle'); return { bg:b&&b.src, pc:p&&p.src }; })()` })).result.value
    fs.writeFileSync('/tmp/xb.png', Buffer.from(imgs.bg.split(',')[1], 'base64'))
    fs.writeFileSync('/tmp/xp.png', Buffer.from(imgs.pc.split(',')[1], 'base64'))
    const det = detectGap('/tmp/xb.png', '/tmp/xp.png')
    const gapX = det.gapX
    console.log(`dpr=${geo.dpr} slider@(${geo.slider.x.toFixed(0)},${geo.slider.y.toFixed(0)}) gapX=${gapX} (b=${det.methodA} t=${det.methodB})`)

    const readPiece = async () => (await Runtime.evaluate({ returnByValue: true, expression: `(() => { const p=document.querySelector('#aliyunCaptcha-puzzle'), i=document.querySelector('#aliyunCaptcha-img'); return (p&&i)?(p.getBoundingClientRect().x - i.getBoundingClientRect().x):null; })()` })).result.value

    // The headful kiosk window is NOT at screen (0,0) and only receives X input
    // once activated. Focus the content window, then measure the screen→CSS offset
    // by probing one real pointer event (xdotool moves the real cursor; the page
    // records where it landed in client coords).
    // Measure the viewport→screen offset by probing a real pointer event (input works
    // reliably on this container's :1). Focus the window under the cursor, then read
    // where a known screen point lands in client coords.
    let offX = 0, offY = 0, okOff = false, wm = null
    for (let i = 0; i < 10 && !okOff; i++) {
        const py = 220 + i * 20
        const loc = xdo(`xdotool mousemove 500 ${py}; xdotool getmouselocation --shell 2>/dev/null`)
        const m = loc.match(/WINDOW=(\d+)/)
        if (m) { wm = m[1]; xdo(`xdotool windowfocus ${wm} 2>/dev/null; xdotool windowactivate ${wm} 2>/dev/null; true`) }
        await sleep(250)
        await Runtime.evaluate({ expression: `window.__le=null;document.onmousemove=e=>{window.__le=[Math.round(e.clientX),Math.round(e.clientY)]}` })
        xdo(`xdotool mousemove 501 ${py + 1}`); await sleep(180)
        const p = (await Runtime.evaluate({ returnByValue: true, expression: `window.__le` })).result.value
        if (p) { offX = 501 - p[0]; offY = (py + 1) - p[1]; okOff = true }
    }
    if (!okOff) { console.log('FOCUS FAILED — window not receiving X input'); await client.close(); return }
    const sX = geo.slider.x + geo.slider.w / 2 + offX
    const sY = geo.slider.y + geo.slider.h / 2 + offY
    console.log(`offset=(${offX},${offY}) slider screen=(${Math.round(sX)},${Math.round(sY)}) win=${wm}`)

    // press at slider (real hardware input via XTEST)
    xdo(`xdotool mousemove ${Math.round(sX)} ${Math.round(sY)}`); await sleep(160 + Math.random() * 120)
    xdo(`xdotool mousedown 1`); await sleep(110 + Math.random() * 100)
    // phase 1: ONE smooth real-input approach to ~85% of an estimated distance
    const coarse = invert(gapX) * 0.85
    const N = Math.round((650 + Math.random() * 250) / 13)
    const seq = []
    for (let i = 1; i <= N; i++) { const t = i / N, p = 1 - Math.pow(1 - t, 2.2); const y = sY + Math.sin(t * Math.PI) * 2 + (Math.random() - 0.5) * 1.3; seq.push(`xdotool mousemove ${Math.round(sX + coarse * p)} ${Math.round(y)}`); seq.push(`sleep ${(0.009 + Math.random() * 0.009).toFixed(3)}`) }
    xdo(seq.join('\n'))
    let curX = sX + coarse
    await sleep(120 + Math.random() * 80)
    // calibrate the real mouse→piece ratio from the coarse glide, then converge with
    // a few SMOOTH undershoot glides (human pause-and-adjust) — no per-pixel stutter.
    if (process.env.DBG) console.log(`  after coarse: piece=${(await readPiece())?.toFixed(0)}`)
    for (let it = 0; it < 5; it++) {
        const pc = await readPiece(); if (pc == null) break
        const remain = gapX - pc
        if (Math.abs(remain) <= 2) break
        // exact mouse delta from the (verified) calibration curve, slight undershoot
        const md = (invert(gapX) - invert(pc)) * 0.92
        const steps = 6 + Math.floor(Math.random() * 4)
        const x0 = curX, seq2 = []
        for (let i = 1; i <= steps; i++) { const t = i / steps, p = 1 - Math.pow(1 - t, 2); seq2.push(`xdotool mousemove ${Math.round(x0 + md * p)} ${Math.round(sY + (Math.random() - 0.5))}`); seq2.push(`sleep ${(0.012 + Math.random() * 0.013).toFixed(3)}`) }
        xdo(seq2.join('\n')); curX = x0 + md
        await sleep(170 + Math.random() * 130)    // human pause to verify before next nudge
    }
    await sleep(240 + Math.random() * 240)        // human hold before release
    xdo(`xdotool mouseup 1`)

    // read where the piece landed + x5sec
    await sleep(800)
    const pieceX = Math.round(await readPiece())
    console.log(`landed pieceX=${pieceX} (target ${gapX})`)
    let x5 = null, passed = false
    for (let i = 0; i < 8; i++) {
        const { cookies } = await Network.getAllCookies()
        const c = cookies.find(c => c.name === 'x5sec')
        if (c) x5 = c.value
        // success = the Aliyun captcha page is gone (navigated to the real API response)
        const stillCaptcha = (await Runtime.evaluate({ returnByValue: true, expression: `!!document.querySelector('#aliyunCaptcha-sliding-slider') || /Access Verification/.test(document.body&&document.body.innerText||'')` })).result.value
        if (!stillCaptcha) { passed = true; break }
        if (x5) break
        await sleep(1200)
    }
    const after = (await Runtime.evaluate({ returnByValue: true, expression: `(document.body&&document.body.innerText||'').slice(0,70)` })).result.value
    console.log(`RESULT: ${passed || x5 ? '✅ PASSED' : '❌ failed'} x5sec=${x5 ? x5.slice(0, 28) : 'none'} | after="${after.replace(/\s+/g, ' ').trim()}"`)
    await client.close()
    return { ok: passed || !!x5, x5sec: x5 }
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
