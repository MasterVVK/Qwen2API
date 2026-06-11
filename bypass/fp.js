const { execFileSync } = require('child_process'); const CDP = require('chrome-remote-interface')
const PORT=9471, CTR='qwen2api-chrome-headless'
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
function http(u){return new Promise((res,rej)=>{const x=new URL(u),l=require('http');const q=l.request({hostname:x.hostname,port:x.port,path:x.pathname,timeout:1000},r=>{const c=[];r.on('data',d=>c.push(d));r.on('end',()=>res({s:r.statusCode,b:Buffer.concat(c).toString()}))});q.on('error',rej);q.on('timeout',()=>q.destroy(new Error('t')));q.end()})}
;(async()=>{
const dir='/tmp/fp-'+Date.now()
execFileSync('docker',['exec','-d',CTR,'/usr/bin/chromium-browser','--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-blink-features=AutomationControlled','--no-first-run',`--user-data-dir=${dir}`,`--remote-debugging-port=${PORT}`,'--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36','about:blank'],{stdio:'pipe'})
for(let i=0;i<30;i++){try{const v=await http(`http://127.0.0.1:${PORT}/json/version`);if(v.s===200)break}catch(e){}await sleep(300)}
const client=await CDP({host:'127.0.0.1',port:PORT}); const {Runtime,Page}=client; await Runtime.enable();await Page.enable()
await Page.navigate({url:'about:blank'}); await sleep(500)
const r=await Runtime.evaluate({returnByValue:true,expression:`JSON.stringify({
  webdriver: navigator.webdriver,
  plugins: navigator.plugins.length,
  languages: navigator.languages,
  chrome: !!window.chrome,
  permissions: typeof navigator.permissions,
  vendor: navigator.vendor,
  hardwareConcurrency: navigator.hardwareConcurrency,
  headlessUA: /Headless/.test(navigator.userAgent),
  webgl: (()=>{try{const c=document.createElement('canvas').getContext('webgl');return c.getParameter(c.getParameter(37445))||'?'}catch(e){return 'err'}})()
})`})
console.log(r.result.value)
await client.close(); try{execFileSync('docker',['exec',CTR,'sh','-c',`pkill -f 'user-data-dir=${dir}';rm -rf '${dir}'`],{stdio:'pipe'})}catch(e){}
})().catch(e=>console.error(e.message))
