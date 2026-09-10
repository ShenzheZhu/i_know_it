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
let settings = { enabled: true }, writes = 0, badge, mode = 'normal', release, permissionReply, nativeSendFails = false;
const messages = [], native = [], broadcasts = [];
let connection;
const popupURL = 'chrome-extension://fixture/popup.html';
const chrome = {
  runtime: { id: 'fixture', getURL: file => `chrome-extension://fixture/${file}`, onInstalled: event(), onStartup: event(), onMessage: event(),
    async sendMessage(message) { broadcasts.push(message); },
    connectNative() { connection = { postMessage(message) {
      if (nativeSendFails && message.type === 'request-input-access') throw new Error('Native port closed');
      native.push(message);
    }, onMessage: event(), onDisconnect: event() }; return connection; } },
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
function popupChrome() {
  globalThis.chrome = { runtime: { id: 'fixture', async sendMessage(message) {
    try { return await window.fixtureMessage(message); }
    finally { if (message.type === 'request-input-access') globalThis.fixturePermissionReplies = (globalThis.fixturePermissionReplies || 0) + 1; }
  },
    onMessage: { addListener(fn) { globalThis.fixtureListener = fn; } } } };
}
async function nativeStatus(page, status) {
  const start = broadcasts.length;
  connection.onMessage.listeners[0]({ type: 'input-status', status });
  for (const message of broadcasts.slice(start)) await page.evaluate(value => globalThis.fixtureListener(value, { id: 'fixture' }), message);
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
      if (message.type === 'request-input-access' && mode === 'permission-rejection') throw new Error('Permission reply unavailable');
      if (message.type === 'set-enabled' && mode === 'slow') await new Promise(resolve => { release = resolve; });
      if (message.type === 'request-input-access' && mode === 'slow-permission') await new Promise(resolve => { release = resolve; });
      // Change the background state without delivering its broadcast to this popup.
      if (message.type === 'request-input-access' && mode === 'reply-only-ready') connection.onMessage.listeners[0]({ type: 'input-status', status: 'ready' });
      if (message.type === 'request-input-access' && mode === 'reply-only-OFF') await dispatch({ type: 'set-enabled', enabled: false });
      if (message.type === 'request-input-access' && mode === 'reply-only-disconnected') connection.onDisconnect.listeners[0]();
      const pending = message.type === 'request-input-access' ? permissionReply : undefined;
      const result = await dispatch(message);
      if (message.type === 'request-input-access' && mode === 'permission-lost-reply') throw new Error('Permission reply lost after send');
      if (pending) {
        pending.sent();
        await pending.wait;
        if (pending.reject) throw new Error('Delayed permission reply unavailable');
      }
      if (message.type === 'set-enabled' && mode === 'lost-reply') throw new Error('Reply lost after update');
      return result;
    });
    await context.addInitScript(popupChrome);
    const url = `http://127.0.0.1:${server.address().port}/popup.html`;
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    const control = page.getByRole('switch', { name: 'Chrome screenshot context' });
    await page.waitForFunction(() => !document.querySelector('#enabled').disabled);
    assert(await control.isChecked()); assert.equal(writes, 0, 'Opening the popup must not flip the switch');
    assert.equal(await page.locator('#status').textContent(), 'ON');
    assert.match(await page.locator('#input-status').textContent(), /Companion unavailable/);
    const allow = page.getByRole('button', { name: 'Allow region context' });
    assert(await allow.isHidden());
    assert.equal(native.filter(m => m.type === 'request-input-access').length, 0);
    await nativeStatus(page, 'permission-required');
    assert(await allow.isVisible());
    assert.match(await page.locator('#input-status').textContent(), /Keystrokes are not stored/);
    await page.evaluate(() => {
      fixtureListener({ type: 'input-status', inputStatus: 'ready' }, { id: 'foreign' });
      fixtureListener({ type: 'input-status', inputStatus: 'ready' }, { id: 'fixture', tab: { id: 1 } });
    });
    assert(await allow.isVisible(), 'Forged status messages must not hide the permission button');
    assert.equal(native.filter(m => m.type === 'request-input-access').length, 0, 'Opening the popup and reading status must not request permission');
    await page.locator('body').screenshot({ path: path.join(output, 'popup-permission.png') });
    mode = 'slow-permission'; await allow.click();
    assert(await allow.isDisabled());
    assert.equal(native.filter(m => m.type === 'request-input-access').length, 0);
    release();
    await page.waitForFunction(() => !document.querySelector('#allow-region').disabled);
    mode = 'normal';
    assert.equal(native.filter(m => m.type === 'request-input-access').length, 1, 'Only an explicit permission button click sends a request');
    const guidance = 'If no macOS dialog appears, open System Settings > Privacy & Security > Input Monitoring, allow the entry shown by macOS, then return to Chrome.';
    const failedSend = 'Permission request could not be sent. Reopen this panel to retry.';
    const unconfirmed = 'Could not confirm the permission request. Reopen this panel to retry.';
    assert.equal(await page.locator('#input-status').textContent(), guidance, 'A sent request with unchanged status explains the manual settings path');
    assert(await allow.isVisible());
    await allow.click();
    await page.waitForFunction(() => globalThis.fixturePermissionReplies === 2);
    assert.equal(native.filter(m => m.type === 'request-input-access').length, 2, 'The permission button remains available for an explicit retry');
    assert.equal(await page.locator('#input-status').textContent(), guidance);
    await page.locator('body').screenshot({ path: path.join(output, 'popup-permission-guidance.png') });
    nativeSendFails = true;
    await allow.click();
    await page.waitForFunction(() => globalThis.fixturePermissionReplies === 3);
    nativeSendFails = false;
    assert.equal(await page.locator('#input-status').textContent(), failedSend, 'A native port send failure is reported in the existing status area');
    assert(await allow.isEnabled());
    assert.equal(native.filter(m => m.type === 'request-input-access').length, 2);
    await nativeStatus(page, 'ready');
    await nativeStatus(page, 'permission-required');
    assert.match(await page.locator('#input-status').textContent(), /Keystrokes are not stored/, 'A newer status clears the failed-send message');
    mode = 'permission-rejection';
    await allow.click();
    await page.waitForFunction(() => globalThis.fixturePermissionReplies === 4);
    mode = 'normal';
    assert.equal(await page.locator('#input-status').textContent(), unconfirmed, 'A rejected promise cannot establish whether the native request was sent');
    assert(await allow.isEnabled());
    const beforeLostReply = native.filter(m => m.type === 'request-input-access').length;
    mode = 'permission-lost-reply';
    await allow.click();
    await page.waitForFunction(() => globalThis.fixturePermissionReplies === 5);
    mode = 'normal';
    assert.equal(native.filter(m => m.type === 'request-input-access').length, beforeLostReply + 1, 'The lost-reply fixture really sends the native request');
    assert.equal(await page.locator('#input-status').textContent(), unconfirmed, 'A lost reply after successful send must not claim that sending failed');
    assert(await allow.isEnabled());
    const explicitPermissionRequests = native.filter(m => m.type === 'request-input-access').length;
    await nativeStatus(page, 'ready');
    assert(await allow.isHidden());
    assert.match(await page.locator('#input-status').textContent(), /monitoring is on/);
    await nativeStatus(page, 'unavailable');
    assert(await allow.isHidden());
    assert.match(await page.locator('#input-status').textContent(), /monitoring unavailable/);
    await nativeStatus(page, 'ready');
    await page.locator('body').screenshot({ path: path.join(output, 'popup-on.png') });
    await control.click();
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'OFF' && !document.querySelector('#enabled').disabled);
    assert.equal(settings.enabled, false); assert.equal(badge, 'OFF');
    assert.equal(native.filter(m => m.type === 'enabled').at(-1).enabled, false);
    await nativeStatus(page, 'permission-required');
    assert(await allow.isHidden());
    assert(await page.locator('#input-status').isHidden(), 'OFF hides the region setup controls');
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
    assert.equal(native.filter(m => m.type === 'request-input-access').length, explicitPermissionRequests, 'Toggles, reloads and reconnect errors must never request permission');
    await nativeStatus(page, 'ready');
    connection.onDisconnect.listeners[0]();
    await page.evaluate(message => globalThis.fixtureListener(message, { id: 'fixture' }), broadcasts.at(-1));
    assert.match(await page.locator('#input-status').textContent(), /Companion unavailable/);
    assert(await allow.isHidden());
    await chrome.alarms.onAlarm.listeners[0]({ name: 'native-reconnect' });
    await nativeStatus(page, 'permission-required');
    const staleReplies = [];
    for (const reject of [false, true]) {
      for (const newer of ['ready', 'OFF', 'disconnected', 'ready then permission-required', 'switch pending']) {
        await nativeStatus(page, 'permission-required');
        const replies = await page.evaluate(() => globalThis.fixturePermissionReplies || 0);
        let finish, sent;
        const dispatched = new Promise(resolve => { sent = resolve; });
        permissionReply = { reject, sent, wait: new Promise(resolve => { finish = resolve; }) };
        await allow.click();
        await dispatched;
        permissionReply = undefined;
        assert(await allow.isDisabled());
        if (newer === 'ready') await nativeStatus(page, 'ready');
        if (newer === 'ready then permission-required') {
          await nativeStatus(page, 'ready');
          await nativeStatus(page, 'permission-required');
        }
        if (newer === 'OFF' || newer === 'switch pending') {
          if (newer === 'switch pending') mode = 'slow';
          await control.click();
          await page.waitForFunction(pending => pending ? document.querySelector('#enabled').disabled : document.querySelector('#status').textContent === 'OFF' && !document.querySelector('#enabled').disabled, newer === 'switch pending');
        }
        if (newer === 'disconnected') {
          connection.onDisconnect.listeners[0]();
          await page.evaluate(message => globalThis.fixtureListener(message, { id: 'fixture' }), broadcasts.at(-1));
        }
        const visibleState = () => page.evaluate(() => ({
          inputText: document.querySelector('#input-status').textContent,
          inputHidden: document.querySelector('#input-status').hidden,
          permissionHidden: document.querySelector('#allow-region').hidden,
          permissionDisabled: document.querySelector('#allow-region').disabled,
          toggleDisabled: document.querySelector('#enabled').disabled,
          status: document.querySelector('#status').textContent,
          errorHidden: document.querySelector('#error').hidden,
        }));
        const before = await visibleState();
        finish();
        await page.waitForFunction(expected => globalThis.fixturePermissionReplies === expected, replies + 1);
        assert.deepEqual(await visibleState(), before, `A delayed ${reject ? 'failure' : 'success'} must not overwrite ${newer}`);
        staleReplies.push({ rejected: reject, newer });
        if (newer === 'switch pending') {
          release();
          await page.waitForFunction(() => document.querySelector('#status').textContent === 'OFF' && !document.querySelector('#enabled').disabled);
          mode = 'normal';
        }
        if (newer === 'OFF' || newer === 'switch pending') {
          await control.click();
          await page.waitForFunction(() => document.querySelector('#status').textContent === 'ON' && !document.querySelector('#enabled').disabled);
        }
        if (newer === 'disconnected') await chrome.alarms.onAlarm.listeners[0]({ name: 'native-reconnect' });
      }
    }
    const replyOnlyStates = ['ready', 'OFF', 'disconnected'];
    for (const newer of replyOnlyStates) {
      await nativeStatus(page, 'permission-required');
      const replies = await page.evaluate(() => globalThis.fixturePermissionReplies || 0);
      assert(await allow.isVisible());
      mode = `reply-only-${newer}`;
      await allow.click();
      await page.waitForFunction(expected => globalThis.fixturePermissionReplies === expected, replies + 1);
      mode = 'normal';
      assert(await allow.isHidden(), `A reply-only ${newer} state removes stale permission controls`);
      assert(await page.locator('#error').isHidden());
      const inputText = await page.locator('#input-status').textContent();
      assert(![guidance, failedSend, unconfirmed].includes(inputText), `A reply-only ${newer} state shows no stale permission feedback`);
      if (newer === 'ready') assert.equal(inputText, 'Region selection monitoring is on.');
      if (newer === 'OFF') {
        assert.equal(await page.locator('#status').textContent(), 'OFF');
        assert(!(await control.isChecked()));
        assert(await page.locator('#input-status').isHidden());
        await control.click();
        await page.waitForFunction(() => document.querySelector('#status').textContent === 'ON' && !document.querySelector('#enabled').disabled);
      }
      if (newer === 'disconnected') {
        assert.match(inputText, /Companion unavailable/);
        await chrome.alarms.onAlarm.listeners[0]({ name: 'native-reconnect' });
      }
    }
    await nativeStatus(page, 'permission-required');
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.locator('body').screenshot({ path: path.join(output, 'popup-dark.png') });
    const reduced = await page.locator('.track').evaluate(el => getComputedStyle(el, '::after').transitionDuration);
    assert.equal(reduced, '0s');
    // Popup sizing starts at 25 px, unlike an ordinary tab with a pre-sized viewport.
    const layouts = [];
    for (const deviceScaleFactor of [1, 2]) {
      const sized = await browser.newContext({ viewport: { width: 25, height: 25 }, deviceScaleFactor });
      await sized.exposeFunction('fixtureMessage', dispatch);
      await sized.addInitScript(popupChrome);
      const popup = await sized.newPage();
      for (const colorScheme of ['light', 'dark']) {
        await popup.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        for (const initialWidth of [25, 181, 280, 320]) {
          await popup.setViewportSize({ width: initialWidth, height: 25 });
          await popup.goto(url);
          await popup.waitForFunction(() => !document.querySelector('#enabled').disabled);
          await popup.getByRole('button', { name: 'Allow region context' }).click();
          await popup.waitForFunction(expected => document.querySelector('#input-status').textContent === expected, guidance);
          // Feed preferred content size back into the viewport, as the popup host does.
          for (let step = 0; step < 2; step++) {
            const size = await popup.evaluate(() => ({ width: Math.min(800, Math.max(25, document.documentElement.scrollWidth)), height: Math.min(600, Math.max(25, document.body.scrollHeight)) }));
            await popup.setViewportSize(size);
          }
          const bounds = await popup.evaluate(() => {
            const rect = selector => { const { x, y, width, height, right, bottom } = document.querySelector(selector).getBoundingClientRect(); return { x, y, width, height, right, bottom }; };
            return { viewport: innerWidth, height: innerHeight, body: rect('body'), card: rect('.control'), track: rect('.track'), input: rect('#enabled'), text: rect('#switch-title'), guidance: rect('#input-status'), permission: rect('#allow-region'), overflow: document.documentElement.scrollWidth > innerWidth };
          });
          const label = JSON.stringify({ deviceScaleFactor, colorScheme, initialWidth });
          await popup.screenshot({ path: path.join(output, `popup-sized-${deviceScaleFactor}-${colorScheme}-${initialWidth}.png`) });
          assert.equal(bounds.viewport, 320, `Popup intrinsic width: ${label}`);
          assert.equal(bounds.body.width, 320, label);
          assert(!bounds.overflow, label);
          assert(bounds.guidance.x >= 22 && bounds.guidance.right <= 298 && bounds.guidance.bottom <= bounds.permission.y, `Manual settings guidance stays inside popup above its button: ${label}`);
          assert(bounds.body.height <= 600 && bounds.permission.bottom <= bounds.height, `Permission setup stays inside popup: ${label}`);
          assert(bounds.permission.x >= 22 && bounds.permission.right <= 298, `Permission button stays inside popup: ${label}`);
          assert(bounds.track.right <= bounds.card.right - 16 && bounds.track.x >= bounds.text.right + 16, `Switch stays inside card without overlapping text: ${label}`);
          assert.deepEqual(bounds.input, bounds.track, `Visible switch and click target align: ${label}`);
          layouts.push({ deviceScaleFactor, colorScheme, initialWidth, width: bounds.viewport, state: 'permission guidance' });
        }
      }
      await sized.close();
    }
    assert.deepEqual(errors, []);
    const report = { checkedAt: new Date().toISOString(), checks: ['Popup opens without changing state or requesting permission', 'Mouse and keyboard switch update background, native host messages and badge', 'Reopening restores state', 'Pending switch and permission requests disable duplicate input', 'Only explicit permission button click sends a request; toggles and reloads do not', 'Sent requests show manual Input Monitoring guidance and allow an explicit retry', 'Explicit native send failure reports not-sent; rejected and lost replies report unconfirmed delivery', 'A lost permission reply after an actual native send does not claim sending failed', 'Reply-only ready, OFF and disconnected states clear stale permission controls without a delivered broadcast', 'Delayed success and failure preserve newer ready, OFF, disconnected, ready-to-permission-required and pending-switch states', 'Native status updates the open popup without polling; forged status messages are rejected', 'OFF hides region setup, host disconnect clears ready status', 'Lost switch reply reads back actual state', 'Disconnected states stay disabled and recover on reopen', 'Light/dark layout, reduced motion and no script errors', 'Popup preferred-size feedback at 25/181/280/320 px, DPR 1/2, card, permission button and manual guidance containment and aligned click target'], staleReplies, replyOnlyStates, layouts, scope: 'Real popup DOM and background code with fixture Chrome APIs and simulated popup sizing feedback; no extension-manager, System Settings or Codex UI control' };
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
