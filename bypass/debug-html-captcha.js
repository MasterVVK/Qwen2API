#!/usr/bin/env node
/**
 * Diagnostic: spawn a headless chromium for an account through its proxy,
 * navigate to the WAF-protected API endpoint (which triggers the Aliyun
 * HTML captcha), and instrument EVERYTHING — network requests/responses,
 * failed loads, console messages, JS exceptions, iframes — to understand
 * why the captcha widget does not render.
 *
 * Usage: node debug-html-captcha.js <email>
 */
const { execFileSync } = require('child_process')
const CDP = require('chrome-remote-interface')

const CHROME_CTR = process.env.CHROME_CTR || 'qwen2api-chrome-headless'
const QWEN_API = process.env.QWEN_API_URL || 'http://127.0.0.1:3001'
const QWEN_KEY = process.env.QWEN_ADMIN_KEY || 'sk-123456'
const PORT = 9470
const EMAIL = process.argv[2] || 'qwen@2140101.ru'
const API_URL = 'https://chat.qwen.ai/api/v2/chat/completions?chat_id=00000000-0000-0000-0000-000000000000'

const sleep = ms => new Promise(r => setTimeout(r, ms))
function http2(url, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url); const lib = require(u.protocol === 'https:' ? 'https' : 'http')
        const req = lib.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 120000 },
            res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c).toString())) })
        req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')))
        req.write(body); req.end()
    })
}
async function dragViaCDP(Input, startX, startY, endX, endY) {
    const steps = 40, dx = endX - startX, dy = endY - startY
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: startX, y: startY })
    await sleep(150)
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(90)
    for (let i = 1; i <= steps; i++) {
        const t = i / steps, p = (1 - Math.cos(Math.PI * t)) / 2
        const x = Math.round(startX + dx * p), y = Math.round(startY + dy * p + (Math.random() * 3 - 1.5))
        await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
        await sleep(Math.round(15 + 25 * (1 - Math.abs(2 * t - 1)) + (Math.random() * 10 - 5)))
    }
    await sleep(90)
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: endX, y: endY, button: 'left', buttons: 0, clickCount: 1 })
}
function http(url, opts = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url); const lib = require(u.protocol === 'https:' ? 'https' : 'http')
        const req = lib.request({ method: opts.method || 'GET', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: opts.headers || {}, timeout: 15000 },
            res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() })) })
        req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')))
        if (opts.body) req.write(opts.body); req.end()
    })
}

