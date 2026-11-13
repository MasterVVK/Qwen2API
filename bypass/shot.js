const CDP = require('chrome-remote-interface')
const fs = require('fs')
const port = Number(process.argv[2] || 9563)
const out = process.argv[3] || '/tmp/shot.png'
;(async () => {
  const list = await CDP.List({ host: '127.0.0.1', port })
  const page = list.find(t => t.type === 'page' && /qwen\.ai/.test(t.url || '')) || list.find(t => t.type === 'page')
  if (!page) { console.log('NO_PAGE'); process.exit(2) }
  const c = await CDP({ host: '127.0.0.1', port, target: page.webSocketDebuggerUrl })
  try {
    const { data } = await c.Page.captureScreenshot({ format: 'png' })
    fs.writeFileSync(out, Buffer.from(data, 'base64'))
    console.log('SHOT url=' + page.url + ' -> ' + out)
  } finally { try { await c.close() } catch (e) {} }
})().catch(e => { console.log('ERR', e.message); process.exit(1) })
