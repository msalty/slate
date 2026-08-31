import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
const DIST=resolve('dist'), PORT=4185, BASE='/slate/'
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'}
const server=createServer(async(req,res)=>{const u=new URL(req.url,`http://localhost:${PORT}`);const p=decodeURIComponent(u.pathname);if(!p.startsWith(BASE)){res.writeHead(404).end();return}const rel=p.slice(BASE.length);const f=join(DIST,rel===''?'index.html':rel);try{res.writeHead(200,{'Content-Type':MIME[extname(f)]??'application/octet-stream'});res.end(await readFile(f))}catch{res.writeHead(404,{'Content-Type':'text/html'}).end('<html>404</html>')}})
await new Promise(r=>server.listen(PORT,r))
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']})
const p=await b.newPage({viewport:{width:1400,height:900}})
p.on('pageerror',e=>console.log('ERR',e.message))

const CASES = {
  'trailing on delim': '# T\n\n| A | B |\n| --- | --- |   \n| 1 | 2 |\n\nafter\n',
  'one trailing space delim': '# T\n\n| A | B |\n| --- | --- | \n| 1 | 2 |\n\nafter\n',
  'tab after delim': '# T\n\n| A | B |\n| --- | --- |\t\n| 1 | 2 |\n\nafter\n',
  'table at very start': '| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter\n',
  'no outer pipes': '# T\n\nA | B\n--- | ---\n1 | 2\n\nafter\n',
  'formatting in cells': '# T\n\n| Item | Note |\n| --- | --- |\n| **bold** | *ital* |\n| `code` | ~~gone~~ |\n| [[Wiki]] | [ext](https://x.com) |\n\nafter\n',
  'escaped pipe': '# T\n\n| A | B |\n| --- | --- |\n| a \\| b | c |\n\nafter\n',
  'not a table': '# T\n\nJust a | pipe in prose.\n\nAnd another line.\n\nafter\n',
  'table in code fence': '# T\n\n```\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n\nafter\n',
  'ragged row lengths': '# T\n\n| A | B | C |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |\n\nafter\n',
}

await p.goto(`http://localhost:${PORT}${BASE}`,{waitUntil:'networkidle'})
await p.waitForSelector('.shell')
await p.evaluate(async (cases)=>{
  const db=await new Promise((res,rej)=>{const r=indexedDB.open('slate');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})
  const tx=db.transaction('files','readwrite'); const now=Date.now()
  Object.entries(cases).forEach(([name,text],i)=>{
    tx.objectStore('files').put({path:`${name}.md`,kind:'note',text,mime:'text/markdown',size:text.length,hash:'t'+i,mtime:now-i*1000,ctime:now-i*1000,dirty:true,dirtyFlag:1,sync:{}})
  })
  await new Promise(res=>{tx.oncomplete=res})
}, CASES)
await p.reload({waitUntil:'networkidle'})
await p.waitForSelector('.note-row')

for (const name of Object.keys(CASES)) {
  await p.locator('.note-row').filter({hasText:name}).first().click()
  await p.waitForTimeout(450)
  const rendered = await p.locator('.cm-table-render').count()
  const strong = await p.locator('.cm-table-render strong').count()
  const em = await p.locator('.cm-table-render em').count()
  const code = await p.locator('.cm-table-render code').count()
  const del = await p.locator('.cm-table-render del').count()
  const wl = await p.locator('.cm-table-render [data-wikilink]').count()
  const a = await p.locator('.cm-table-render a').count()
  const cellText = rendered ? (await p.locator('.cm-table-render').innerText()).replace(/\s+/g,' ').slice(0,60) : ''
  console.log(`${rendered? 'RENDER ':'source '} ${name.padEnd(26)} b=${strong} i=${em} c=${code} s=${del} wl=${wl} a=${a} | ${cellText}`)
}

await b.close(); server.close()
