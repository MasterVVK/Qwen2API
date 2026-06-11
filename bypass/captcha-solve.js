/**
 * captcha-solve — auto-solve the Aliyun WAF "Access Verification" slider that appears
 * IN the chrome-solver browser session. Reuses the proven stack: real RTX 3090 (NVIDIA
 * webgl), real xdotool (XTEST) input on :1, brightness gap detection, and a curve-based
 * closed-loop drag. Operates on whatever captcha is currently rendered on the page (no
 * navigation), so the browser-channel can clear the WAF mid-session and continue.
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const { detectGap } = require('./gap-detect')

const CTR = process.env.SOLVER_CTR || 'qwen2api-chrome-solver'
const DISP = ':1'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const xdo = cmd => { try { return execFileSync('docker', ['exec', '-e', `DISPLAY=${DISP}`, CTR, 'sh', '-c', cmd], { stdio: 'pipe' }).toString() } catch (e) { return '' } }

// deterministic non-linear mouse-offset → piece-x calibration curve (Aliyun 300px UI)
const CURVE = [[0, 0], [40, 9], [90, 36], [140, 80], [190, 143], [240, 223], [262, 248]]
const invert = pt => { for (let i = 1; i < CURVE.length; i++) { const [o0, p0] = CURVE[i - 1], [o1, p1] = CURVE[i]; if (pt <= p1) return o0 + (pt - p0) * (o1 - o0) / (p1 - p0) } return CURVE[CURVE.length - 1][0] }

async function isCaptcha(client) {
    // Detects BOTH variants: the in-page slider modal AND the Aliyun baxia challenge that
    // loads in an iframe (overlay `baxia-dialog`, iframe src .../_____tmd_____/) when a
    // completion request is flagged. Only counts a VISIBLE dialog (after solving it goes
    // display:none, width 0).
    const r = await client.Runtime.evaluate({ returnByValue: true, expression: `(() => {
        if (document.querySelector('#aliyunCaptcha-sliding-slider')) return true;
        if (/Access Verification|访问验证/.test((document.body&&document.body.innerText)||'')) return true;
        const bx = document.querySelector('[class*=baxia-dialog]');
        if (bx && bx.getBoundingClientRect().width > 40) return true;
        const cf = [...document.querySelectorAll('iframe')].find(f => /_tmd_|baxia|captcha/i.test(f.src||''));
        if (cf && cf.getBoundingClientRect().width > 40) return true;
        return false;
    })()` })
    return !!r.result.value
}

// solve the captcha currently on the page once; returns true if it passed (captcha gone)
async function solveOnce(client, log = () => {}) {
    const { Runtime } = client
    // wait for the slider + image to be present
    let ready = false
    for (let i = 0; i < 30; i++) { if ((await Runtime.evaluate({ returnByValue: true, expression: `!!document.querySelector('#aliyunCaptcha-puzzle') && !!document.querySelector('#aliyunCaptcha-sliding-slider') && !!document.querySelector('#aliyunCaptcha-img')` })).result.value) { ready = true; break } await sleep(500) }
    if (!ready) return false
    await sleep(700)

    // geometry + images
    const geo = (await Runtime.evaluate({ returnByValue: true, expression: `(() => { const r=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}}; const sl=document.querySelector('#aliyunCaptcha-sliding-slider'); return { slider:r(sl), dpr:window.devicePixelRatio }; })()` })).result.value
    // grab the bg + piece bytes as base64 — works whether the <img> src is a data: URL
    // or an Aliyun CDN http URL (fetched in-page, same captcha origin context)
    const grab = async sel => (await Runtime.evaluate({ returnByValue: true, awaitPromise: true, expression: `(async () => {
        const el = document.querySelector('${sel}'); if (!el || !el.src) return null;
        if (/^data:.*,/.test(el.src)) return el.src.split(',')[1];
        try { const r = await fetch(el.src); const u = new Uint8Array(await r.arrayBuffer()); let s=''; for (let i=0;i<u.length;i++) s+=String.fromCharCode(u[i]); return btoa(s); } catch(e) { return null; }
    })()` })).result.value
    const bgB64 = await grab('#aliyunCaptcha-img'), pcB64 = await grab('#aliyunCaptcha-puzzle')
    if (!bgB64 || !pcB64) { log('images not ready'); return false }
    fs.writeFileSync('/tmp/cs-bg.png', Buffer.from(bgB64, 'base64'))
    fs.writeFileSync('/tmp/cs-pc.png', Buffer.from(pcB64, 'base64'))
    const det = detectGap('/tmp/cs-bg.png', '/tmp/cs-pc.png')
    const gapX = det.gapX
    log(`gap=${gapX} (b=${det.methodA} t=${det.methodB})`)

    // focus the content window (no WM_CLASS) and measure screen→css offset via a probe
    let offX = 0, offY = 0, ok = false
    await Runtime.evaluate({ expression: `window.__le=null;document.onmousemove=e=>{window.__le=[Math.round(e.clientX),Math.round(e.clientY)]}` })
    for (let i = 0; i < 10 && !ok; i++) {
        const py = 220 + i * 20
        const loc = xdo(`xdotool mousemove 500 ${py}; xdotool getmouselocation --shell 2>/dev/null`)
        const m = loc.match(/WINDOW=(\d+)/)
        if (m) xdo(`xdotool windowfocus ${m[1]} 2>/dev/null; xdotool windowactivate ${m[1]} 2>/dev/null; true`)
        await sleep(250)
        xdo(`xdotool mousemove 501 ${py + 1}`); await sleep(180)
        const p = (await Runtime.evaluate({ returnByValue: true, expression: `window.__le` })).result.value
        if (p) { offX = 501 - p[0]; offY = (py + 1) - p[1]; ok = true }
    }
    if (!ok) { log('focus failed'); return false }
    const sX = geo.slider.x + geo.slider.w / 2 + offX
    const sY = geo.slider.y + geo.slider.h / 2 + offY
    const readPiece = async () => (await Runtime.evaluate({ returnByValue: true, expression: `(() => { const p=document.querySelector('#aliyunCaptcha-puzzle'), i=document.querySelector('#aliyunCaptcha-img'); return (p&&i)?(p.getBoundingClientRect().x - i.getBoundingClientRect().x):null; })()` })).result.value

    // press, smooth coarse approach, curve-based closed-loop fine settle (real XTEST input)
    xdo(`xdotool mousemove ${Math.round(sX)} ${Math.round(sY)}`); await sleep(160 + Math.random() * 120)
    xdo(`xdotool mousedown 1`); await sleep(110 + Math.random() * 100)
    const coarse = invert(gapX) * 0.85
    const N = Math.round((650 + Math.random() * 250) / 13), seq = []
    for (let i = 1; i <= N; i++) { const t = i / N, p = 1 - Math.pow(1 - t, 2.2); const y = sY + Math.sin(t * Math.PI) * 2 + (Math.random() - 0.5) * 1.3; seq.push(`xdotool mousemove ${Math.round(sX + coarse * p)} ${Math.round(y)}`); seq.push(`sleep ${(0.009 + Math.random() * 0.009).toFixed(3)}`) }
    xdo(seq.join('\n'))
    let curX = sX + coarse
    await sleep(120 + Math.random() * 80)
    for (let it = 0; it < 5; it++) {
        const pc = await readPiece(); if (pc == null) break
        const remain = gapX - pc
        if (Math.abs(remain) <= 2) break
        const md = (invert(gapX) - invert(pc)) * 0.92
        const steps = 6 + Math.floor(Math.random() * 4), x0 = curX, seq2 = []
        for (let i = 1; i <= steps; i++) { const t = i / steps, p = 1 - Math.pow(1 - t, 2); seq2.push(`xdotool mousemove ${Math.round(x0 + md * p)} ${Math.round(sY + (Math.random() - 0.5))}`); seq2.push(`sleep ${(0.012 + Math.random() * 0.013).toFixed(3)}`) }
        xdo(seq2.join('\n')); curX = x0 + md
        await sleep(170 + Math.random() * 130)
    }
    await sleep(240 + Math.random() * 240)
    xdo(`xdotool mouseup 1`)

    // success = the captcha is gone within a few seconds
    for (let i = 0; i < 6; i++) { if (!(await isCaptcha(client))) return true; await sleep(1200) }
    return false
}

// solve with retries (the captcha refreshes a new image on each failed drag)
async function solve(client, opts = {}) {
    const maxTries = opts.maxTries || 20
    const log = opts.log || (() => {})
    for (let i = 0; i < maxTries; i++) {
        if (!(await isCaptcha(client))) return true
        log(`attempt ${i + 1}/${maxTries}`)
        try { if (await solveOnce(client, log)) { log('PASSED'); return true } }
        catch (e) { log('attempt error: ' + e.message) }
        await sleep(1500)
    }
    return !(await isCaptcha(client))
}

module.exports = { isCaptcha, solveOnce, solve }
