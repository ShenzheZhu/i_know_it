const {chromium}=require('playwright');
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict'), cp=require('node:child_process'), http=require('node:http'), crypto=require('node:crypto'), os=require('node:os');
const root=__dirname, output=process.env.IKI_RUN_DIR || fs.mkdtempSync(path.join(os.tmpdir(),'i-know-it-browser-'));
fs.mkdirSync(output,{recursive:true});
cp.execFileSync('/usr/bin/xcrun',['swiftc',path.join(root,'native/clipboard-check.swift'),'-o',path.join(output,'clipboard-fixture')]);
const extension=path.join(output,'extension');fs.mkdirSync(extension,{recursive:true});
for(const file of ['manifest.json','context.js','popup.html','popup.js'])fs.copyFileSync(path.join(root,file),path.join(extension,file));
fs.writeFileSync(path.join(extension,'background.js'),fs.readFileSync(path.join(root,'background.js'),'utf8')+'\nglobalThis.__test={ready,get port(){return port}};\n');
const profile=fs.mkdtempSync(path.join(output,'profile-'));
const key=Buffer.from(JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))).key,'base64');
const id=[...crypto.createHash('sha256').update(key).digest().subarray(0,16)].map(x=>String.fromCharCode(97+(x>>4),97+(x&15))).join('');
const hostdir=path.join(profile,'NativeMessagingHosts');fs.mkdirSync(hostdir);
// Requires ./install.sh first. Only this isolated browser profile is instrumented.
fs.copyFileSync(path.join(os.homedir(),'Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts/com.iknowit.bridge.json'),path.join(hostdir,'com.iknowit.bridge.json'));
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>I Know It clipboard test</title><style>body{margin:30px;background:#eee}textarea{width:500px;height:150px}</style><h1>Clipboard fixture 47K9</h1><textarea aria-label="Paste test"></textarea><div style="height:1800px"></div>');});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const context=await chromium.launchPersistentContext(profile,{headless:false,viewport:{width:1000,height:700},args:['--enable-unsafe-extension-debugging',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 let fixture;
 try{
 const page=await context.newPage(), url=`http://127.0.0.1:${server.address().port}/`;
 await page.goto(url);await page.bringToFront();
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 assert.equal(new URL(worker.url()).host,id);
 await worker.evaluate(async()=>{await __test.ready;globalThis.testMessages=[];const originalSend=__test.port.postMessage.bind(__test.port);__test.port.postMessage=m=>{testMessages.push(m);return originalSend(m);};});
 await page.waitForTimeout(800);
 await page.screenshot({path:path.join(output,'screenshot.png')});
 fs.writeFileSync(path.join(output,'context.md'),'# Screenshot context\n\n- Source: http://127.0.0.1/\n- Fixture: 47K9\n');
 const startFixture=async paths=>{fixture=cp.spawn(path.join(output,'clipboard-fixture'),paths,{stdio:['pipe','pipe','inherit']});await new Promise((resolve,reject)=>{fixture.stdout.once('data',d=>String(d).includes('READY')?resolve():reject(new Error('Not ready')));fixture.once('exit',code=>code&&reject(new Error(`fixture exit ${code}`)));});};
 const stopFixture=async()=>{const child=fixture;fixture=null;if(child){child.stdin.end('\n');await new Promise(r=>child.once('exit',r));}};
 await startFixture([path.join(output,'screenshot.png')]);
 await page.waitForTimeout(1200);
 const actual=await worker.evaluate(()=>testMessages.filter(m=>m.type==='browser-context'&&m.requestId));
 assert(actual.some(m=>m.available&&m.url===url),'real native host requested and received current browser context');
 await stopFixture();
 await page.evaluate(()=>{document.addEventListener('paste',async event=>{event.preventDefault();window.pasted=await Promise.all([...event.clipboardData.files].map(async f=>({name:f.name,type:f.type,bytes:[...new Uint8Array(await f.arrayBuffer())]})));});});
 await startFixture([path.join(output,'screenshot.png'),path.join(output,'context.md')]);
 await page.locator('textarea').focus();await page.keyboard.press('Meta+v');
 await page.waitForFunction(()=>window.pasted?.length===2);
 const pasted=await page.evaluate(()=>window.pasted);
 assert.deepEqual(pasted.map(f=>f.name),['screenshot.png','context.md']);
 for(const f of pasted) assert.equal(digest(Buffer.from(f.bytes)),digest(fs.readFileSync(path.join(output,f.name))));
 await stopFixture();
 const result={date:new Date().toISOString(),browser:context.browser().version(),extensionId:id,checks:['Real native host requests and receives browser context','Native macOS file URLs paste as PNG and Markdown in one ordinary Meta+V','PNG and Markdown bytes preserved'],nativeCodexGUI:'Not executed: automation channel denies Codex app control',claudeCode:'Not verified'};
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
 }finally{if(fixture){fixture.stdin.end('\n');await new Promise(r=>fixture.once('exit',r));}await context.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
