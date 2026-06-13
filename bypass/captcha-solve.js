/**
 * captcha-solve — auto-solve the Aliyun WAF slider that appears IN the chrome-solver browser
 * session. Two render variants:
 *   (a) in-page modal — `#aliyunCaptcha-*` live in the main document;
 *   (b) baxia challenge — same `#aliyunCaptcha-*` slider, but inside a SAME-ORIGIN iframe
 *       (overlay `baxia-dialog`, iframe src .../_____tmd_____/). Reached via
 *       `iframe.contentDocument` (same origin → no Runtime.enable, no cross-origin block);
 *       on-screen coords add the iframe's page offset.
 * Reuses the proven stack: real RTX 3090 webgl, real xdotool (XTEST) input on :1, brightness
 * gap detection, curve-based closed-loop drag. Operates on whatever captcha is rendered (no
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

// in-page resolver: returns {d: captcha root document, fx,fy: its page offset}. Looks in the
// main document first, then any same-origin iframe that contains the slider.
const CR = `(()=>{let d=document,fx=0,fy=0;if(!document.querySelector('#aliyunCaptcha-sliding-slider')){for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument&&f.contentDocument.querySelector('#aliyunCaptcha-sliding-slider')){d=f.contentDocument;const r=f.getBoundingClientRect();fx=r.x;fy=r.y;break;}}catch(e){}}}return{d:d,fx:fx,fy:fy};})()`
const evJSON = (client, body) => client.Runtime.evaluate({ returnByValue: true, expression: `(()=>{const c=${CR};${body}})()` }).then(r => r.result.value)
const evAsync = (client, body) => client.Runtime.evaluate({ returnByValue: true, awaitPromise: true, expression: `(async()=>{const c=${CR};${body}})()` }).then(r => r.result.value)

async function isCaptcha(client) {
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

// nc_ "slide to verify" variant (Aliyun NoCaptcha): no puzzle/gap — just drag the handle
// (.btn_slide / #nc_*_n1z) all the way right across the track (.nc_scale). Behaviourally
// checked, so we use a real synced xdotool drag (ease-in-out + tremor). Lives in a same-origin
// iframe; screen coords add the iframe page offset.
async function solveNc(client, offset, log) {
    const g = await client.Runtime.evaluate({ returnByValue: true, expression: `(()=>{for(const f of document.querySelectorAll('iframe')){try{const d=f.contentDocument;const h=d&&d.querySelector('.btn_slide,[id$=n1z]');const tr=d&&d.querySelector('.nc_scale,[id$=n1t]');if(h&&tr){const fr=f.getBoundingClientRect(),hb=h.getBoundingClientRect(),tb=tr.getBoundingClientRect();return{cx:Math.round(fr.x+hb.x+hb.width/2),cy:Math.round(fr.y+hb.y+hb.height/2),dist:Math.round(tb.width-hb.width-2)};}}catch(e){}}return null;})()` }).then(r => r.result.value)
    if (!g) { log('nc_ geometry not ready'); return false }
    const off = offset || { x: 0, y: 87 }
    const sX = g.cx + off.x, sY = g.cy + off.y, dist = g.dist
    log(`nc_ slide: from ${sX},${sY} +${dist}`)
    let cmd = `xdotool mousemove ${sX} ${sY}; sleep 0.4; xdotool mousedown 1; sleep 0.5;`
    const N = 28
    for (let i = 1; i <= N; i++) {
        const t = i / N
        const p = t < 0.6 ? Math.pow(t / 0.6, 2) * 0.86 : 0.86 + (1 - Math.pow((1 - t) / 0.4, 2)) * 0.14
        const x = Math.round(sX + dist * Math.min(p, 1.04))
        const y = Math.round(sY + Math.sin(t * Math.PI) * 1.4 + (i % 3 - 1) * 0.7)
        cmd += `xdotool mousemove --sync ${x} ${y}; sleep 0.01${3 + (i % 6)};`
    }
    cmd += `xdotool mousemove --sync ${Math.round(sX + dist)} ${sY}; sleep 0.25; xdotool mouseup 1`
    xdo(cmd)
    for (let i = 0; i < 6; i++) { if (!(await isCaptcha(client))) return true; await sleep(1200) }
    return false
}

// When the challenge has TIMED OUT it shows "Please click me to try again (error:...)" with
// NO slider. Clicking it reloads a fresh challenge (and often clears the WAF outright). Returns
// true if it clicked something (caller should then re-check / retry).
async function clickTryAgain(client, offset, log) {
    const r = await client.Runtime.evaluate({ returnByValue: true, expression: `(()=>{for(const f of document.querySelectorAll('iframe')){try{const d=f.contentDocument;if(!d)continue;const e=[...d.querySelectorAll('a,span,div,button')].find(x=>/try again|click me|重试|刷新|点击/i.test(x.textContent)&&x.getBoundingClientRect().width>0&&x.getBoundingClientRect().width<400&&x.getBoundingClientRect().height<60);if(e){const fr=f.getBoundingClientRect(),b=e.getBoundingClientRect();return [Math.round(fr.x+b.x+b.width/2),Math.round(fr.y+b.y+b.height/2)];}}catch(e){}}return null;})()` }).then(r => r.result.value)
    if (!r) return false
    const off = offset || { x: 0, y: 87 }
    log('captcha timed out → clicking "try again" for a fresh challenge')
    xdo(`xdotool mousemove ${r[0] + off.x} ${r[1] + off.y}; sleep 0.2; xdotool click 1`)
    await sleep(3000)
    return true
}

// solve the captcha currently on the page once; returns true if it passed (captcha gone).
// offset {x,y} = screen→css offset (pass the browser-channel's measured value to avoid a
// probe that would land over the iframe and not fire the main document's mousemove).
async function solveOnce(client, log = () => {}, offset = null) {
    // nc_ "slide to verify" variant? (different from the FeiLin puzzle below)
    const isNc = await client.Runtime.evaluate({ returnByValue: true, expression: `(()=>{for(const f of document.querySelectorAll('iframe')){try{if(f.contentDocument&&f.contentDocument.querySelector('.btn_slide,[id$=n1z]'))return true;}catch(e){}}return false;})()` }).then(r => r.result.value)
    if (isNc) { log('variant: nc_ slide'); return solveNc(client, offset, log) }
    // timed-out error state ("Please click me to try again")? reload for a fresh slider, then retry
    if (await clickTryAgain(client, offset, log)) return false
    // wait for the slider + image (in whichever document)
    let ready = false
    for (let i = 0; i < 30; i++) { if (await evJSON(client, `return !!c.d.querySelector('#aliyunCaptcha-puzzle') && !!c.d.querySelector('#aliyunCaptcha-sliding-slider') && !!c.d.querySelector('#aliyunCaptcha-img');`)) { ready = true; break } await sleep(500) }
    if (!ready) { log('slider not found (main or iframe)'); return false }
    await sleep(700)

    // geometry (page-relative: iframe offset folded in) + images
    const geo = await evJSON(client, `const r=e=>{const b=e.getBoundingClientRect();return {x:b.x+c.fx,y:b.y+c.fy,w:b.width,h:b.height}}; const sl=c.d.querySelector('#aliyunCaptcha-sliding-slider'); return { slider:r(sl) };`)
    const grab = sel => evAsync(client, `const el=c.d.querySelector('${sel}'); if(!el||!el.src) return null; if(/^data:.*,/.test(el.src)) return el.src.split(',')[1]; try{const r=await fetch(el.src); const u=new Uint8Array(await r.arrayBuffer()); let s=''; for(let i=0;i<u.length;i++) s+=String.fromCharCode(u[i]); return btoa(s);}catch(e){return null;}`)
    const bgB64 = await grab('#aliyunCaptcha-img'), pcB64 = await grab('#aliyunCaptcha-puzzle')
    if (!bgB64 || !pcB64) { log('images not ready'); return false }
    fs.writeFileSync('/tmp/cs-bg.png', Buffer.from(bgB64, 'base64'))
    fs.writeFileSync('/tmp/cs-pc.png', Buffer.from(pcB64, 'base64'))
    const det = detectGap('/tmp/cs-bg.png', '/tmp/cs-pc.png')
    const gapX = det.gapX
    log(`gap=${gapX} (b=${det.methodA} t=${det.methodB})`)

    // screen→css offset: use the one passed in; else probe at a main-page point (top-left
    // strip, away from the centred captcha dialog) so the MAIN document's mousemove fires.
    let offX = 0, offY = 0
    if (offset) { offX = offset.x; offY = offset.y }
    else {
        await client.Runtime.evaluate({ expression: `window.__le=null;document.onmousemove=e=>{window.__le=[Math.round(e.clientX),Math.round(e.clientY)]}` })
        let ok = false
        for (let i = 0; i < 10 && !ok; i++) {
            const px = 30 + i * 10
            const loc = xdo(`xdotool mousemove ${px} 130; xdotool getmouselocation --shell 2>/dev/null`)
            const m = loc.match(/WINDOW=(\d+)/)
            if (m) xdo(`xdotool windowfocus ${m[1]} 2>/dev/null; xdotool windowactivate ${m[1]} 2>/dev/null; true`)
            await sleep(250)
            xdo(`xdotool mousemove ${px + 1} 131`); await sleep(180)
            const p = (await client.Runtime.evaluate({ returnByValue: true, expression: `window.__le` })).result.value
            if (p) { offX = (px + 1) - p[0]; offY = 131 - p[1]; ok = true }
        }
        if (!ok) { offX = 0; offY = 87 }   // known default for this maximised window
    }
    const sX = geo.slider.x + geo.slider.w / 2 + offX
    const sY = geo.slider.y + geo.slider.h / 2 + offY
    const readPiece = () => evJSON(client, `const p=c.d.querySelector('#aliyunCaptcha-puzzle'), i=c.d.querySelector('#aliyunCaptcha-img'); return (p&&i)?(p.getBoundingClientRect().x - i.getBoundingClientRect().x):null;`)

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
        try { if (await solveOnce(client, log, opts.offset)) { log('PASSED'); return true } }
        catch (e) { log('attempt error: ' + e.message) }
        await sleep(1500)
    }
    return !(await isCaptcha(client))
}

module.exports = { isCaptcha, solveOnce, solve }
