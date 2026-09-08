// Exercise the real popup and background source without installing an extension or controlling Codex.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { chromium } = require('playwright');
const root = __dirname;
const output = process.env.IKI_RUN_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'i-know-it-popup-'));
fs.mkdirSync(output, { recursive: true });
function event() { return { listeners: [], addListener(fn) { this.listeners.push(fn); } }; }
let settings = { enabled: true }, writes = 0, badge, mode = 'normal', release;
const messages = [], native = [];
const popupURL = 'chrome-extension://fixture/popup.html';
const chrome = {
  runtime: { id: 'fixture', getURL: file => `chrome-extension://fixture/${file}`, onInstalled: event(), onStartup: event(), onMessage: event(),
    connectNative() { return { postMessage: message => native.push(message), onMessage: event(), onDisconnect: event() }; } },
  storage: { local: { async get() { return settings; }, async set(value) { settings = value; writes++; } } },
  action: { async setBadgeText({text}) { badge = text; }, async setTitle() {}, onClicked: event() },
  alarms: { async create() {}, onAlarm: event() },
  windows: { async getLastFocused() { return { focused: false }; }, onFocusChanged: event(), onBoundsChanged: event() },
  tabs: { onActivated: event(), onRemoved: event(), onUpdated: event(), onZoomChange: event() },
};
const sandbox = vm.createContext({ chrome, setTimeout, clearTimeout, console });
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), sandbox);
function dispatch(message) {
  return new Promise((resolve, reject) => {
    const listener = chrome.runtime.onMessage.listeners.find(fn => fn(message, { id: 'fixture', url: popupURL }, resolve) === true);
    if (!listener) reject(new Error('Popup message was not accepted'));
  });
}
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1);
  if (!['popup.html', 'popup.js'].includes(name)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
  res.end(fs.readFileSync(path.join(root, name)));
});
(async () => {
  await vm.runInContext('ready', sandbox);
  assert.equal(chrome.action.onClicked.listeners.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))).action.default_popup, 'popup.html');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 320, height: 360 }, colorScheme: 'light' });
    await context.exposeFunction('fixtureMessage', async message => {
      messages.push(message);
      if (mode === 'offline') throw new Error('Disconnected');
      if (message.type === 'set-enabled' && mode === 'slow') await new Promise(resolve => { release = resolve; });
      const result = await dispatch(message);
      if (message.type === 'set-enabled' && mode === 'lost-reply') throw new Error('Reply lost after update');
      return result;
    });
    await context.addInitScript(() => { globalThis.chrome = { runtime: { sendMessage: message => window.fixtureMessage(message) } }; });
    const url = `http://127.0.0.1:${server.address().port}/popup.html`;
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    const control = page.getByRole('switch', { name: 'Screenshot context' });
    await page.waitForFunction(() => !document.querySelector('#enabled').disabled);
    assert(await control.isChecked()); assert.equal(writes, 0, 'Opening the popup must not flip the switch');
    assert.equal(await page.locator('#status').textContent(), 'ON');
    await page.locator('body').screenshot({ path: path.join(output, 'popup-on.png') });
    await control.click();
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'OFF' && !document.querySelector('#enabled').disabled);
    assert.equal(settings.enabled, false); assert.equal(badge, 'OFF');
    assert.equal(native.filter(m => m.type === 'enabled').at(-1).enabled, false);
    await page.locator('body').screenshot({ path: path.join(output, 'popup-off.png') });
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#enabled').disabled);
    assert(!(await control.isChecked())); assert.equal(writes, 1);
    await control.focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'ON' && !document.querySelector('#enabled').disabled);
    assert.equal(settings.enabled, true); assert.equal(badge, 'ON');
    assert(await control.evaluate(el => el === document.activeElement));
    mode = 'slow'; await control.click();
    assert(await control.isDisabled());
    await page.waitForTimeout(30); assert.equal(settings.enabled, true);
    release();
    await page.waitForFunction(() => !document.querySelector('#enabled').disabled);
    assert.equal(settings.enabled, false); mode = 'normal';
    mode = 'lost-reply'; await control.click();
    await page.waitForFunction(() => !document.querySelector('#enabled').disabled && !document.querySelector('#error').hidden);
    assert(await control.isChecked()); assert.equal(settings.enabled, true, 'Read back authoritative state after an uncertain reply');
    mode = 'offline'; await control.click();
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'UNAVAILABLE');
    assert(await control.isDisabled());
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'UNAVAILABLE');
    assert(await control.isDisabled()); assert(await page.locator('#error').isVisible());
    mode = 'normal'; await page.reload();
    await page.waitForFunction(() => !document.querySelector('#enabled').disabled);
    assert(await control.isChecked());
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.locator('body').screenshot({ path: path.join(output, 'popup-dark.png') });
    const reduced = await page.locator('.track').evaluate(el => getComputedStyle(el, '::after').transitionDuration);
    assert.equal(reduced, '0s');
    await page.setViewportSize({ width: 280, height: 420 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    const report = { checkedAt: new Date().toISOString(), checks: ['Popup opens without changing state', 'Mouse and keyboard switch update background, native host messages and badge', 'Reopening restores state', 'Pending requests disable duplicate input', 'Lost reply reads back actual state', 'Disconnected states stay disabled and recover on reopen', 'Light/dark layout, reduced motion, narrow width and no script errors'], scope: 'Real popup DOM and background code with fixture Chrome APIs; no extension-manager or Codex UI control' };
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
