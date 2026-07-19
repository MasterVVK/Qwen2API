const CDP = require('chrome-remote-interface')
const port = Number(process.argv[2])
const expr = process.argv[3]
;(async () => {
  const list = await CDP.List({ host: '127.0.0.1', port })
  const page = list.find(t => t.type === 'page' && /qwen\.ai/.test(t.url || '')) || list.find(t => t.type === 'page')
  if (!page) { console.log('NO_PAGE'); process.exit(2) }
  const c = await CDP({ host: '127.0.0.1', port, target: page.webSocketDebuggerUrl })
  try {
    const r = await c.Runtime.evaluate({ returnByValue: true, expression: expr })
    console.log(JSON.stringify(r.result.value))
  } finally { try { await c.close() } catch (e) {} }
})().catch(e => { console.log('ERR', e.message); process.exit(1) })
