#!/usr/bin/env node
/**
 * Provision an account-pool container: auto-login a fresh chrome-solver clone by injecting the
 * account's JWT (from data/data.json) into localStorage — no manual noVNC typing.
 *
 * Mechanism: the qwen SPA authenticates from the account JWT held in BOTH localStorage.token and a
 * `token` cookie on .qwen.ai (the cookie became required sometime after the 2026-06-13 localStorage-
 * only finding — without it the SPA renders logged-out even with a valid token & working API). So we
 * drive the fresh chromium like a human (xdotool address bar → chat.qwen.ai, which does NOT trip the
 * WAF), set localStorage.token AND the cookie to the account's JWT via a target-aware CDP connection,
 * then reload with the window focused so the SPA re-reads the token and logs in.
 *
 * Usage:  node pool-login.js <container> <cdpPort> <email>
 *   e.g.  node pool-login.js qwen2api-chrome-solver-3 9565 qoder@synntes.com
 */
const path = require('path')
const { execFileSync, execSync } = require('child_process')
const CDP = require('chrome-remote-interface')

const [CTR, PORT_S, EMAIL] = process.argv.slice(2)
const PORT = Number(PORT_S)
if (!CTR || !PORT || !EMAIL) { console.error('usage: node pool-login.js <container> <cdpPort> <email>'); process.exit(1) }

const sleep = ms => new Promise(r => setTimeout(r, ms))
const X = cmd => { try { return execFileSync('docker', ['exec', '-e', 'DISPLAY=:1', CTR, 'sh', '-c', cmd], { stdio: 'pipe' }).toString().trim() } catch (e) { return '' } }
const acc = require(path.join(__dirname, '..', 'data', 'data.json')).accounts.find(a => a.email === EMAIL)
const qwenTarget = async () => (await CDP.List({ host: '127.0.0.1', port: PORT })).find(t => t.type === 'page' && /chat\.qwen\.ai/.test(t.url || ''))
const conn = async () => { const t = await qwenTarget(); if (!t) throw new Error('no qwen tab'); return CDP({ host: '127.0.0.1', port: PORT, target: t.id }) }
const focus = () => { const w = X('xdotool search --onlyvisible --class chromium | head -1'); if (w) X(`xdotool windowactivate ${w}; xdotool windowfocus ${w}; xdotool mousemove 500 300 click 1`); return w }
const navOmnibox = () => { X('xdotool key ctrl+l'); execSync('sleep 0.4'); X("xdotool type --delay 30 'https://chat.qwen.ai/'"); execSync('sleep 0.4'); X('xdotool key Return') }

;(async () => {
    if (!acc || !acc.token) { console.log(`✗ ${EMAIL}: no token in data.json`); process.exit(1) }
    // 0) fresh clones lack socat/xdotool/xclip — install them (same as channel ensureSocat)
    console.log(`${CTR}: ensuring socat/xdotool/xclip…`)
    try { execFileSync('docker', ['exec', '-u', 'root', CTR, 'sh', '-c', `which socat xdotool xclip >/dev/null 2>&1 || (apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq socat xclip xdotool >/dev/null 2>&1)`], { stdio: 'pipe', timeout: 120000 }) } catch (e) {}
    // 1) socat CDP bridge inside the container
    try { execFileSync('docker', ['exec', '-d', CTR, 'socat', `TCP-LISTEN:${PORT},fork,reuseaddr`, 'TCP:127.0.0.1:9561'], { stdio: 'pipe' }) } catch (e) {}
    await sleep(1500)
    // 2) focus + drive to qwen (human-like, WAF-safe)
    focus(); await sleep(500); navOmnibox()
    console.log(`${CTR}: navigating to qwen…`); await sleep(9000)
    let t = await qwenTarget()
    if (!t) { console.log(`✗ ${EMAIL}: qwen did not load (captcha? proxy down?)`); process.exit(2) }
    // 3) inject token on the qwen origin
    let c = await conn()
    let ev = q => c.Runtime.evaluate({ returnByValue: true, awaitPromise: true, expression: q }).then(r => r.result.value)
    const egress = await ev(`fetch("https://ifconfig.me/ip").then(r=>r.text()).catch(e=>"?")`)
    await ev(`localStorage.setItem('token', ${JSON.stringify(acc.token)})`)
    // The qwen SPA now also reads the JWT from a `token` COOKIE (changed since the 2026-06-13
    // localStorage-only finding). Without it the SPA renders logged-out even with a valid token in
    // localStorage and a working API. Set both so fresh clones authenticate. (verified 2026-06-25)
    await c.Network.setCookie({ name: 'token', value: acc.token, domain: '.qwen.ai', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' })
    await c.close()
    // 4) reload so the SPA re-reads the token. Full omnibox navigation is reliable; F5 is not
    // (observed: F5 via XTEST sometimes doesn't re-init the SPA even with the window focused).
    focus(); await sleep(800); navOmnibox(); await sleep(13000)
    // 5) verify
    c = await conn(); ev = q => c.Runtime.evaluate({ returnByValue: true, expression: q }).then(r => r.result.value)
    const st = await ev(`(()=>{const b=document.body.innerText||"";return {loggedIn:!/Log in|Sign up/i.test(b)&&!!localStorage.getItem("token"),user:(()=>{const e=[...document.querySelectorAll("*")].find(x=>x.children.length===0&&x.getBoundingClientRect().bottom>650&&x.textContent.trim().length>0&&x.textContent.trim().length<20);return e?e.textContent.trim():"?"})()}})()`)
    await c.close()
    console.log(`${st.loggedIn ? '✓' : '✗'} ${EMAIL} @ ${CTR} (cdp ${PORT}) — egress ${egress} — ${st.loggedIn ? 'LOGGED IN as ' + st.user : 'NOT logged in'}`)
    process.exit(st.loggedIn ? 0 : 3)
})().catch(e => { console.log(`✗ ${EMAIL}: ${e.message}`); process.exit(1) })
