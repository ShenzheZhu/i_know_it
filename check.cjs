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
const connections = [];
let connection;
const chrome = {
  runtime: { id: 'extension-id', connectNative(name) {
    assert.equal(name, 'com.iknowit.bridge');
    connection = { closed: false, messages: [], postMessage(message) {
      if (this.closed) throw new Error('Disconnected port');
      this.messages.push(message); messages.push(message);
    }, onMessage: event(), onDisconnect: event() };
    connections.push(connection);
    return connection;
  }, onInstalled: event(), onStartup: event(), onMessage: event() },
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
  const normalInjection = injected;
  let completeRead;
  injected = () => new Promise(resolve => { completeRead = resolve; });
  await connection.onMessage.emit({ type: 'request-context', requestId: 'pending-off' });
  await pause();
  assert.equal(typeof completeRead, 'function');
  await chrome.action.onClicked.emit();
  const offIndex = messages.length;
  completeRead(await normalInjection());
  await pause();
  const stoppedRead = messages.find(message => message.requestId === 'pending-off');
  assert.equal(stoppedRead.available, false);
  assert.equal(stoppedRead.url, undefined);
  assert(!messages.slice(offIndex).some(message => message.available === true));
  injected = normalInjection;
  await chrome.action.onClicked.emit();
  await pause();

  injected = () => new Promise(resolve => { completeRead = resolve; });
  await connection.onMessage.emit({ type: 'request-context', requestId: 'old-host' });
  await pause();
  const previousConnection = connection;
  previousConnection.closed = true;
  await previousConnection.onDisconnect.emit();
  const connectionCount = connections.length;
  await chrome.alarms.onAlarm.emit({ name: 'unrelated' });
  assert.equal(connections.length, connectionCount);
  injected = normalInjection;
  await chrome.alarms.onAlarm.emit({ name: 'native-reconnect' });
  assert.equal(connections.length, connectionCount + 1);
  assert.equal(connection.messages[0].type, 'enabled');
  assert.equal(connection.messages[0].enabled, true);
  completeRead(await normalInjection());
  await pause();
  assert(!connection.messages.some(message => message.requestId === 'old-host'),
    'An old host request must never be delivered to a replacement native connection');
  assert.equal(connection.messages.at(-1).available, true);
  const readsBeforeOldMessage = reads;
  await previousConnection.onMessage.emit({ type: 'request-context', requestId: 'late-old-port' });
  await pause();
  assert.equal(reads, readsBeforeOldMessage, 'Discard late messages from a disconnected host');
  await previousConnection.onDisconnect.emit();
  await chrome.alarms.onAlarm.emit({ name: 'native-reconnect' });
  assert.equal(connections.length, connectionCount + 1, 'A connected host must not be duplicated');

  window.focused = false;
  await connection.onMessage.emit({ type: 'request-context', requestId: 'blur' });
  await pause();
  assert.equal(messages.at(-1).available, false);
  assert.equal(messages.at(-1).url, undefined);
  assert.equal(messages.at(-1).window.focused, false);
  window.focused = true;
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
  connection.closed = true;
  await connection.onDisconnect.emit();
  for (const namespace of Object.values(chrome)) {
    for (const value of Object.values(namespace)) if (value?.listeners) value.listeners.length = 0;
  }
  settings = { enabled: false };
  const restarted = vm.createContext({ chrome, setTimeout, clearTimeout, console });
  vm.runInContext(source, restarted);
  await vm.runInContext('ready', restarted);
  await pause();
  assert.equal(messages.at(-1).type, 'enabled');
  assert.equal(messages.at(-1).enabled, false);
  assert.equal(reads, beforeForged, 'A disabled worker restart must not read page context');
  connection.closed = true;
  await connection.onDisconnect.emit();
  await chrome.alarms.onAlarm.emit({ name: 'native-reconnect' });
  await pause();
  assert.equal(connection.messages[0].enabled, false);
  assert.equal(reads, beforeForged, 'A disabled reconnect must not read page context');

  const handlers = {};
  const contentMessages = [];
  const page = { url: 'https://example.com/', title: 'Example', visibility: 'visible', width: 1200, height: 800, x: 0, y: 0, ratio: 2, scale: 1, offsetLeft: 0, offsetTop: 0 };
  function listen(target, name, handler, options) {
    if (target !== 'document') assert.equal(options?.passive, true);
    handlers[`${target}:${name}`] = handler;
  }
  const noWrite = { set() { assert.fail('The content reporter must not modify page objects'); } };
  const document = new Proxy({
    get title() { return page.title; }, get visibilityState() { return page.visibility; },
    addEventListener(name, handler, options) { listen('document', name, handler, options); },
  }, noWrite);
  const viewport = new Proxy({
    get scale() { return page.scale; }, get offsetLeft() { return page.offsetLeft; }, get offsetTop() { return page.offsetTop; },
    addEventListener(name, handler, options) { listen('viewport', name, handler, options); },
  }, noWrite);
  let interval;
  const contentChrome = { runtime: { sendMessage(message) { contentMessages.push(message); return Promise.resolve(); } } };
  const content = { document, visualViewport: viewport, chrome: contentChrome,
    location: new Proxy({ get href() { return page.url; } }, noWrite),
    history: new Proxy(Object.freeze({ pushState() {}, replaceState() {} }), noWrite),
    addEventListener(name, handler, options) { listen('window', name, handler, options); },
    setInterval(handler, milliseconds) { assert.equal(milliseconds, 1000); interval = handler; },
  };
  for (const [name, key] of Object.entries({ innerWidth: 'width', innerHeight: 'height', scrollX: 'x', scrollY: 'y', devicePixelRatio: 'ratio' })) {
    Object.defineProperty(content, name, { get() { return page[key]; }, set: noWrite.set });
  }
  const originalHistory = content.history.pushState;
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'context.js'), 'utf8'), vm.createContext(content));
  assert.equal(contentMessages.length, 1);
  assert.equal(contentMessages[0].type, 'context-changed');
  assert.deepEqual(Object.keys(contentMessages[0]), ['type'], 'Only a change signal should leave the content script');
  interval();
  handlers['window:scroll']();
  assert.equal(contentMessages.length, 1, 'Unchanged metadata should not produce duplicate signals');
  page.y = 600;
  handlers['window:scroll']({ preventDefault() { assert.fail('Do not cancel scrolling'); } });
  page.width = 800;
  handlers['window:resize']();
  page.scale = 1.5;
  handlers['viewport:resize']();
  page.offsetLeft = 30;
  handlers['viewport:scroll']();
  assert.equal(contentMessages.length, 5);
  page.url = 'https://example.com/#settings';
  handlers['window:hashchange']();
  page.url = 'https://example.com/account';
  handlers['window:popstate']();
  page.title = 'Account';
  interval();
  assert.equal(contentMessages.length, 8, 'SPA URL and title changes must be detected');
  page.visibility = 'hidden';
  page.url = 'https://example.com/private';
  handlers['document:visibilitychange']();
  interval();
  assert.equal(contentMessages.length, 8, 'Hidden tabs must remain quiet');
  page.visibility = 'visible';
  handlers['document:visibilitychange']();
  assert.equal(contentMessages.length, 9);
  assert.equal(content.history.pushState, originalHistory);
  contentChrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated'); };
  page.y++;
  assert.doesNotThrow(() => handlers['window:scroll'](), 'An unloaded extension must not throw errors into the page');
  console.log('PASS: fresh correlated context; negative display coordinates; zoom; persisted toggle; serialized rapid toggles; disabled startup/reconnect; pending reads across OFF; host disconnect/reconnect isolation; passive content events and unchanged page; no reads while off; focus loss; tab race; restricted pages; forged/iframe messages rejected.');
})().catch(error => { console.error(error); process.exitCode = 1; });