async function main() {
    // account info
    const r = await http(`${QWEN_API}/api/getAllAccounts`, { headers: { Authorization: `Bearer ${QWEN_KEY}` } })
    const list = JSON.parse(r.body); const arr = Array.isArray(list) ? list : (list.data || list.accounts || [])
    const acc = arr.find(a => a.email === EMAIL)
    if (!acc) throw new Error('account not found')
    const { token, proxy } = { token: acc.token, proxy: acc.proxy || null }
    console.log(`account=${EMAIL} proxy=${proxy || '(host)'}`)

    const userDataDir = `/tmp/dbg-${Date.now()}`
    const args = ['exec', '-d', CHROME_CTR, '/usr/bin/chromium-browser', '--headless=new', '--no-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled',
        '--no-first-run', `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${PORT}`,
        '--window-size=1920,952', '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36']
    if (proxy) args.push(`--proxy-server=${proxy}`)
    args.push('about:blank')
    execFileSync('docker', args, { stdio: 'pipe' })

    // wait CDP
    for (let i = 0; i < 40; i++) { try { const v = await http(`http://127.0.0.1:${PORT}/json/version`, { timeout: 1000 }); if (v.status === 200) break } catch (e) {} await sleep(300) }

    const client = await CDP({ host: '127.0.0.1', port: PORT })
    const { Network, Page, Runtime, Log } = client
    await Network.enable(); await Page.enable(); await Runtime.enable(); await Log.enable()

    // ── instrumentation ──
    const interesting = u => /captcha|aliyun|alicdn|punish|x5sec|waf|nc\/|/.test(u) && !/\.(png|jpg|gif|woff|css)/.test(u)
    Network.requestWillBeSent(p => { const u = p.request.url; if (interesting(u)) console.log(`REQ  ${p.request.method} ${u.slice(0, 130)}`) })
    Network.responseReceived(p => { const u = p.response.url; if (interesting(u)) console.log(`RESP ${p.response.status} ${p.response.mimeType} ${u.slice(0, 130)}`) })
    Network.loadingFailed(p => { console.log(`FAIL ${p.errorText}${p.blockedReason ? ' blocked=' + p.blockedReason : ''} type=${p.type}`) })
    Runtime.consoleAPICalled(p => { try {
        const parts = p.args.map(a => {
            if (a.value !== undefined) return JSON.stringify(a.value)
            if (a.preview) return JSON.stringify((a.preview.properties || []).reduce((o, pr) => (o[pr.name] = pr.value, o), {}))
            return a.description || a.type
        })
        const s = parts.join(' ')
        if (/captcha|verif|fail|success|code|result|risk|error|sig|token|true|false|\d/i.test(s)) console.log(`CONSOLE.${p.type}: ${s.slice(0, 300)}`)
    } catch (e) {} })
    Runtime.exceptionThrown(p => { console.log(`JS-EXCEPTION: ${(p.exceptionDetails.exception && (p.exceptionDetails.exception.description || p.exceptionDetails.exception.value)) || p.exceptionDetails.text}`.slice(0, 200)) })

    await Network.setCookie({ domain: 'chat.qwen.ai', name: 'token', value: token, path: '/', secure: true, sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 86400 })

    console.log(`\n=== navigate ${API_URL} ===`)
    await Page.navigate({ url: API_URL })
    await sleep(30000)  // let the captcha SDK do its thing

    // dump DOM + iframes
    const dom = await Runtime.evaluate({
        returnByValue: true,
        expression: `(() => {
            const cap = document.querySelector('#captcha-element') || document.body;
            const all = [...cap.querySelectorAll('*')];
            const rect = e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
            // elements that look interactive/relevant (have id or are img/slider)
            const nodes = all.filter(e => e.id || e.tagName === 'IMG' || /slid|btn|puzzle|piece|drag/i.test(e.className || ''))
                .map(e => ({ tag: e.tagName, id: e.id, cls: (e.className || '').toString().slice(0, 40), rect: rect(e), imgLen: e.tagName === 'IMG' ? (e.src || '').length : undefined, imgHead: e.tagName === 'IMG' ? (e.src || '').slice(0, 30) : undefined }))
                .filter(n => n.rect.w > 0 || n.tag === 'IMG');
            return { url: location.href, title: document.title, nodes };
        })()`
    })
    console.log('\n=== DOM STATE ===')
    console.log(JSON.stringify(dom.result.value, null, 2))

    const { data: png } = await Page.captureScreenshot({ format: 'png' })
    require('fs').writeFileSync('/tmp/dbg-captcha.png', Buffer.from(png, 'base64'))
    console.log('\nscreenshot → /tmp/dbg-captcha.png')

    // save the captcha background + piece images for offline gap analysis
    const imgs = await Runtime.evaluate({
        returnByValue: true,
        expression: `(() => {
            const bg = document.querySelector('#aliyunCaptcha-img');
            const pc = document.querySelector('#aliyunCaptcha-puzzle');
            return { bg: bg ? bg.src : null, pc: pc ? pc.src : null };
        })()`
    })
    const fs = require('fs')
    const saveDataUrl = (dataUrl, path) => { if (!dataUrl) return; const b64 = dataUrl.split(',')[1]; fs.writeFileSync(path, Buffer.from(b64, 'base64')); console.log(`saved ${path} (${b64.length}b)`) }
    saveDataUrl(imgs.result.value.bg, '/tmp/cap-bg.png')
    saveDataUrl(imgs.result.value.pc, '/tmp/cap-piece.png')

    // ── SOLVE ──
    // geometry
    const geo = (await Runtime.evaluate({ returnByValue: true, expression: `(() => {
        const r = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
        const img = document.querySelector('#aliyunCaptcha-img');
        const piece = document.querySelector('#aliyunCaptcha-puzzle');
        const slider = document.querySelector('#aliyunCaptcha-sliding-slider');
        const track = document.querySelector('#aliyunCaptcha-sliding-body');
        return { img: img&&r(img), piece: piece&&r(piece), slider: slider&&r(slider), track: track&&r(track) };
    })()` })).result.value
    console.log('geo:', JSON.stringify(geo))

    // gap via deterministic image analysis (brightness-step + edge-template)
    const det = require('./gap-detect').detectGap('/tmp/cap-bg.png', '/tmp/cap-piece.png')
    const gapX = det.gapX
    console.log(`gapX(image px) = ${gapX}  (brightness=${det.methodA} template=${det.methodB})`)

    // CLOSED-LOOP drag: the handle→piece ratio isn't reliably the geometric one,
    // so press and nudge while reading the piece's real position until it reaches
    // the gap. Self-corrects regardless of ratio; the read pauses also look human.
    const sx = geo.slider.x + geo.slider.w / 2
    const sy = geo.slider.y + geo.slider.h / 2
    const readPieceX = async () => (await Runtime.evaluate({ returnByValue: true, expression: `(() => { const pc=document.querySelector('#aliyunCaptcha-puzzle'), img=document.querySelector('#aliyunCaptcha-img'); return (pc&&img)? Math.round(pc.getBoundingClientRect().x - img.getBoundingClientRect().x):null; })()` })).result.value
    const I = client.Input
    // deterministic, stable mouse-offset → piece-x calibration curve (Aliyun 300px UI)
    const CURVE = [[0, 0], [40, 9], [90, 36], [140, 80], [190, 143], [240, 223], [260, 248]]
    const invert = pieceTarget => {   // piece-x → mouse offset
        for (let i = 1; i < CURVE.length; i++) {
            const [o0, p0] = CURVE[i - 1], [o1, p1] = CURVE[i]
            if (pieceTarget <= p1) return o0 + (pieceTarget - p0) * (o1 - o0) / (p1 - p0)
        }
        return CURVE[CURVE.length - 1][0]
    }
    if (process.env.CALIB === '1') {
        // CALIBRATION: sample piece-x at several mouse offsets to learn the mapping
        await I.dispatchMouseEvent({ type: 'mouseMoved', x: sx, y: sy }); await sleep(140)
        await I.dispatchMouseEvent({ type: 'mousePressed', x: sx, y: sy, button: 'left', buttons: 1, clickCount: 1 }); await sleep(130)
        const samples = []
        for (const off of [40, 90, 140, 190, 240]) {
            await I.dispatchMouseEvent({ type: 'mouseMoved', x: sx + off, y: sy, button: 'left', buttons: 1 }); await sleep(120)
            samples.push([off, await readPieceX()])
        }
        await I.dispatchMouseEvent({ type: 'mouseReleased', x: sx + 240, y: sy, button: 'left', buttons: 0, clickCount: 1 })
        console.log('CALIB samples [mouseOff, pieceX]:', JSON.stringify(samples))
        await client.close(); try { execFileSync('docker', ['exec', CHROME_CTR, 'sh', '-c', `pkill -f 'user-data-dir=${userDataDir}'; rm -rf '${userDataDir}'`], { stdio: 'pipe' }) } catch (e) {}
        return
    }
    // ── HIGH-FIDELITY human drag (open-loop): ballistic launch + long homing creep,
    // ~60-90 move events over ~1-1.6s, asymmetric velocity, tremor, brief end-hold ──
    const D = invert(gapX)
    console.log(`kinematic: gapX=${gapX} → mouseOffset=${D.toFixed(1)}`)
    // velocity profile: fast first ~70% (ballistic), then slow homing to target with a
    // tiny overshoot+settle. Build cumulative x(t) over T total ms at ~13ms steps.
    const Ttot = 1100 + Math.random() * 600
    const nEv = Math.round(Ttot / (11 + Math.random() * 5))
    const over = D + (3 + Math.random() * 5)
    const homeFrac = 0.62 + Math.random() * 0.08          // fraction of time in ballistic phase
    const pts = []
    for (let i = 1; i <= nEv; i++) {
        const t = i / nEv
        let x
        if (t < homeFrac) {                                // ballistic: ease-out to overshoot
            const u = t / homeFrac
            x = over * (1 - Math.pow(1 - u, 2.3))
        } else {                                           // homing: creep from overshoot back to D
            const u = (t - homeFrac) / (1 - homeFrac)
            const mj = 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5
            x = over + (D - over) * mj
        }
        const tremor = (Math.random() - 0.5) * (t < homeFrac ? 0.8 : 1.6)   // more tremor while homing
        pts.push(sx + x + tremor)
    }
    await I.dispatchMouseEvent({ type: 'mouseMoved', x: sx, y: sy }); await sleep(140 + Math.random() * 160)
    await I.dispatchMouseEvent({ type: 'mousePressed', x: sx, y: sy, button: 'left', buttons: 1, clickCount: 1 }); await sleep(90 + Math.random() * 140)
    let py = sy, lastX = sx
    for (let i = 0; i < pts.length; i++) {
        const x = pts[i]
        py = sy + Math.sin((x - sx) / Math.max(1, D) * Math.PI) * 1.3 + (Math.random() - 0.5) * 1.3
        await I.dispatchMouseEvent({ type: 'mouseMoved', x: Math.round(x), y: Math.round(py), button: 'left', buttons: 1 })
        lastX = x
        const frac = i / pts.length
        await sleep(Math.round((frac < homeFrac ? 9 + Math.random() * 7 : 16 + Math.random() * 22)))   // slower events while homing
    }
    await sleep(200 + Math.random() * 350)                 // human hold before release
    await I.dispatchMouseEvent({ type: 'mouseReleased', x: Math.round(sx + D), y: Math.round(py), button: 'left', buttons: 0, clickCount: 1 })

    // immediately read where the piece landed (image-x) + screenshot before any reset
    const land = (await Runtime.evaluate({ returnByValue: true, expression: `(() => {
        const pc = document.querySelector('#aliyunCaptcha-puzzle');
        const img = document.querySelector('#aliyunCaptcha-img');
        if (!pc || !img) return null;
        return { pieceImgX: Math.round(pc.getBoundingClientRect().x - img.getBoundingClientRect().x) };
    })()` })).result.value
    console.log(`landed: pieceImgX=${land && land.pieceImgX} (target gapX=${gapX})`)
    try { const { data: pmid } = await Page.captureScreenshot({ format: 'png' }); fs.writeFileSync('/tmp/cap-landed.png', Buffer.from(pmid, 'base64')) } catch (e) {}

    // check result: x5sec cookie OR success (page reform navigates away)
    await sleep(2500)
    let x5 = null
    for (let i = 0; i < 5; i++) {
        const { cookies } = await Network.getAllCookies()
        const c = cookies.find(c => c.name === 'x5sec' && /qwen\.ai/.test(c.domain))
        if (c) { x5 = c.value.slice(0, 24); break }
        await sleep(1500)
    }
    const after = (await Runtime.evaluate({ returnByValue: true, expression: `(document.body&&document.body.innerText||'').slice(0,80)` })).result.value
    const { data: png2 } = await Page.captureScreenshot({ format: 'png' })
    fs.writeFileSync('/tmp/cap-after.png', Buffer.from(png2, 'base64'))
    console.log(`\nRESULT: x5sec=${x5 ? '✅ ' + x5 : '❌ none'} | afterText="${after}" | screenshot /tmp/cap-after.png`)

    await client.close()
    try { execFileSync('docker', ['exec', CHROME_CTR, 'sh', '-c', `pkill -f 'user-data-dir=${userDataDir}'; rm -rf '${userDataDir}'`], { stdio: 'pipe' }) } catch (e) {}
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) })
