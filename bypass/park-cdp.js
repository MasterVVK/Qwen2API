const CDP = require('chrome-remote-interface')
const port = Number(process.argv[2])
;(async () => {
  const list = await CDP.List({ host: '127.0.0.1', port })
  const page = list.find(t => t.type === 'page' && /qwen\.ai/.test(t.url || '')) || list.find(t => t.type === 'page')
  if (!page) { console.log('NO_PAGE', port); process.exit(2) }
  const c = await CDP({ host: '127.0.0.1', port, target: page.webSocketDebuggerUrl })
  try {
    await c.Page.navigate({ url: 'about:blank' })
    console.log('PARKED', port, '(было ' + (page.url || '').slice(0, 40) + ')')
  } finally { try { await c.close() } catch (e) {} }
})().catch(e => { console.log('ERR', port, e.message); process.exit(1) })
