// GitHub CI only: real isolated-world extension checks; no native host, OS capture, or chat paste.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');
assert(process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux', 'Run this browser integration check in Linux GitHub Actions only');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'i-know-it-context-'));
const extension = path.join(temporary, 'extension');
fs.mkdirSync(extension);
for (const file of ['manifest.json', 'context.js', 'popup.html', 'popup.js']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(extension, file));
}
// Fixture-only diagnostics retain the last event/state, never changing production eligibility.
fs.appendFileSync(path.join(extension, 'context.js'), `
(() => {
if (globalThis.__contextSeedDebug) return;
globalThis.__contextSeedDebug = {};
addEventListener('pointermove', event => {
  globalThis.__contextSeedDebug.pointer = {
    trusted: event.isTrusted, type: event.pointerType, buttons: event.buttons,
    modifiers: [event.ctrlKey, event.altKey, event.shiftKey, event.metaKey],
    client: { x: event.clientX, y: event.clientY }, screen: { x: event.screenX, y: event.screenY },
    delayMs: performance.now() - event.timeStamp,
    visibility: document.visibilityState, focused: document.hasFocus(),
  };
}, { capture: true, passive: true });
chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'page-state') globalThis.__contextSeedDebug.pageState = message.enabled;
});
for (const event of ['resize', 'scroll', 'pageshow']) {
  addEventListener(event, () => { globalThis.__contextSeedDebug.lastSignal = { type: event, at: performance.now() }; }, { passive: true });
}
})();
`);
const source = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
const nativeCall = "chrome.runtime.connectNative('com.iknowit.bridge')";
assert.equal(source.split('chrome.runtime.connectNative').length, 2, 'Keep every native connection stubbed in this fixture');
assert(source.includes(nativeCall));
fs.writeFileSync(path.join(extension, 'background.js'), source.replace(nativeCall,
  '({ postMessage() {}, disconnect() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } })')
  + '\nglobalThis.__contextTest = { ready, setEnabled, pageContext, updatePages };\n');
