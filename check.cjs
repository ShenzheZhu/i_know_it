const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 90));
function event() { return { listeners: [], addListener(fn) { this.listeners.push(fn); }, async emit(...args) { await Promise.all(this.listeners.map(fn => fn(...args))); } }; }
const messages = [];
const titles = [];
let settings = { enabled: true };
let saveSettings = async (value) => { settings = value; };
let window = { id: 7, focused: true, incognito: false, left: -1280, top: 40, width: 1200, height: 800, state: 'normal', tabs: [{ id: 4, active: true, incognito: false, status: 'complete', url: 'https://example.com/settings', title: 'Tab Settings' }] };
let injected = async () => [{ frameId: 0, result: { url: 'https://example.com/settings', title: 'Settings', viewport: { width: 1160, height: 700 }, scroll: { x: 0, y: 200 }, devicePixelRatio: 2, visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0 } } }];
let reads = 0;
const connections = [];
let connection;
const chrome = {
  runtime: { id: 'extension-id', getURL(file) { return `chrome-extension://extension-id/${file}`; }, connectNative(name) {
    assert.equal(name, 'com.iknowit.bridge');
    connection = { closed: false, messages: [], postMessage(message) {
      if (this.closed) throw new Error('Disconnected port');
      this.messages.push(message); messages.push(message);
    }, onMessage: event(), onDisconnect: event() };
    connections.push(connection);
    return connection;
  }, onInstalled: event(), onStartup: event(), onMessage: event() },
  storage: { local: { async get() { return settings; }, async set(value) { await saveSettings(value); } } },
  action: { async setBadgeText() {}, async setTitle({ title }) { titles.push(title); }, onClicked: event() },
  alarms: { async create(_name, options) { assert.equal(options.periodInMinutes, 0.5); }, onAlarm: event() },
  windows: { async getLastFocused() { return structuredClone(window); }, onFocusChanged: event(), onBoundsChanged: event() },
  tabs: { async getZoom() { return 1.25; }, onActivated: event(), onRemoved: event(), onUpdated: event(), onZoomChange: event() },
  scripting: { async executeScript() { reads++; return injected(); } },
};
const popupSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') };
function popup(message, sender = popupSender) {
  return new Promise(resolve => {
    const keepAlive = chrome.runtime.onMessage.listeners[0](message, sender, resolve);
    if (keepAlive !== true) resolve(undefined);
  });
}
const sandbox = vm.createContext({ chrome, setTimeout, clearTimeout, console });
vm.runInContext(source, sandbox);
(async () => {
  await vm.runInContext('ready', sandbox);
  await pause();
  assert.equal(messages[0].type, 'enabled');
  assert.equal(messages[0].enabled, true);
  assert.equal(messages.at(-1).available, true);
  assert.equal(messages.at(-1).pageAvailable, true);
  assert.equal(messages.at(-1).pageUnavailableReason, undefined);
  assert.equal(messages.at(-1).title, 'Tab Settings', 'Titles must come from the current tab');
  assert.equal(messages.at(-1).window.left, -1280);
  assert.equal(messages.at(-1).zoom, 1.25);
  assert.equal(titles.at(-1), 'I Know It! — On');
  assert.equal(chrome.action.onClicked.listeners.length, 0, 'Toolbar clicks must not toggle the popup state');
  assert.equal((await popup({ type: 'get-state' })).enabled, true);
  const controlBaseline = messages.length;
  assert.equal((await popup({ type: 'set-enabled', enabled: true })).enabled, true);
  for (const sender of [
    { ...popupSender, id: 'foreign-extension' }, { ...popupSender, url: 'https://example.com/' },
    { ...popupSender, url: chrome.runtime.getURL('other.html') },
    { ...popupSender, url: `${popupSender.url}#spoof` }, { ...popupSender, tab: { id: 4 } },
    { ...popupSender, tab: null }, {}, null,
  ]) {
    assert.equal(await popup({ type: 'get-state' }, sender), undefined);
    assert.equal(await popup({ type: 'set-enabled', enabled: false }, sender), undefined);
  }
  for (const message of [null, {}, { type: 'toggle' }, { type: 'set-enabled' },
    { type: 'set-enabled', enabled: 'false' }, { type: 'set-enabled', enabled: null },
    { type: 'set-enabled', enabled: 0 }]) assert.equal(await popup(message), undefined);
  assert.equal(messages.length, controlBaseline, 'Duplicate state and rejected messages must not affect the host');
  assert.equal((await popup({ type: 'get-state' })).enabled, true);
  await connection.onMessage.emit({ type: 'request-context', requestId: 'request-1' });
  await pause();
  assert.equal(messages.at(-1).requestId, 'request-1');
  assert.equal(messages.at(-1).url, window.tabs[0].url);
  await popup({ type: 'set-enabled', enabled: false });
  assert.equal(settings.enabled, false);
  assert.equal(titles.at(-1), 'I Know It! — Off');
  assert.equal(messages.at(-1).enabled, false);
  const disabledReads = reads;
  await connection.onMessage.emit({ type: 'request-context', requestId: 'off' });
  await pause();
  assert.equal(messages.at(-1).available, false);
  assert.equal(messages.at(-1).requestId, 'off');
  assert.equal(messages.at(-1).url, undefined);
  assert.equal(reads, disabledReads);
  await popup({ type: 'set-enabled', enabled: true });
  await pause();
  assert.equal(settings.enabled, true);
  assert.equal(messages.at(-1).available, true);
  let pendingWrites = 0;
  let totalWrites = 0;
  const beforeRapid = messages.filter(message => message.type === 'enabled').length;
  let maximumWrites = 0;
  saveSettings = async (value) => {
    pendingWrites++;
    totalWrites++;
    maximumWrites = Math.max(maximumWrites, pendingWrites);
    await new Promise(resolve => setTimeout(resolve, value.enabled ? 5 : 50));
    settings = value;
    pendingWrites--;
  };
  const rapid = await Promise.all([
    popup({ type: 'set-enabled', enabled: false }), popup({ type: 'set-enabled', enabled: true }),
    popup({ type: 'set-enabled', enabled: true }), popup({ type: 'get-state' }),
  ]);
  assert.deepEqual(rapid.map(reply => reply.enabled), [false, true, true, true]);
  await pause();
  assert.equal(settings.enabled, true, 'Rapid explicit state changes must persist the final enabled state');
  assert.equal(maximumWrites, 1, 'Popup state writes must not overlap');
  assert.equal(totalWrites, 2, 'A duplicate explicit state must not write storage again');
  assert.equal(messages.filter(message => message.type === 'enabled').length, beforeRapid + 2);
  assert.equal(messages.filter(message => message.type === 'enabled').at(-1).enabled, true);
  saveSettings = async (value) => { settings = value; };
  const normalInjection = injected;
  let completeRead;
  injected = () => new Promise(resolve => { completeRead = resolve; });
  await connection.onMessage.emit({ type: 'request-context', requestId: 'pending-off' });
  await pause();
  assert.equal(typeof completeRead, 'function');
  await popup({ type: 'set-enabled', enabled: false });
  const offIndex = messages.length;
  completeRead(await normalInjection());
  await pause();
  const stoppedRead = messages.find(message => message.requestId === 'pending-off');
  assert.equal(stoppedRead.available, false);
  assert.equal(stoppedRead.url, undefined);
  assert(!messages.slice(offIndex).some(message => message.available === true));
  injected = normalInjection;
  await popup({ type: 'set-enabled', enabled: true });
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
  assert.equal(messages.at(-1).available, true);
  assert.equal(messages.at(-1).pageAvailable, false);
  assert.equal(messages.at(-1).pageUnavailableReason, 'page-read-failed');
  assert.equal(messages.at(-1).url, window.tabs[0].url);
  assert.equal(messages.at(-1).title, window.tabs[0].title);
  const getWindow = chrome.windows.getLastFocused;
  const getZoom = chrome.tabs.getZoom;
  const originalWindow = structuredClone(window);
  for (const failure of ['window-read', 'no-active-tab', 'closed-window', 'same-tab-navigation', 'current-incognito', 'current-tab-incognito', 'current-unfocused', 'current-window-id', 'current-window-bounds', 'current-loading', 'missing-main-frame', 'page-url-mismatch']) {
    window = structuredClone(originalWindow);
    chrome.windows.getLastFocused = getWindow;
    chrome.tabs.getZoom = getZoom;
    injected = normalInjection;
    if (failure === 'window-read') chrome.windows.getLastFocused = async () => { throw new Error('Window unavailable'); };
    if (failure === 'no-active-tab') window.tabs = [];
    if (failure === 'closed-window') window = undefined;
    if (failure === 'same-tab-navigation') injected = async () => { const result = await normalInjection(); window.tabs[0].url = 'https://example.com/next'; return result; };
    if (failure === 'current-incognito') injected = async () => { const result = await normalInjection(); window.incognito = true; return result; };
    if (failure === 'current-tab-incognito') injected = async () => { const result = await normalInjection(); window.tabs[0].incognito = true; return result; };
    if (failure === 'current-unfocused') injected = async () => { const result = await normalInjection(); window.focused = false; return result; };
    if (failure === 'current-window-id') injected = async () => { const result = await normalInjection(); window.id++; return result; };
    if (failure === 'current-window-bounds') injected = async () => { const result = await normalInjection(); window.width++; return result; };
    if (failure === 'current-loading') injected = async () => { const result = await normalInjection(); window.tabs[0].status = 'loading'; return result; };
    if (failure === 'missing-main-frame') injected = async () => [{ frameId: 1, result: (await normalInjection())[0].result }];
    if (failure === 'page-url-mismatch') injected = async () => [{ frameId: 0, result: { ...(await normalInjection())[0].result, url: 'https://example.com/unrelated' } }];
    await connection.onMessage.emit({ type: 'request-context', requestId: failure });
    await pause();
    const reply = messages.find(message => message.requestId === failure);
    assert.equal(reply.available, false, failure);
    for (const field of ['url', 'title', 'viewport', 'scroll', 'devicePixelRatio', 'zoom', 'visualViewport']) {
      assert.equal(reply[field], undefined, `${failure} must omit ${field}`);
    }
  }
  chrome.windows.getLastFocused = getWindow;
  for (const failure of ['zoom', 'script', 'script-and-zoom']) {
    window = structuredClone(originalWindow);
    chrome.tabs.getZoom = getZoom;
    injected = normalInjection;
    if (failure.includes('zoom')) chrome.tabs.getZoom = async () => { throw new Error('Zoom unavailable'); };
    if (failure.includes('script')) injected = async () => { throw new Error('Cannot access page'); };
    await connection.onMessage.emit({ type: 'request-context', requestId: `fallback-${failure}` });
    await pause();
    const reply = messages.find(message => message.requestId === `fallback-${failure}`);
    assert.equal(reply.available, true, failure);
    assert.equal(reply.url, window.tabs[0].url, failure);
    assert.equal(reply.title, window.tabs[0].title, failure);
    assert.equal(reply.window.left, window.left, failure);
    assert.equal(reply.pageAvailable, failure === 'zoom', failure);
    assert.equal(reply.zoom, failure.includes('zoom') ? undefined : 1.25, failure);
    if (failure === 'zoom') assert.equal(reply.viewport.width, 1160);
    else {
      assert.equal(reply.pageUnavailableReason, 'page-read-failed', failure);
      for (const field of ['viewport', 'scroll', 'devicePixelRatio', 'visualViewport']) {
        assert.equal(reply[field], undefined, `${failure} must omit ${field}`);
      }
    }
  }
  window = structuredClone(originalWindow);
  window.tabs[0].url = 'chrome://extensions/';
  window.tabs[0].title = 'Extensions';
  const internalWindow = structuredClone(window);
  const beforeInternalReads = reads;
  for (const zoomAvailable of [true, false]) {
    chrome.tabs.getZoom = zoomAvailable ? getZoom : async () => { throw new Error('Internal page has no zoom'); };
    await connection.onMessage.emit({ type: 'request-context', requestId: `internal-${zoomAvailable}` });
    await pause();
    const reply = messages.find(message => message.requestId === `internal-${zoomAvailable}`);
    assert.equal(reply.available, true);
    assert.equal(reply.pageAvailable, false);
    assert.equal(reply.pageUnavailableReason, 'browser-internal-page');
    assert.equal(reply.url, 'chrome://extensions/');
    assert.equal(reply.title, 'Extensions');
    assert.equal(reply.window.left, -1280);
    assert.equal(reply.zoom, zoomAvailable ? 1.25 : undefined);
    for (const field of ['viewport', 'scroll', 'devicePixelRatio', 'visualViewport']) assert.equal(reply[field], undefined);
    assert.equal(reads, beforeInternalReads, 'Internal pages must never receive script injection');
  }
  for (const race of ['navigation', 'tab-change', 'tab-closed', 'window-closed', 'focus', 'window-change', 'bounds', 'loading', 'incognito', 'tab-incognito']) {
    window = structuredClone(internalWindow);
    chrome.tabs.getZoom = async () => {
      if (race === 'navigation') window.tabs[0].url = 'chrome://settings/';
      if (race === 'tab-change') window.tabs[0].id++;
      if (race === 'tab-closed') window.tabs = [];
      if (race === 'window-closed') window = undefined;
      if (race === 'focus') window.focused = false;
      if (race === 'window-change') window.id++;
      if (race === 'bounds') window.top++;
      if (race === 'loading') window.tabs[0].status = 'loading';
      if (race === 'incognito') window.incognito = true;
      if (race === 'tab-incognito') window.tabs[0].incognito = true;
      throw new Error('Zoom unavailable during a transition');
    };
    await connection.onMessage.emit({ type: 'request-context', requestId: `internal-race-${race}` });
    await pause();
    const reply = messages.find(message => message.requestId === `internal-race-${race}`);
    assert.equal(reply.available, false, race);
    assert.equal(reply.url, undefined, race);
    assert.equal(reply.title, undefined, race);
    assert.equal(reads, beforeInternalReads);
  }
  window = structuredClone(internalWindow);
  let completeZoom;
  chrome.tabs.getZoom = () => new Promise(resolve => { completeZoom = resolve; });
  await connection.onMessage.emit({ type: 'request-context', requestId: 'internal-revision' });
  await pause();
  assert.equal(typeof completeZoom, 'function');
  chrome.tabs.getZoom = getZoom;
  await chrome.windows.onBoundsChanged.emit();
  completeZoom(1);
  await pause();
  const invalidatedInternal = messages.find(message => message.requestId === 'internal-revision');
  assert.equal(invalidatedInternal.available, false, 'Internal page reads must respect revision invalidation');
  assert.equal(invalidatedInternal.url, undefined);
  for (const url of ['http://example.com/', 'https://example.com/', 'chrome://settings/',
    'file:///private/example.html', 'ftp://example.com/', 'data:text/html,secret', 'blob:https://example.com/id',
    'javascript:secret()', 'chrome-extension://other-extension/popup.html', 'devtools://devtools/', 'about:blank', '', undefined]) {
    window = structuredClone(originalWindow);
    window.tabs[0].url = url;
    injected = async () => [{ frameId: 0, result: { ...(await normalInjection())[0].result, url } }];
    const before = reads;
    let zoomReads = 0;
    chrome.tabs.getZoom = async () => { zoomReads++; return 1; };
    await connection.onMessage.emit({ type: 'request-context', requestId: `scheme-${url}` });
    await pause();
    const reply = messages.find(message => message.requestId === `scheme-${url}`);
    const supported = ['http://example.com/', 'https://example.com/', 'chrome://settings/'].includes(url);
    assert.equal(reply.available, supported, `${url}`);
    assert.equal(reply.url, supported ? url : undefined, `${url}`);
    assert.equal(zoomReads, supported ? 1 : 0, `${url}`);
    assert.equal(reads - before, /^https?:/.test(url ?? '') ? 1 : 0, `${url}`);
    if (!supported) assert.equal(reply.title, undefined, `${url}`);
  }
  for (const privacy of ['window', 'tab']) {
    window = structuredClone(internalWindow);
    if (privacy === 'window') window.incognito = true;
    else window.tabs[0].incognito = true;
    let zoomReads = 0;
    chrome.tabs.getZoom = async () => { zoomReads++; return 1; };
    await connection.onMessage.emit({ type: 'request-context', requestId: `private-internal-${privacy}` });
    await pause();
    const reply = messages.find(message => message.requestId === `private-internal-${privacy}`);
    assert.equal(reply.available, false);
    assert.equal(reply.url, undefined);
    assert.equal(reply.title, undefined);
    assert.equal(zoomReads, 0);
  }
  window = originalWindow;
  chrome.windows.getLastFocused = getWindow;
  chrome.tabs.getZoom = async () => 0.9;
  Object.assign(sandbox, { location: { href: window.tabs[0].url }, document: { title: 'Fractional display' },
    innerWidth: 1066, innerHeight: 733, scrollX: -47.125, scrollY: -0.375, devicePixelRatio: 1.25,
    visualViewport: { scale: 1.125, offsetLeft: -2.75, offsetTop: 13.5 },
  });
  injected = async () => [{ frameId: 0, result: vm.runInContext('pageContext()', sandbox) }];
  await connection.onMessage.emit({ type: 'request-context', requestId: 'fractional' });
  await pause();
  const fractional = messages.find(message => message.requestId === 'fractional');
  assert.equal(fractional.available, true);
  assert.equal(fractional.devicePixelRatio, 1.25);
  assert.equal(fractional.zoom, 0.9);
  assert.equal(fractional.scroll.x, -47.125);
  assert.equal(fractional.scroll.y, -0.375);
  assert.equal(fractional.visualViewport.scale, 1.125);
  assert.equal(fractional.visualViewport.offsetLeft, -2.75);
  assert.equal(fractional.visualViewport.offsetTop, 13.5);
  chrome.tabs.getZoom = getZoom;
  injected = normalInjection;
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

  connection.closed = true;
  await connection.onDisconnect.emit();
  for (const namespace of Object.values(chrome)) {
    for (const value of Object.values(namespace)) if (value?.listeners) value.listeners.length = 0;
  }
  const getSettings = chrome.storage.local.get;
  chrome.storage.local.get = async () => { throw new Error('Storage temporarily unavailable'); };
  const unavailableStorage = vm.createContext({ chrome, setTimeout, clearTimeout, console });
  vm.runInContext(source, unavailableStorage);
  await assert.doesNotReject(async () => { await vm.runInContext('ready', unavailableStorage); },
    'Storage read failure must initialize a usable, disabled extension');
  await pause();
  assert.equal(connection.messages[0].enabled, false);
  assert.equal(reads, beforeForged);
  chrome.storage.local.get = getSettings;
  await popup({ type: 'set-enabled', enabled: true });
  await pause();
  assert.equal(settings.enabled, true);
  assert.equal(connection.messages.at(-1).available, true, 'The first popup change after failed storage initialization must work');
  saveSettings = async () => { throw new Error('Storage write failed'); };
  await assert.doesNotReject(() => popup({ type: 'set-enabled', enabled: false }), 'Failed persistence must not break the live switch');
  assert.equal(connection.messages.at(-1).enabled, false);
  connection.closed = true;
  await connection.onDisconnect.emit();
  const disconnectedCount = connections.length;
  await assert.doesNotReject(() => popup({ type: 'set-enabled', enabled: true }));
  await pause();
  assert.equal(connections.length, disconnectedCount + 1, 'Failed persistence must not prevent reconnecting the live switch');
  assert.equal(connection.messages[0].enabled, true);
  assert.equal(connection.messages.at(-1).available, true);
  saveSettings = async (value) => { settings = value; };
  await popup({ type: 'set-enabled', enabled: false });
  assert.equal(settings.enabled, false, 'Persistence must recover on the next successful write');

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
  console.log('PASS: fresh/correlated context; verified tab/window fallback for internal or inaccessible pages without DOM injection/leakage; scheme/privacy boundaries and transition invalidation; negative/fractional coordinates and scaling; invalid windows/tabs, navigation, incognito, zoom/script failures; storage read/write recovery; strict popup controls, serialized/duplicate explicit states and disabled startup/reconnect; pending reads across OFF; native port isolation; passive page events without DOM writes; forged/iframe messages rejected.');
})().catch(error => { console.error(error); process.exitCode = 1; });
