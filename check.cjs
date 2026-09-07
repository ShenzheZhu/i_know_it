const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 90));
function event() { return { listeners: [], addListener(fn) { this.listeners.push(fn); }, async emit(...args) { await Promise.all(this.listeners.map(fn => fn(...args))); } }; }
const messages = [];
let settings = { enabled: true };
let saveSettings = async (value) => { settings = value; };
let window = { id: 7, focused: true, incognito: false, left: -1280, top: 40, width: 1200, height: 800, state: 'normal', tabs: [{ id: 4, active: true, incognito: false, status: 'complete', url: 'https://example.com/settings' }] };
let injected = async () => [{ frameId: 0, result: { url: 'https://example.com/settings', title: 'Settings', viewport: { width: 1160, height: 700 }, scroll: { x: 0, y: 200 }, devicePixelRatio: 2, visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0 } } }];
let reads = 0;
const connection = { postMessage(message) { messages.push(message); }, onMessage: event(), onDisconnect: event() };
const chrome = {
  runtime: { id: 'extension-id', connectNative(name) { assert.equal(name, 'com.iknowit.bridge'); return connection; }, onInstalled: event(), onStartup: event(), onMessage: event() },
  storage: { local: { async get() { return settings; }, async set(value) { await saveSettings(value); } } },
  action: { async setBadgeText() {}, async setTitle() {}, onClicked: event() },
  alarms: { async create(_name, options) { assert.equal(options.periodInMinutes, 0.5); }, onAlarm: event() },
  windows: { async getLastFocused() { return structuredClone(window); }, onFocusChanged: event(), onBoundsChanged: event() },
  tabs: { async getZoom() { return 1.25; }, onActivated: event(), onRemoved: event(), onUpdated: event(), onZoomChange: event() },
  scripting: { async executeScript() { reads++; return injected(); } },
};
const sandbox = vm.createContext({ chrome, setTimeout, clearTimeout, console });
vm.runInContext(source, sandbox);
(async () => {
  await vm.runInContext('ready', sandbox);
  await pause();
  assert.equal(messages[0].type, 'enabled');
  assert.equal(messages[0].enabled, true);
  assert.equal(messages.at(-1).available, true);
  assert.equal(messages.at(-1).window.left, -1280);
  assert.equal(messages.at(-1).zoom, 1.25);
  await connection.onMessage.emit({ type: 'request-context', requestId: 'request-1' });
  await pause();
  assert.equal(messages.at(-1).requestId, 'request-1');
  assert.equal(messages.at(-1).url, window.tabs[0].url);
  await chrome.action.onClicked.emit();
  assert.equal(settings.enabled, false);
  assert.equal(messages.at(-1).enabled, false);
  const disabledReads = reads;
  await connection.onMessage.emit({ type: 'request-context', requestId: 'off' });
  await pause();
  assert.equal(messages.at(-1).available, false);
  assert.equal(messages.at(-1).requestId, 'off');
  assert.equal(messages.at(-1).url, undefined);
  assert.equal(reads, disabledReads);
  await chrome.action.onClicked.emit();
  await pause();
  assert.equal(settings.enabled, true);
  assert.equal(messages.at(-1).available, true);
  let pendingWrites = 0;
  let maximumWrites = 0;
  saveSettings = async (value) => {
    pendingWrites++;
    maximumWrites = Math.max(maximumWrites, pendingWrites);
    await new Promise(resolve => setTimeout(resolve, value.enabled ? 5 : 50));
    settings = value;
    pendingWrites--;
  };
  await Promise.all([chrome.action.onClicked.emit(), chrome.action.onClicked.emit()]);
  await pause();
  assert.equal(settings.enabled, true, 'Rapid double-click must persist the final enabled state');
  assert.equal(maximumWrites, 1, 'Toggle writes must not overlap');
  assert.equal(messages.filter(message => message.type === 'enabled').at(-1).enabled, true);
  saveSettings = async (value) => { settings = value; };
  window.focused = false;
  await connection.onMessage.emit({ type: 'request-context', requestId: 'blur' });
  await pause();
  assert.equal(messages.at(-1).available, false);
  assert.equal(messages.at(-1).url, undefined);
  assert.equal(messages.at(-1).window.focused, false);
  window.focused = true;
  const normalInjection = injected;
  injected = async () => { const result = await normalInjection(); window.tabs[0].id = 5; return result; };
  await connection.onMessage.emit({ type: 'request-context', requestId: 'race' });
  await pause();
  assert.equal(messages.at(-1).available, false);
  assert.equal(messages.at(-1).requestId, 'race');
  assert.equal(messages.at(-1).url, undefined);
  injected = async () => { throw new Error('Restricted page'); };
  await connection.onMessage.emit({ type: 'request-context', requestId: 'restricted' });
  await pause();
  assert.equal(messages.at(-1).available, false);
  assert.equal(messages.at(-1).url, undefined);
  const beforeForged = reads;
  await chrome.runtime.onMessage.emit({ type: 'context-changed' }, { id: 'other-extension', frameId: 0, tab: { active: true }, url: 'https://example.com/' });
  await chrome.runtime.onMessage.emit({ type: 'context-changed' }, { id: 'extension-id', frameId: 1, tab: { active: true }, url: 'https://example.com/' });
  await pause();
  assert.equal(reads, beforeForged);
  settings = { enabled: false };
  const restarted = vm.createContext({ chrome, setTimeout, clearTimeout, console });
  vm.runInContext(source, restarted);
  await vm.runInContext('ready', restarted);
  await pause();
  assert.equal(messages.at(-1).type, 'enabled');
  assert.equal(messages.at(-1).enabled, false);
  assert.equal(reads, beforeForged, 'A disabled worker restart must not read page context');
  console.log('PASS: fresh correlated context; negative display coordinates; zoom; persisted toggle; serialized rapid toggles; disabled restart; no reads while off; focus loss; tab race; restricted pages; forged/iframe messages rejected.');
})().catch(error => { console.error(error); process.exitCode = 1; });
