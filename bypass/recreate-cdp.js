const CDP = require('chrome-remote-interface')
const port = Number(process.argv[2])
const host = '127.0.0.1'
;(async () => {
  let before = []
  try { before = (await CDP.List({ host, port })).filter(t => t.type === 'page') } catch (e) {}
  await CDP.New({ host, port, url: 'https://chat.qwen.ai/?temporary-chat=true' })
  await new Promise(r => setTimeout(r, 1500))
  for (const t of before) {
    if (/qwen\.ai/.test(t.url || '') || /about:blank/.test(t.url || '')) {
      try { await CDP.Close({ host, port, id: t.id }) } catch (e) {}
    }
  }
  console.log('RECREATED port ' + port + ' (closed ' + before.length + ' old tabs)')
})().catch(e => { console.log('ERR', e.message); process.exit(1) })
