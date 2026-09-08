// GitHub CI only: real isolated-world extension checks; no native host, OS capture, or chat paste.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');
assert(process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux', 'Run this browser integration check in Linux GitHub Actions only');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'i-know-it-context-'));
const extension = path.join(temporary, 'extension');
fs.mkdirSync(extension);
for (const file of ['manifest.json', 'context.js', 'popup.html', 'popup.js']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(extension, file));
}
const source = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
const nativeCall = "chrome.runtime.connectNative('com.iknowit.bridge')";
assert.equal(source.split('chrome.runtime.connectNative').length, 2, 'Keep every native connection stubbed in this fixture');
assert(source.includes(nativeCall));
fs.writeFileSync(path.join(extension, 'background.js'), source.replace(nativeCall,
  '({ postMessage() {}, disconnect() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } })')
  + '\nglobalThis.__contextTest = { ready, setEnabled, pageContext };\n');
const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Isolated context fixture</title><style>body{margin:0;min-height:3000px}</style><h1>I Know It context fixture</h1>');
});
(async () => {
  let context;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
      headless: false, viewport: { width: 1000, height: 700 },
      args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    context.setDefaultTimeout(10_000);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    assert(worker.url().startsWith('chrome-extension://'));
    await worker.evaluate(async () => { await __contextTest.ready; });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${origin}/`);
    await page.bringToFront();
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
    assert(Number.isInteger(tabId));
    const read = () => worker.evaluate(async id => {
      const results = await chrome.scripting.executeScript({ target: { tabId: id }, func: __contextTest.pageContext });
      return results.find(result => result.frameId === 0)?.result;
    }, tabId);
    const toggle = value => worker.evaluate(value => __contextTest.setEnabled(value), value);
    const seed = async () => {
      await page.waitForFunction(() => document.visibilityState === 'visible' && document.hasFocus());
      await page.mouse.move(140, 140);
      await page.mouse.move(180, 180);
      const result = await read();
      assert(result.pointerAnchor, 'A real browser mouse movement must reach the isolated content script');
      assert.equal(result.pointerAnchor.client.x, 180);
      assert.equal(result.pointerAnchor.client.y, 180);
      assert(result.pointerAnchor.ageMs >= 0 && result.pointerAnchor.ageMs <= 1000);
      assert(Number.isFinite(result.pointerAnchor.screen.x) && Number.isFinite(result.pointerAnchor.screen.y));
      return result;
    };
    // Waiting for the real live-state message also settles content-script startup.
    await toggle(false);
    await toggle(true);
    assert.equal(await page.evaluate(() => typeof globalThis.__iKnowItPageContext), 'undefined', 'The extension getter must not exist in the main world');
    await page.evaluate(() => dispatchEvent(new PointerEvent('pointermove', {
      pointerType: 'mouse', buttons: 0, clientX: 180, clientY: 180, screenX: 300, screenY: 300,
    })));
    assert.equal((await read()).pointerAnchor, undefined, 'A synthetic page event must not seed an anchor');
    const initial = await seed();
    assert.equal(initial.url, `${origin}/`);
    assert.equal(initial.viewport.width, 1000);
    assert(initial.pageWindow && typeof initial.fullscreen === 'boolean');
    await page.evaluate(() => { globalThis.__iKnowItPageContext = () => ({ forged: true, pointerAnchor: { client: { x: -999 } } }); });
    const isolated = await read();
    assert.equal(isolated.forged, undefined, 'Main-world code must not replace the isolated getter used by executeScript');
    assert.equal(isolated.pointerAnchor.client.x, 180);
    await toggle(false);
    await page.mouse.move(200, 200);
    assert.equal((await read()).pointerAnchor, undefined, 'OFF must stop collecting anchors');
    await toggle(true);
    assert.equal((await read()).pointerAnchor, undefined, 'ON must not revive a pre-OFF anchor');
    await seed();
    await page.evaluate(() => scrollTo(0, 150));
    const scrolled = await read();
    assert.equal(scrolled.scroll.y, 150);
    assert.equal(scrolled.pointerAnchor, undefined, 'Scrolling must invalidate an anchor');
    await seed();
    await page.setViewportSize({ width: 900, height: 650 });
    const resized = await read();
    assert.equal(resized.viewport.width, 900);
    assert.equal(resized.pointerAnchor, undefined, 'Resizing must invalidate an anchor');
    await seed();
    await page.mouse.move(-20, -20);
    await page.goto(`${origin}/next`);
    const navigated = await read();
    assert.equal(navigated.url, `${origin}/next`);
    assert.equal(navigated.pointerAnchor, undefined, 'Navigation must not carry an old document anchor');
    assert.equal(await page.evaluate(() => typeof globalThis.__iKnowItPageContext), 'undefined');
    await seed();
    assert.deepEqual(errors, []);
    console.log('PASS: real Chromium extension isolated world; production background executeScript reads trusted anchors; synthetic input and main-world getter spoofing rejected; OFF/ON, navigation, scroll, and resize invalidation. Native macOS geometry and target-app paste are outside this check.');
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