const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Isolated context fixture</title><style>body{margin:0;min-height:3000px}</style><h1>I Know It context fixture</h1>');
});
(async () => {
  let browser, context, child, childExited, childError;
  let browserLog = '';
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const profile = path.join(temporary, 'profile');
    fs.mkdirSync(profile);
    child = spawn(chromium.executablePath(), ['--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--disable-dev-shm-usage', '--enable-unsafe-extension-debugging', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.once('error', error => { childError = error; });
    childExited = new Promise(resolve => child.once('close', resolve));
    child.stderr.on('data', data => { browserLog = (browserLog + data).slice(-16_384); });
    const deadline = Date.now() + 15_000;
    const endpointFile = path.join(profile, 'DevToolsActivePort');
    let endpoint;
    while (!endpoint && Date.now() < deadline) {
      if (childError) throw childError;
      assert(child.exitCode === null && child.signalCode === null, `Fixture Chromium exited during startup: ${browserLog}`);
      if (fs.existsSync(endpointFile)) {
        const [port, socket] = fs.readFileSync(endpointFile, 'utf8').trim().split('\n');
        if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535 && /^\/devtools\/browser\/[a-f0-9-]+$/.test(socket)) {
          endpoint = `ws://127.0.0.1:${port}${socket}`;
        }
      }
      if (!endpoint) await delay(100);
    }
    assert(endpoint, `Fixture Chromium did not publish its endpoint within 15 seconds: ${browserLog}`);
    // noDefaults avoids Playwright's original-session visibility override; no DOM state is emulated.
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 10_000 });
    context = browser.contexts()[0];
    assert(context, 'The fresh fixture must have a default browser context');
    context.setDefaultTimeout(10_000);
    const page = await context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${origin}/`);
    await page.bringToFront();
    const originalDocument = await page.evaluate(() => performance.timeOrigin);
    // Install only after this real HTTP document exists: its document_start has already passed.
    const browserSession = await browser.newBrowserCDPSession();
    const installed = await browserSession.send('Extensions.loadUnpacked', { path: extension, enableInIncognito: false });
    const workerURL = `chrome-extension://${installed.id}/`;
    const worker = context.serviceWorkers().find(worker => worker.url().startsWith(workerURL))
      || await context.waitForEvent('serviceworker', { predicate: worker => worker.url().startsWith(workerURL) });
    await worker.evaluate(async () => { await __contextTest.ready; });
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
    assert(Number.isInteger(tabId));
    const installedCollector = await worker.evaluate(async id => {
      const results = await chrome.scripting.executeScript({ target: { tabId: id },
        func: () => {
          globalThis.__contextOriginalGetter = globalThis.__iKnowItPageContext;
          return typeof globalThis.__contextOriginalGetter;
        } });
      return results.find(result => result.frameId === 0)?.result;
    }, tabId);
    assert.equal(installedCollector, 'function', 'Installing the extension must initialize a document that was already open');
    assert.equal(await page.evaluate(() => performance.timeOrigin), originalDocument, 'Existing-page initialization must not reload the document');
    await worker.evaluate(async () => { await __contextTest.updatePages(); await __contextTest.updatePages(); });
    const reusedCollector = await worker.evaluate(async id => {
      const results = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => {
        const same = globalThis.__contextOriginalGetter === globalThis.__iKnowItPageContext;
        delete globalThis.__contextOriginalGetter;
        return same;
      } });
      return results.find(result => result.frameId === 0)?.result;
    }, tabId);
    assert.equal(reusedCollector, true, 'Repeated healthy page synchronization must keep the same collector');
    console.log('PASS: extension installation initializes the already-open HTTP document without navigation or reload');
    const read = () => worker.evaluate(async id => {
      const results = await chrome.scripting.executeScript({ target: { tabId: id }, func: __contextTest.pageContext });
      return results.find(result => result.frameId === 0)?.result;
    }, tabId);
    const toggle = value => worker.evaluate(value => __contextTest.setEnabled(value), value);
    let seedNumber = 0;
    const seed = async () => {
      const number = ++seedNumber;
      await page.waitForFunction(() => document.visibilityState === 'visible' && document.hasFocus());
      const previousObservation = (await read()).pointerAnchor?.observedAt;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await page.mouse.move(140, 140);
        await page.mouse.move(180, 180);
        const result = await read();
        const diagnostics = await worker.evaluate(async id => {
          const results = await chrome.scripting.executeScript({ target: { tabId: id },
            func: () => globalThis.__contextSeedDebug });
          return results.find(result => result.frameId === 0)?.result;
        }, tabId);
        const accepted = !!result.pointerAnchor && result.pointerAnchor.observedAt !== previousObservation
          && result.pointerAnchor.client.x === 180 && result.pointerAnchor.client.y === 180;
        console.log(JSON.stringify({ check: 'seed-calibration', number, attempt,
          accepted, observedAt: result.pointerAnchor?.observedAt, previousObservation,
          ageMs: result.pointerAnchor?.ageMs, diagnostics }));
        if (accepted) {
          assert.equal(result.pointerAnchor.client.x, 180);
          assert.equal(result.pointerAnchor.client.y, 180);
          assert(Number.isFinite(result.pointerAnchor.ageMs) && result.pointerAnchor.ageMs >= 0);
          assert(Number.isFinite(result.pointerAnchor.screen.x) && Number.isFinite(result.pointerAnchor.screen.y));
          return result;
        }
        if (attempt < 3) await page.waitForTimeout(100);
      }
      assert.fail('Three real browser mouse attempts failed to seed isolated calibration; see seed-calibration diagnostics');
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
    await page.waitForTimeout(1250); // Exercise stationary use beyond the former one-second lifetime.
    const stationary = (await read()).pointerAnchor;
    assert(stationary && stationary.ageMs > 1000);
    assert.equal(stationary.observedAt, initial.pointerAnchor.observedAt, 'Reading an old calibration must not fabricate a fresh timestamp');
    assert.deepEqual(stationary.screen, initial.pointerAnchor.screen);
    assert.deepEqual(stationary.client, initial.pointerAnchor.client);
    await page.evaluate(() => dispatchEvent(new PointerEvent('pointermove', {
      pointerType: 'mouse', buttons: 0, clientX: 500, clientY: 500, screenX: 700, screenY: 700,
    })));
    assert.equal((await read()).pointerAnchor.observedAt, initial.pointerAnchor.observedAt, 'A synthetic event cannot replace an existing calibration');
    await page.evaluate(() => { globalThis.__iKnowItPageContext = () => ({ forged: true, pointerAnchor: { client: { x: -999 } } }); });
    const isolated = await read();
    assert.equal(isolated.forged, undefined, 'Main-world code must not replace the isolated getter used by executeScript');
    assert.equal(isolated.pointerAnchor.client.x, 180);
    const beforeEqualResize = await read();
    await page.evaluate(() => dispatchEvent(new Event('resize')));
    const equalResize = await read();
    assert.deepEqual(equalResize.viewport, beforeEqualResize.viewport);
    assert.deepEqual(equalResize.pageWindow, beforeEqualResize.pageWindow);
    assert.equal(equalResize.pointerAnchor, undefined, 'An equal-size resize signal must permanently invalidate calibration');
    assert.equal((await read()).pointerAnchor, undefined, 'Reading unchanged geometry cannot revive a structurally invalidated calibration');
    await seed();
    const restoredGeometry = await worker.evaluate(async id => {
      const results = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => {
        // Same-turn fixture navigation avoids event/poll timing: the getter must clear on mismatch itself.
        const original = location.href;
        history.replaceState(null, '', `${original}?calibration-drift`);
        const changed = globalThis.__iKnowItPageContext();
        history.replaceState(null, '', original);
        return { changed, restored: globalThis.__iKnowItPageContext() };
      } });
      return results.find(result => result.frameId === 0).result;
    }, tabId);
    assert.equal(restoredGeometry.changed.pointerAnchor, undefined);
    assert.equal(restoredGeometry.restored.pointerAnchor, undefined, 'Returning to identical geometry without intervening events cannot resurrect calibration');
    await seed();
    await page.mouse.move(-20, -20);
    const logVisibility = async stage => console.log(JSON.stringify({ check: 'real-tab-visibility', stage,
      document: await page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus() })),
      tabs: await worker.evaluate(async id => {
        const { windowId } = await chrome.tabs.get(id);
        return (await chrome.tabs.query({ windowId })).map(({ id, active }) => ({ id, active }));
      }, tabId),
    }));
    let otherTab;
    try {
      otherTab = await worker.evaluate(async id => {
        const { windowId } = await chrome.tabs.get(id);
        return chrome.tabs.create({ windowId, active: true, url: 'about:blank' });
      }, tabId);
      await logVisibility('switched-away');
      // Animation-frame polling pauses in a hidden tab; use a bounded real-state timer.
      await page.waitForFunction(() => document.visibilityState === 'hidden', undefined, { polling: 100, timeout: 10_000 });
      await worker.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
      await page.waitForFunction(() => document.visibilityState === 'visible', undefined, { polling: 100, timeout: 10_000 });
      await logVisibility('returned');
      assert.equal((await read()).pointerAnchor, undefined, 'Hiding and reopening the real fixture tab must clear calibration');
    } catch (error) {
      await logVisibility('failed');
      throw error;
    } finally {
      if (otherTab) await worker.evaluate(id => chrome.tabs.remove(id), otherTab.id);
    }
    await seed();
    await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
    await page.mouse.move(200, 200);
    assert.equal((await read()).pointerAnchor, undefined, 'A lifecycle freeze signal must stop collection in the isolated script');
    await toggle(false);
    await page.evaluate(() => document.dispatchEvent(new Event('resume')));
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
    console.log('PASS: real Chromium extension isolated world; production background executeScript reads trusted calibration beyond one stationary second without renewing timestamps; synthetic input and main-world getter spoofing rejected; equal-size resize and getter mismatch cannot resurrect old calibration; hidden-tab and lifecycle signals, OFF/ON, navigation, scroll, and resize invalidation. Native macOS geometry and target-app paste are outside this check.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (browser) await Promise.race([browser.close().catch(() => {}), delay(2000)]);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([childExited, delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([childExited, delay(2000)]);
        assert(child.exitCode !== null || child.signalCode !== null, 'Fixture Chromium did not exit; preserving its temporary profile');
      }
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
