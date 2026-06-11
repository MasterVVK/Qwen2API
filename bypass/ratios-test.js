const CDP = require('/home/user/Qwen2API/bypass/node_modules/chrome-remote-interface')
const { execFileSync } = require('child_process')
const CTR = 'qwen2api-chrome-solver'
const xdo = c => { try { return execFileSync('docker', ['exec', '-e', 'DISPLAY=:1', CTR, 'sh', '-c', c], { stdio: 'pipe' }).toString() } catch (e) { return 'e' } }
const setClip = t => { try { execFileSync('docker', ['exec', '-i', '-e', 'DISPLAY=:1', CTR, 'sh', '-c', 'xclip -selection clipboard'], { input: t, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (e) {} }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const offY = 87
;(async () => {
    const c = await CDP({ host: '127.0.0.1', port: 9563 })
    const ev = q => c.Runtime.evaluate({ returnByValue: true, expression: q }).then(r => r.result.value)
    const info = xdo('xdotool mousemove 500 400; xdotool getmouselocation --shell')
    const w = (info.match(/WINDOW=(\d+)/) || [])[1]
    xdo(`xdotool windowactivate ${w} 2>/dev/null; true`); await sleep(300)
    const clickByText = async t => { const r = await ev(`(()=>{const e=[...document.querySelectorAll("*")].filter(x=>x.children.length<=2&&x.textContent.trim()===${JSON.stringify(t)}&&x.getBoundingClientRect().width>0)[0];if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];})()`); if (!r) return false; xdo(`xdotool mousemove ${r[0]} ${r[1] + offY}; xdotool click 1`); await sleep(1100); return true }
    const clickXY = async sel => { const r = await ev(sel); if (!r) return false; xdo(`xdotool mousemove ${r[0]} ${r[1] + offY}; xdotool click 1`); await sleep(1100); return true }
    for (const ratio of ['1:1', '16:9', '9:16']) {
        xdo('xdotool key ctrl+l'); await sleep(500); xdo('xdotool type --delay 20 "https://chat.qwen.ai/?temporary-chat=true"'); await sleep(300); xdo('xdotool key Return'); await sleep(7000)
        await clickXY(`(()=>{const t=document.querySelector("textarea");const tr=t.getBoundingClientRect();const b=[...document.querySelectorAll("button,[role=button],div")].filter(e=>{const r=e.getBoundingClientRect();return e.querySelector("svg")&&r.width>15&&r.width<55&&Math.abs(r.y+r.height/2-(tr.y+tr.height/2))<40&&r.x<tr.x;}).sort((a,b)=>a.getBoundingClientRect().x-b.getBoundingClientRect().x)[0];const r=b.getBoundingClientRect();return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)];})()`)
        await clickByText('Create Image'); await sleep(700)
        await clickXY(`(()=>{const e=[...document.querySelectorAll("*")].filter(x=>x.children.length<=2&&/^\\s*(16:9|1:1|9:16|4:3|3:4)\\s*$/.test(x.textContent.trim())&&x.getBoundingClientRect().width>0)[0];if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.x+b.width/2),Math.round(b.y+b.height/2)];})()`)
        const set = await clickByText(ratio)
        setClip('a cat'); await sleep(300)
        await clickXY(`(()=>{const t=document.querySelector("textarea").getBoundingClientRect();return [Math.round(t.x+t.width/2),Math.round(t.y+t.height/2)];})()`)
        xdo('xdotool key ctrl+v'); await sleep(600); xdo('xdotool key Return')
        let res = ''
        for (let i = 0; i < 35; i++) {
            await sleep(4000)
            const r = await ev(`(()=>{const im=[...document.querySelectorAll("img")].filter(i=>/img.alicdn|dashscope|wanx|oss-/i.test(i.src)&&!/avatar|icon|logo/i.test(i.src)&&i.naturalWidth>100);const i=im[im.length-1];return i?{nw:i.naturalWidth,nh:i.naturalHeight,tps:(i.src.match(/tps-[0-9-]+/)||[""])[0]}:null;})()`)
            if (r) { res = `${r.nw}x${r.nh} (${r.tps})`; break }
            if (await ev(`!!document.querySelector("#aliyunCaptcha-sliding-slider")`)) { res = 'CAPTCHA'; break }
        }
        console.log(`RATIO ${ratio} set=${set} => img ${res || '(timeout)'}`)
    }
    await c.close()
})().catch(e => console.log('ERR:' + e.message))
