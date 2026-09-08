const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 90));
function event() { return { listeners: [], addListener(fn) { this.listeners.push(fn); }, async emit(...args) { await Promise.all(this.listeners.map(fn => fn(...args))); } }; }
const messages = [];
const broadcasts = [];
const pageUpdates = [];
const pageInjections = [];
const initializedPages = new Set([4]);
let pageReply = async tabId => {
  if (!initializedPages.has(tabId)) throw new Error('Tab has no current content script');
  return { contextReady: true };
};
let installPage = async tabId => { initializedPages.add(tabId); };
const openPages = [
  { id: 4, url: 'https://example.com/settings', incognito: false },
  { id: 6, url: 'http://example.com/background', incognito: false, status: 'loading' },
  { id: 8, url: 'https://private.example/', incognito: true },
  { id: 9, url: 'chrome://settings/' }, { id: 10, url: 'file:///private/page.html' },
];
const titles = [];
let settings = { enabled: true };
let saveSettings = async (value) => { settings = value; };
let window = { id: 7, focused: true, incognito: false, left: -1280, top: 40, width: 1200, height: 800, state: 'normal', tabs: [{ id: 4, active: true, incognito: false, status: 'complete', url: 'https://example.com/settings', title: 'Tab Settings' }] };
let injected = async () => [{ frameId: 0, result: { url: 'https://example.com/settings', title: 'Settings', viewport: { width: 1160, height: 700 }, scroll: { x: 0, y: 200 }, devicePixelRatio: 2, visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0 } } }];
let reads = 0;
const connections = [];
let connection;
const chrome = {
  runtime: { id: 'extension-id', getURL(file) { return `chrome-extension://extension-id/${file}`; }, async sendMessage(message) { broadcasts.push(message); }, connectNative(name) {
    assert.equal(name, 'com.iknowit.bridge');
    connection = { closed: false, messages: [], postMessage(message) {
      if (this.closed) throw new Error('Disconnected port');
      this.messages.push(message); messages.push(message);
    }, disconnect() { this.closed = true; void this.onDisconnect.emit(); }, onMessage: event(), onDisconnect: event() };
    connections.push(connection);
    return connection;
  }, onInstalled: event(), onStartup: event(), onMessage: event() },
  storage: { local: { async get() { return settings; }, async set(value) { await saveSettings(value); } } },
  action: { async setBadgeText() {}, async setTitle({ title }) { titles.push(title); }, onClicked: event() },
  alarms: { async create(_name, options) { assert.equal(options.periodInMinutes, 0.5); }, onAlarm: event() },
  windows: { WINDOW_ID_NONE: -1, async getLastFocused() { return structuredClone(window); }, onFocusChanged: event(), onBoundsChanged: event() },
  tabs: { async query(options) { assert.deepEqual(Object.keys(options), []); return structuredClone(openPages); },
    async get(tabId) { const tab = openPages.find(tab => tab.id === tabId); if (!tab) throw new Error('Closed tab'); return structuredClone(tab); },
    async sendMessage(tabId, message, options) {
      assert.equal(options.frameId, 0);
      pageUpdates.push({ tabId, ...message });
      return pageReply(tabId);
    }, async getZoom() { return 1.25; }, onActivated: event(), onRemoved: event(), onUpdated: event(), onZoomChange: event() },
  scripting: { async executeScript(options) {
    if (options.files) {
      assert.deepEqual(JSON.parse(JSON.stringify(options)), { target: { tabId: options.target.tabId, frameIds: [0] }, files: ['context.js'], injectImmediately: true },
        'A loading existing page must not hold startup until document_idle');
      pageInjections.push(options.target.tabId);
      await installPage(options.target.tabId);
      return [{ frameId: 0 }];
    }
    reads++; return injected();
  } },
};
const popupSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') };
const pageSender = { id: chrome.runtime.id, frameId: 0, tab: { id: 4, active: true, incognito: false }, url: 'https://example.com/settings' };
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
  assert.deepEqual(pageUpdates, [4, 6, 6].map(tabId => ({ tabId, type: 'page-state', enabled: true })),
    'Startup initializes a missing collector and synchronizes only eligible top-level pages');
  assert.deepEqual(pageInjections, [6], 'Initialize the missing collector immediately even while its document is loading; do not reinject the healthy receiver');
  await vm.runInContext('updatePages()', sandbox);
  await vm.runInContext('updatePages()', sandbox);
  assert.deepEqual(pageInjections, [6], 'Repeated synchronization must reuse acknowledged collectors');
  const healthyReply = pageReply;
  initializedPages.delete(6);
  pageReply = tabId => tabId === 6 && !initializedPages.has(tabId) ? undefined : healthyReply(tabId);
  await vm.runInContext('updatePages()', sandbox);
  pageReply = healthyReply;
  assert.deepEqual(pageInjections, [6, 6], 'A fulfilled message without the explicit ACK still needs initialization');
  const getTab = chrome.tabs.get;
  for (const changed of [{ incognito: true }, { url: 'chrome://settings/' }, { url: 'file:///private/page.html' }, null]) {
    initializedPages.delete(6);
    const before = pageInjections.length;
    chrome.tabs.get = async tabId => {
      if (tabId !== 6) return getTab(tabId);
      if (!changed) throw new Error('Tab closed during initialization');
      return { ...(await getTab(tabId)), ...changed };
    };
    await vm.runInContext('updatePages()', sandbox);
    assert.equal(pageInjections.length, before, 'Recheck current URL/privacy before injecting a previously eligible tab');
  }
  chrome.tabs.get = getTab;
  const completeInstallation = installPage;
  installPage = async () => { throw new Error('Injection was denied'); };
  const beforeFailure = pageUpdates.length;
  await assert.doesNotReject(() => vm.runInContext('updatePages()', sandbox));
  assert.deepEqual(pageUpdates.slice(beforeFailure).map(update => update.tabId), [4, 6], 'A failed injection must not pretend to initialize or repeatedly message the missing collector');
  assert(!initializedPages.has(6));
  installPage = completeInstallation;
  await vm.runInContext('updatePages()', sandbox);
  assert(initializedPages.has(6), 'A later startup/toggle synchronization can recover a previously denied injection');
  assert.equal((await popup({ type: 'get-page-state' }, pageSender)).enabled, true);
  assert.equal((await popup({ type: 'get-page-state' }, { ...pageSender, tab: { ...pageSender.tab, active: false } })).enabled, true,
    'An inactive page needs the authoritative live switch state too');
  for (const sender of [null, {}, popupSender, { ...pageSender, id: 'foreign-extension' },
    { ...pageSender, frameId: 1 }, { ...pageSender, frameId: undefined }, { ...pageSender, tab: null },
    { ...pageSender, tab: { ...pageSender.tab, incognito: true } }, { ...pageSender, url: 'file:///private/page.html' }]) {
    assert.equal(await popup({ type: 'get-page-state' }, sender), undefined, 'Reject unauthenticated page-state readers');
  }
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
  assert.equal((await popup({ type: 'get-state' })).inputStatus, 'disconnected');
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
    assert.equal(await popup({ type: 'request-input-access' }, sender), undefined);
  }
  for (const message of [null, {}, { type: 'toggle' }, { type: 'set-enabled' },
    { type: 'set-enabled', enabled: 'false' }, { type: 'set-enabled', enabled: null },
    { type: 'set-enabled', enabled: 0 }]) assert.equal(await popup(message), undefined);
  assert.equal(messages.length, controlBaseline, 'Duplicate state and rejected messages must not affect the host');
  assert.equal((await popup({ type: 'request-input-access' })).permissionRequestSent, false);
  assert.equal(messages.length, controlBaseline, 'A disconnected companion must not receive permission requests');
  for (const status of ['ready', 'unavailable', 'off']) {
    await connection.onMessage.emit({ type: 'input-status', status });
    assert.equal((await popup({ type: 'get-state' })).inputStatus, status);
    assert.equal(broadcasts.at(-1).inputStatus, status);
    assert.equal((await popup({ type: 'request-input-access' })).permissionRequestSent, false);
    assert.equal(messages.length, controlBaseline, `${status} must not request permission`);
  }
  await connection.onMessage.emit({ type: 'input-status', status: 'permission-required' });
  await connection.onMessage.emit({ type: 'input-status', status: 'forged' });
  assert.equal((await popup({ type: 'get-state' })).inputStatus, 'permission-required');
  assert.equal(messages.filter(message => message.type === 'request-input-access').length, 0,
    'Startup, popup reads, state toggles and status messages must never request permission');
  for (const sender of [{ ...popupSender, tab: { id: 4 } }, { ...popupSender, url: 'https://example.com/' }]) {
    assert.equal(await popup({ type: 'request-input-access' }, sender), undefined);
  }
  assert.equal(messages.length, controlBaseline, 'Forged callers cannot request permission even when required');
  assert.equal((await popup({ type: 'request-input-access' })).permissionRequestSent, true);
  assert.equal(messages.at(-1).type, 'request-input-access');
  assert.equal(messages.filter(message => message.type === 'request-input-access').length, 1);
  assert.equal((await popup({ type: 'get-state' })).enabled, true);
  await connection.onMessage.emit({ type: 'request-context', requestId: 'request-1' });
  await pause();
  assert.equal(messages.at(-1).requestId, 'request-1');
  assert.equal(messages.at(-1).url, window.tabs[0].url);
  await popup({ type: 'set-enabled', enabled: false });
  assert.equal(settings.enabled, false);
  assert.equal((await popup({ type: 'get-page-state' }, pageSender)).enabled, false);
  assert(pageUpdates.slice(-2).every(update => update.enabled === false), 'OFF must reach existing content scripts');
  assert.equal(titles.at(-1), 'I Know It! — Off');
  assert.equal(messages.at(-1).enabled, false);
  await connection.onMessage.emit({ type: 'input-status', status: 'permission-required' });
  assert.equal((await popup({ type: 'request-input-access' })).permissionRequestSent, false);
  assert.equal(messages.filter(message => message.type === 'request-input-access').length, 1, 'OFF must suppress permission requests');
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
    popup({ type: 'set-enabled', enabled: true }), popup({ type: 'get-state' }), popup({ type: 'get-page-state' }, pageSender),
  ]);
  assert.deepEqual(rapid.map(reply => reply.enabled), [false, true, true, true, true]);
  await pause();
  assert.equal(settings.enabled, true, 'Rapid explicit state changes must persist the final enabled state');
  assert.equal(maximumWrites, 1, 'Popup state writes must not overlap');
  assert.equal(totalWrites, 2, 'A duplicate explicit state must not write storage again');
  assert.equal(messages.filter(message => message.type === 'enabled').length, beforeRapid + 2);
  assert.equal(messages.filter(message => message.type === 'enabled').at(-1).enabled, true);
  assert(pageUpdates.slice(-2).every(update => update.enabled === true), 'Serialized toggles must leave all pages in their final state');
  saveSettings = async (value) => { settings = value; };
  initializedPages.delete(6);
  let finishOlderInjection, injectionStarted;
  const startedInjection = new Promise(resolve => { injectionStarted = resolve; });
  let delayedOnce = false;
  installPage = async tabId => {
    if (!delayedOnce) {
      delayedOnce = true;
      injectionStarted();
      await new Promise(resolve => { finishOlderInjection = resolve; });
    }
    await completeInstallation(tabId);
  };
  const olderPageSync = vm.runInContext('updatePages()', sandbox);
  await startedInjection;
  await popup({ type: 'set-enabled', enabled: false });
  const afterOffSync = pageUpdates.length;
  finishOlderInjection();
  await olderPageSync;
  assert.deepEqual(pageUpdates.slice(afterOffSync), [{ tabId: 6, type: 'page-state', enabled: false }],
    'An older initialization completing after OFF must deliver current OFF, never its original ON state');
  assert.equal((await popup({ type: 'get-page-state' }, pageSender)).enabled, false);
  installPage = completeInstallation;
  await popup({ type: 'set-enabled', enabled: true });
  await pause();
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
  await previousConnection.onMessage.emit({ type: 'input-status', status: 'ready' });
  previousConnection.closed = true;
  await previousConnection.onDisconnect.emit();
  assert.equal((await popup({ type: 'get-state' })).inputStatus, 'disconnected');
  assert.equal(broadcasts.at(-1).inputStatus, 'disconnected');
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
  await previousConnection.onMessage.emit({ type: 'input-status', status: 'ready' });
  assert.equal((await popup({ type: 'get-state' })).inputStatus, 'disconnected', 'Old host status must not mark a new connection ready');
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
  initializedPages.delete(4);
  installPage = async () => { throw new Error('Existing page cannot be initialized'); };
  await vm.runInContext('updatePages()', sandbox);
  assert(!initializedPages.has(4));
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
  assert.equal(fractional.pointerAnchor, undefined, 'Failed collector initialization must retain ordinary page observations without inventing calibration');
  assert.equal(fractional.pageWindow, undefined);
  installPage = completeInstallation;
  await vm.runInContext('updatePages()', sandbox);
  chrome.tabs.getZoom = getZoom;
  injected = normalInjection;

  const permissionPause = () => new Promise(resolve => setTimeout(resolve, 180));
  async function returnToChrome() {
    await chrome.windows.onFocusChanged.emit(chrome.windows.WINDOW_ID_NONE);
    await chrome.windows.onFocusChanged.emit(window.id);
    await permissionPause();
  }
  let permissionConnections = connections.length;
  await connection.onMessage.emit({ type: 'input-status', status: 'permission-required' });
  await chrome.runtime.onStartup.emit();
  await popup({ type: 'set-enabled', enabled: true });
  await popup({ type: 'get-state' });
  await popup({ type: 'request-input-access' }, { ...popupSender, tab: { id: 4 } });
  await returnToChrome();
  assert.equal(connections.length, permissionConnections, 'Startup, ON, polling and forged requests must not arm a permission restart');

  connection.closed = true;
  assert.equal((await popup({ type: 'request-input-access' })).permissionRequestSent, false,
    'Failed native sends must return an explicit failure to the popup');
  connection.closed = false;
  await returnToChrome();
  assert.equal(connections.length, permissionConnections, 'A failed permission message must not arm a restart');

  assert.equal((await popup({ type: 'request-input-access' })).permissionRequestSent, true);
  await chrome.windows.onFocusChanged.emit(window.id);
  await chrome.tabs.onActivated.emit();
  await chrome.windows.onBoundsChanged.emit();
  await popup({ type: 'get-state' });
  await permissionPause();
  assert.equal(connections.length, permissionConnections, 'Permission requests must wait for Chrome to lose focus before restarting');
  const deniedConnection = connection;
  await chrome.windows.onFocusChanged.emit(chrome.windows.WINDOW_ID_NONE);
  await chrome.windows.onFocusChanged.emit(window.id);
  assert.equal(deniedConnection.closed, true, 'Returning from permission settings must close the cached-denial host');
  await chrome.alarms.onAlarm.emit({ name: 'native-reconnect' });
  await popup({ type: 'set-enabled', enabled: true });
  assert.equal(connections.length, permissionConnections, 'Alarms and duplicate ON must respect the host shutdown delay');
  await permissionPause();
  assert.equal(connections.length, ++permissionConnections, 'Returning from permission settings must reconnect exactly once');
  assert.equal(connection.messages[0].enabled, true);
  await returnToChrome();
  assert.equal(connections.length, permissionConnections, 'Later ordinary focus changes must not restart the host');

  await connection.onMessage.emit({ type: 'input-status', status: 'permission-required' });
  await popup({ type: 'request-input-access' });
  await deniedConnection.onMessage.emit({ type: 'input-status', status: 'ready' });
  await deniedConnection.onDisconnect.emit();
  assert.equal((await popup({ type: 'get-state' })).inputStatus, 'permission-required', 'Old ports must not alter the current permission state');
  await returnToChrome();
  assert.equal(connections.length, ++permissionConnections, 'Old-port callbacks must not cancel a new permission return');

  await connection.onMessage.emit({ type: 'input-status', status: 'permission-required' });
  await popup({ type: 'request-input-access' });
  await chrome.windows.onFocusChanged.emit(chrome.windows.WINDOW_ID_NONE);
  await popup({ type: 'set-enabled', enabled: false });
  await popup({ type: 'set-enabled', enabled: true });
  await chrome.windows.onFocusChanged.emit(window.id);
  await permissionPause();
  assert.equal(connections.length, permissionConnections, 'OFF must cancel the pending permission return, including after re-enabling');

  await connection.onMessage.emit({ type: 'input-status', status: 'permission-required' });
  await popup({ type: 'request-input-access' });
  await chrome.windows.onFocusChanged.emit(chrome.windows.WINDOW_ID_NONE);
  await connection.onMessage.emit({ type: 'input-status', status: 'ready' });
  await chrome.windows.onFocusChanged.emit(window.id);
  await permissionPause();
  assert.equal(connections.length, permissionConnections, 'A host that becomes ready must not restart on return');

  await connection.onMessage.emit({ type: 'input-status', status: 'permission-required' });
  await popup({ type: 'request-input-access' });
  await chrome.windows.onFocusChanged.emit(chrome.windows.WINDOW_ID_NONE);
  connection.closed = true;
  await connection.onDisconnect.emit();
  await chrome.alarms.onAlarm.emit({ name: 'native-reconnect' });
  assert.equal(connections.length, ++permissionConnections);
  await chrome.windows.onFocusChanged.emit(window.id);
  await permissionPause();
  assert.equal(connections.length, permissionConnections, 'An unexpected disconnect must clear a pending permission return');

  const invalidations = () => messages.filter(message => message.type === 'browser-geometry-invalidated').length;
  for (const trigger of [
    () => chrome.tabs.onActivated.emit(), () => chrome.tabs.onRemoved.emit(),
    () => chrome.tabs.onZoomChange.emit(), () => chrome.windows.onBoundsChanged.emit(),
    () => chrome.tabs.onUpdated.emit(4, { status: 'loading' }, { active: true }),
    () => chrome.tabs.onUpdated.emit(4, { url: 'https://example.com/next' }, { active: true }),
    () => chrome.runtime.onMessage.emit({ type: 'context-changed', geometryChanged: true }, pageSender),
  ]) {
    const before = invalidations();
    await trigger();
    assert.equal(invalidations(), before + 1, 'A geometry transition must invalidate pending native page coordinates');
  }
  const beforeNonGeometry = invalidations();
  await chrome.windows.onFocusChanged.emit(chrome.windows.WINDOW_ID_NONE);
  await chrome.windows.onFocusChanged.emit(window.id);
  await chrome.tabs.onUpdated.emit(4, { title: 'Updated title' }, { active: true });
  await chrome.tabs.onUpdated.emit(6, { status: 'loading' }, { active: false });
  await chrome.runtime.onMessage.emit({ type: 'context-changed', geometryChanged: false }, pageSender);
  for (const sender of [
    { ...pageSender, id: 'foreign' }, { ...pageSender, frameId: 1 },
    { ...pageSender, tab: { ...pageSender.tab, active: false } },
    { ...pageSender, tab: { ...pageSender.tab, incognito: true } },
  ]) await chrome.runtime.onMessage.emit({ type: 'context-changed', geometryChanged: true }, sender);
  assert.equal(invalidations(), beforeNonGeometry, 'Same-window focus, title-only changes, inactive tabs, and forged page signals must not invalidate geometry');
  await chrome.windows.onFocusChanged.emit(window.id + 1);
  assert.equal(invalidations(), beforeNonGeometry + 1, 'Acquiring a different Chrome window must invalidate pending coordinates');
  for (const focus of [chrome.windows.WINDOW_ID_NONE, window.id + 1, undefined, NaN, -2]) {
    await chrome.windows.onFocusChanged.emit(focus);
  }
  assert.equal(invalidations(), beforeNonGeometry + 1, 'Same-window return, external focus and invalid IDs must not cancel a capture');
  await chrome.windows.onFocusChanged.emit(window.id);
  assert.equal(invalidations(), beforeNonGeometry + 2, 'Returning to another Chrome window is another geometry transition');
  await pause();
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
  assert.equal((await popup({ type: 'get-page-state' }, pageSender)).enabled, false,
    'A page must read live OFF even when storage still says ON');
  assert(pageUpdates.slice(-2).every(update => update.enabled === false), 'Failed persistence must not prevent page OFF propagation');
  const disabledInvalidations = messages.filter(message => message.type === 'browser-geometry-invalidated').length;
  await chrome.windows.onBoundsChanged.emit();
  await chrome.runtime.onMessage.emit({ type: 'context-changed', geometryChanged: true }, pageSender);
  assert.equal(messages.filter(message => message.type === 'browser-geometry-invalidated').length, disabledInvalidations,
    'OFF must suppress geometry invalidation signals as well as page reads');
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
  const page = { url: 'https://example.com/', title: 'Example', visibility: 'visible', width: 1200, height: 800,
    x: 0, y: 0, ratio: 2, scale: 1, offsetLeft: 0, offsetTop: 0, screenX: -1280, screenY: 40,
    outerWidth: 1240, outerHeight: 900, focused: true, fullscreen: false, pointerLock: false };
  function listen(target, name, handler, options) {
    if (target !== 'document') assert.equal(options?.passive, true);
    handlers[`${target}:${name}`] = handler;
  }
  const noWrite = { set() { assert.fail('The content reporter must not modify page objects'); } };
  const document = new Proxy({
    get title() { return page.title; }, get visibilityState() { return page.visibility; },
    get fullscreenElement() { return page.fullscreen ? {} : null; },
    get pointerLockElement() { return page.pointerLock ? {} : null; },
    hasFocus() { return page.focused; },
    addEventListener(name, handler, options) { listen('document', name, handler, options); },
  }, noWrite);
  const viewport = new Proxy({
    get scale() { return page.scale; }, get offsetLeft() { return page.offsetLeft; }, get offsetTop() { return page.offsetTop; },
    addEventListener(name, handler, options) { listen('viewport', name, handler, options); },
  }, noWrite);
  let interval;
  let now = 1000;
  let resolveInitialState;
  const stateRequests = [];
  const contentChrome = { runtime: { id: chrome.runtime.id, onMessage: event(), sendMessage(message) {
    if (message.type === 'get-page-state') { stateRequests.push(message); return new Promise(resolve => { resolveInitialState = resolve; }); }
    contentMessages.push(message); return Promise.resolve();
  } } };
  const content = { document, visualViewport: viewport, chrome: contentChrome, performance: { now: () => now },
    location: new Proxy({ get href() { return page.url; } }, noWrite),
    history: new Proxy(Object.freeze({ pushState() {}, replaceState() {} }), noWrite),
    addEventListener(name, handler, options) { listen('window', name, handler, options); },
    setInterval(handler, milliseconds) { assert.equal(milliseconds, 1000); interval = handler; },
  };
  for (const [name, key] of Object.entries({ innerWidth: 'width', innerHeight: 'height', scrollX: 'x', scrollY: 'y', devicePixelRatio: 'ratio', screenX: 'screenX', screenY: 'screenY', outerWidth: 'outerWidth', outerHeight: 'outerHeight' })) {
    Object.defineProperty(content, name, { enumerable: true, get() { return page[key]; }, set: noWrite.set });
  }
  const originalHistory = content.history.pushState;
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'context.js'), 'utf8'), vm.createContext(content));
  assert.equal(stateRequests.length, 1);
  assert.deepEqual(Object.keys(stateRequests[0]), ['type']);
  assert.equal(contentMessages.length, 0, 'Content must start OFF until it receives the live state');
  const installedHandlers = { ...handlers }, installedInterval = interval;
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'context.js'), 'utf8'), content);
  assert.deepEqual(handlers, installedHandlers);
  assert.equal(interval, installedInterval);
  assert.equal(contentChrome.runtime.onMessage.listeners.length, 1);
  assert.equal(stateRequests.length, 1, 'Concurrent/repeated file injection must not install duplicate collectors or request state twice');
  let pageAcknowledgement;
  await contentChrome.runtime.onMessage.emit({ type: 'page-state', enabled: true }, { id: chrome.runtime.id }, reply => { pageAcknowledgement = reply; });
  assert.equal(pageAcknowledgement.contextReady, true, 'A current collector explicitly acknowledges trusted page-state synchronization');
  await contentChrome.runtime.onMessage.emit({ type: 'page-state', enabled: true }, { id: chrome.runtime.id });
  resolveInitialState({ enabled: false });
  await Promise.resolve();
  assert.equal(contentMessages.length, 1, 'A delayed initial state must not override a newer live toggle');
  assert.equal(contentMessages[0].type, 'context-changed');
  assert.deepEqual(Object.keys(contentMessages[0]), ['type', 'geometryChanged'], 'Only a geometry change signal should leave the content script');
  assert.equal(contentMessages[0].geometryChanged, true);
  interval();
  interval();
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
  assert.equal(contentMessages.at(-1).geometryChanged, false, 'A title change is not a coordinate change');
  page.visibility = 'hidden';
  page.url = 'https://example.com/private';
  handlers['document:visibilitychange']();
  interval();
  assert.equal(contentMessages.length, 8, 'Hidden tabs must remain quiet');
  page.visibility = 'visible';
  handlers['document:visibilitychange']();
  assert.equal(contentMessages.length, 9);
  assert.equal(content.history.pushState, originalHistory);
  const readPage = () => content.__iKnowItPageContext();
  const point = (overrides = {}) => ({ isTrusted: true, pointerType: 'mouse', buttons: 0,
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, timeStamp: now,
    screenX: -1179.75, screenY: 159.5, clientX: 100.25, clientY: 20.5, ...overrides });
  const move = overrides => handlers['window:pointermove'](point(overrides));
  const restorePage = () => { now = 1000; page.visibility = 'visible'; page.focused = true; page.pointerLock = false; };
  move();
  let anchor = readPage().pointerAnchor;
  assert.deepEqual(JSON.parse(JSON.stringify(anchor.screen)), { x: -1179.75, y: 159.5 });
  assert.deepEqual(JSON.parse(JSON.stringify(anchor.client)), { x: 100.25, y: 20.5 });
  assert.equal(anchor.ageMs, 0);
  assert(Number.isFinite(Date.parse(anchor.observedAt)));
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'context.js'), 'utf8'), content);
  assert.equal(contentChrome.runtime.onMessage.listeners.length, 1);
  assert.deepEqual(handlers, installedHandlers);
  assert.equal(interval, installedInterval);
  assert.equal(JSON.stringify(readPage().pointerAnchor), JSON.stringify(anchor), 'A redundant injection must not reset an existing calibration');
  for (const ageMs of [1000, 1000.25, 60_000, 600_000]) {
    now = 1000 + ageMs; interval();
    const stationary = readPage().pointerAnchor;
    assert.deepEqual(JSON.parse(JSON.stringify(stationary)), { ...JSON.parse(JSON.stringify(anchor)), ageMs },
      'A stationary calibration retains its original coordinates and timestamp, with its actual age');
  }
  restorePage(); move();
  const beforeSameOn = JSON.parse(JSON.stringify(readPage().pointerAnchor));
  const signalsBeforeSameOn = contentMessages.length;
  now += 5000;
  for (let repeat = 0; repeat < 2; repeat++) {
    await contentChrome.runtime.onMessage.emit({ type: 'page-state', enabled: true }, { id: chrome.runtime.id });
    assert.deepEqual(JSON.parse(JSON.stringify(readPage().pointerAnchor)), { ...beforeSameOn, ageMs: 5000 },
      'Repeated ON synchronization must preserve valid calibration and its original timestamp');
  }
  assert.equal(contentMessages.length, signalsBeforeSameOn, 'Repeated ON must not report an unchanged layout as invalidated');
  page.screenX += 0.25;
  await contentChrome.runtime.onMessage.emit({ type: 'page-state', enabled: true }, { id: chrome.runtime.id });
  assert.equal(readPage().pointerAnchor, undefined, 'Repeated ON must still clear calibration when current geometry differs');
  page.screenX -= 0.25;
  interval();
  for (const invalidNow of [999.75, NaN, Infinity, -Infinity]) {
    restorePage(); move(); now = invalidNow;
    assert.equal(readPage().pointerAnchor, undefined, 'An invalid calibration age must not leave the page');
    now = 1000;
    assert.equal(readPage().pointerAnchor, undefined, 'Restoring the clock must not revive a rejected calibration');
  }
  restorePage(); move(); page.focused = false;
  assert(readPage().pointerAnchor, 'Focus loss alone during the system screenshot overlay must retain a stable calibration');
  assert.deepEqual(JSON.parse(JSON.stringify(readPage().pointerCalibration)), {
    status: 'ready', enabled: true, visibility: 'visible', focused: false,
  }, 'Current focus diagnostics must not invalidate an existing anchor');
  move({ screenX: 999, clientX: 500 });
  assert.equal(readPage().pointerAnchor.screen.x, -1179.75, 'An unfocused event cannot replace a valid calibration');
  assert.equal(readPage().pointerCalibration.status, 'ready');
  handlers['window:resize'](); move();
  assert.equal(readPage().pointerAnchor, undefined);
  assert.equal(readPage().pointerCalibration.status, 'unfocused-pointer', 'A missing first observation records the focus rejection');
  page.focused = true;
  assert.equal(readPage().pointerCalibration.status, 'unfocused-pointer', 'Focus restoration alone does not invent a pointer observation');
  move();
  assert.equal(readPage().pointerCalibration.status, 'ready', 'A later eligible observation replaces the missing-calibration reason');
  assert.equal(handlers['window:blur'], undefined);
  assert.equal(handlers['window:focus'], undefined);
  restorePage();

  for (const invalid of [
    { isTrusted: false }, { pointerType: 'touch' }, { pointerType: 'pen' }, { buttons: 1 },
    { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { metaKey: true },
    { timeStamp: 899.75 }, { timeStamp: 1000.25 }, { timeStamp: NaN },
    { screenX: Infinity }, { screenY: NaN }, { clientX: -Infinity }, { clientY: NaN },
  ]) {
    handlers['window:resize']();
    move(invalid);
    assert.equal(readPage().pointerAnchor, undefined, `An ineligible event cannot seed a calibration ${JSON.stringify(invalid)}`);
    move(); const prior = JSON.stringify(readPage().pointerAnchor);
    move(invalid);
    assert.equal(JSON.stringify(readPage().pointerAnchor), prior, `An ineligible event must not replace a valid calibration ${JSON.stringify(invalid)}`);
  }
  for (const invalid of ['hidden', 'pointer-lock', 'invalid-clock']) {
    restorePage(); move();
    if (invalid === 'hidden') page.visibility = 'hidden';
    if (invalid === 'pointer-lock') page.pointerLock = true;
    if (invalid === 'invalid-clock') now = NaN;
    move();
    assert.equal(readPage().pointerAnchor, undefined, invalid);
    restorePage();
    assert.equal(readPage().pointerAnchor, undefined, 'Leaving an invalidating state must not revive its calibration');
  }
  restorePage(); move(); page.pointerLock = true;
  assert.equal(readPage().pointerAnchor, undefined, 'The getter rejects pointer lock before its event callback');
  page.pointerLock = false;
  assert.equal(readPage().pointerAnchor, undefined, 'Unlocking without an event must not revive the rejected calibration');
  restorePage(); move({ timeStamp: 900 });
  assert.equal(readPage().pointerAnchor.ageMs, 100, 'A pointer event at the freshness boundary is accepted');

  for (const observe of [() => handlers['window:scroll'](), interval, readPage]) {
    restorePage(); move();
    const beforeScroll = JSON.parse(JSON.stringify(readPage().pointerAnchor));
    const originalScroll = { x: page.x, y: page.y };
    for (const next of [{ x: -15.25, y: 1000.5 }, originalScroll]) {
      const signalsBefore = contentMessages.length;
      page.x = next.x; page.y = next.y; now += 5000;
      observe();
      const scrolled = readPage();
      assert.deepEqual(JSON.parse(JSON.stringify(scrolled.scroll)), next);
      assert.deepEqual(JSON.parse(JSON.stringify(scrolled.pointerAnchor)), { ...beforeScroll, ageMs: now - 1000 },
        'Plain document scroll and scrollback must retain original calibration coordinates/time with their actual age');
      assert.equal(scrolled.pointerCalibration.status, 'ready');
      assert.equal(contentMessages.length, signalsBefore + 1, 'Scroll must notify even when first observed by the getter');
      assert.equal(contentMessages.at(-1).geometryChanged, true, 'Scroll must invalidate pending native document coordinates');
    }
  }
  restorePage(); move();
  const beforeEqualScroll = JSON.parse(JSON.stringify(readPage().pointerAnchor));
  const equalScrollSignals = contentMessages.length;
  now += 1000; handlers['window:scroll']();
  assert.deepEqual(JSON.parse(JSON.stringify(readPage().pointerAnchor)), { ...beforeEqualScroll, ageMs: 1000 },
    'An equal-value document scroll signal preserves calibration');
  assert.equal(contentMessages.length, equalScrollSignals + 1);
  assert.equal(contentMessages.at(-1).geometryChanged, true, 'An equal-value scroll still invalidates pending native snapshots');
  for (const key of ['width', 'height', 'screenX', 'screenY', 'outerWidth', 'outerHeight', 'ratio', 'scale', 'offsetLeft', 'offsetTop']) {
    restorePage(); move();
    const old = page[key];
    page.y += 1; page[key] += 1;
    handlers['window:scroll']();
    assert.equal(readPage().pointerAnchor, undefined, `${key} changes accompanying scroll must still clear calibration`);
    page.y -= 1; page[key] = old;
    handlers['window:scroll']();
    assert.equal(readPage().pointerAnchor, undefined, 'Scrollback must not revive a calibration cleared by an origin change');
  }
  restorePage();
  for (const [key, next, eventName] of [
    ['width', 900, 'window:resize'], ['height', 600, 'window:resize'], ['ratio', 1.25, 'window:resize'],
    ['scale', 1.25, 'viewport:resize'], ['offsetLeft', 12.5, 'viewport:scroll'], ['offsetTop', 7.25, 'viewport:scroll'],
    ['screenX', -1024.5, null], ['screenY', 100.25, null], ['outerWidth', 1000, 'window:resize'],
    ['outerHeight', 780, 'window:resize'], ['fullscreen', true, 'document:fullscreenchange'],
    ['url', 'https://example.com/elsewhere', 'window:popstate'],
  ]) {
    const old = page[key];
    move(); assert(readPage().pointerAnchor);
    page[key] = next;
    assert.equal(readPage().pointerAnchor, undefined, `${key} drift must reject an anchor before the event callback`);
    (eventName ? handlers[eventName] : interval)();
    assert.equal(contentMessages.at(-1).geometryChanged, true, `${key} must report geometry invalidation`);
    page[key] = old;
    (eventName ? handlers[eventName] : interval)();
    assert.equal(readPage().pointerAnchor, undefined, 'Restoring geometry must not revive an invalidated anchor');
  }
  for (const key of ['width', 'screenY', 'ratio']) {
    move(); const previousValue = page[key];
    const signalsBefore = contentMessages.length;
    page[key] += 1;
    assert.equal(readPage().pointerAnchor, undefined);
    assert.equal(contentMessages.length, signalsBefore + 1, 'A getter-observed geometry mismatch must invalidate pending native estimates');
    assert.equal(contentMessages.at(-1).geometryChanged, true);
    page[key] = previousValue;
    assert.equal(readPage().pointerAnchor, undefined, 'Getter mismatch followed by restoration without events must not resurrect a calibration');
  }
  for (const signal of ['window:resize', 'viewport:resize', 'viewport:scroll',
    'window:hashchange', 'window:popstate', 'document:fullscreenchange', 'document:pointerlockchange']) {
    move(); assert(readPage().pointerAnchor);
    const signalsBefore = contentMessages.length;
    handlers[signal]();
    assert.equal(readPage().pointerAnchor, undefined, `${signal} must invalidate even when sampled geometry is unchanged`);
    assert.notEqual(readPage().pointerCalibration.status, 'ready', 'Invalidation diagnostics must not claim a usable calibration');
    assert.deepEqual(Object.keys(readPage().pointerCalibration), ['status', 'enabled', 'visibility', 'focused'],
      'Diagnostics retain only current state, never rejected coordinates or an event history');
    assert.equal(contentMessages.length, signalsBefore + 1, `${signal} must notify pending native selections`);
    assert.equal(contentMessages.at(-1).geometryChanged, true);
    interval();
    assert.equal(readPage().pointerAnchor, undefined, 'An unchanged later poll must not recreate calibration');
  }
  move(); page.title = 'A title-only update'; interval();
  assert(readPage().pointerAnchor, 'A title-only update must retain its anchor');
  assert.equal(contentMessages.at(-1).geometryChanged, false);
  page.visibility = 'hidden'; handlers['document:visibilitychange']();
  page.visibility = 'visible'; handlers['document:visibilitychange']();
  assert.equal(readPage().pointerAnchor, undefined, 'Hiding and reopening a page must not revive an anchor');
  assert.equal(readPage().pointerCalibration.status, 'hidden', 'The last clearing reason survives visibility restoration');

  for (const sender of [null, {}, { id: 'foreign-extension' }, { id: chrome.runtime.id, tab: { id: 4 } }, { id: chrome.runtime.id, tab: null }]) {
    move();
    await contentChrome.runtime.onMessage.emit({ type: 'page-state', enabled: false }, sender, () => assert.fail('Untrusted state messages must not receive an ACK'));
    assert(readPage().pointerAnchor, 'Page and foreign senders cannot change the live switch');
  }
  await contentChrome.runtime.onMessage.emit({ type: 'page-state', enabled: 'false' }, { id: chrome.runtime.id }, () => assert.fail('Malformed state must not receive an ACK'));
  assert(readPage().pointerAnchor, 'Only a Boolean state may change collection');
  await contentChrome.runtime.onMessage.emit({ type: 'page-state', enabled: false }, { id: chrome.runtime.id });
  await contentChrome.runtime.onMessage.emit({ type: 'page-state', enabled: false }, { id: chrome.runtime.id });
  const offSignals = contentMessages.length;
  page.y++; interval(); move();
  handlers['window:scroll'](); handlers['window:resize'](); handlers['viewport:scroll']();
  assert.equal(readPage().pointerAnchor, undefined, 'OFF must clear and stop collecting pointer observations');
  assert.equal(readPage().pointerCalibration.status, 'disabled', 'OFF must not record later structural events');
  assert.equal(contentMessages.length, offSignals, 'OFF must stop metadata change signals');
  await contentChrome.runtime.onMessage.emit({ type: 'page-state', enabled: true }, { id: chrome.runtime.id });
  assert.equal(readPage().pointerAnchor, undefined, 'Turning ON must not revive an old anchor');
  move(); assert(readPage().pointerAnchor);
  for (const message of contentMessages) {
    assert.deepEqual(Object.keys(message), ['type', 'geometryChanged'], 'Signals must never contain pointer coordinates, URLs, or DOM data');
    assert.equal(typeof message.geometryChanged, 'boolean');
  }
  sandbox.__iKnowItPageContext = () => readPage();
  const extracted = vm.runInContext('pageContext()', sandbox);
  assert.equal(extracted.pointerAnchor.screen.x, -1179.75, 'Background extraction must call the isolated page context function');
  assert.equal(extracted.pageWindow.screenX, -1280);
  delete sandbox.__iKnowItPageContext;
  const livePageState = value => contentChrome.runtime.onMessage.emit({ type: 'page-state', enabled: value }, { id: chrome.runtime.id });
  const beforeOrdinaryPageShow = stateRequests.length;
  handlers['window:pageshow']({ persisted: false });
  assert.equal(stateRequests.length, beforeOrdinaryPageShow, 'An ordinary pageshow must not repeat initial state initialization');
  assert(readPage().pointerAnchor);
  for (const [lifecycle, state] of [['bfcache', false], ['resume', false], ['bfcache', undefined]]) {
    await livePageState(true); move();
    assert(readPage().pointerAnchor);
    const beforeSuspend = contentMessages.length;
    handlers['document:freeze']();
    page.y++; interval(); move();
    assert.equal(readPage().pointerAnchor, undefined, 'Freezing must clear the anchor and stop collection');
    assert.equal(contentMessages.length, beforeSuspend, 'A frozen page must stay silent');
    // The worker switched OFF while this document could not receive page-state updates.
    const beforeRestore = stateRequests.length;
    if (lifecycle === 'bfcache') handlers['window:pageshow']({ persisted: true });
    else handlers['document:resume']();
    assert.equal(stateRequests.length, beforeRestore + 1, 'Restoration must request authoritative current state');
    move(); interval();
    assert.equal(readPage().pointerAnchor, undefined, 'A missing restore reply must leave reporting OFF');
    assert.equal(contentMessages.length, beforeSuspend, 'Restoration must not report using the pre-freeze ON state');
    resolveInitialState(state === undefined ? undefined : { enabled: state });
    await Promise.resolve(); move();
    assert.equal(readPage().pointerAnchor, undefined, 'Authoritative OFF or absent state must keep the restored page OFF');
  }
  for (const live of [false, true]) {
    handlers['window:pageshow']({ persisted: true });
    const staleReply = resolveInitialState;
    await livePageState(live);
    if (live) move();
    staleReply({ enabled: !live });
    await Promise.resolve(); move();
    assert.equal(!!readPage().pointerAnchor, live, 'A delayed restore reply must not override a newer live toggle');
  }
  handlers['document:freeze']();
  handlers['document:resume']();
  const olderResumeReply = resolveInitialState;
  handlers['window:pageshow']({ persisted: true });
  const newerRestoreReply = resolveInitialState;
  olderResumeReply({ enabled: true });
  await Promise.resolve(); move();
  assert.equal(readPage().pointerAnchor, undefined, 'An older resume reply must not enable a newer pending BFCache restoration');
  newerRestoreReply({ enabled: false });
  await Promise.resolve();
  handlers['document:resume']();
  const preFreezeReply = resolveInitialState;
  handlers['document:freeze']();
  preFreezeReply({ enabled: true });
  await Promise.resolve(); move();
  assert.equal(readPage().pointerAnchor, undefined, 'Freezing again must invalidate an outstanding state reply');
  await livePageState(true); move();
  contentChrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated'); };
  page.y++;
  assert.doesNotThrow(() => handlers['window:scroll'](), 'An unloaded extension must not throw errors into the page');
  interval(); handlers['window:resize'](); handlers['viewport:scroll']();
  assert.equal(readPage().pointerAnchor, undefined);
  assert.equal(readPage().pointerCalibration.status, 'extension-unavailable', 'Polling and reads must preserve the disabling reason');
  await livePageState(false);
  assert.equal(readPage().pointerCalibration.status, 'disabled', 'An explicit OFF state replaces the previous failure reason');
  for (const initialState of [true, false, 'unavailable', 'rejected', 'throw']) {
    const startupSignals = [];
    const startupContent = { ...content, addEventListener() {}, setInterval() {}, chrome: { runtime: {
      id: chrome.runtime.id, onMessage: event(), sendMessage(message) {
        if (message.type !== 'get-page-state') { startupSignals.push(message); return Promise.resolve(); }
        if (initialState === 'throw') throw new Error('Extension was unloaded');
        if (initialState === 'rejected') return Promise.reject(new Error('Worker was unavailable'));
        return Promise.resolve(initialState === 'unavailable' ? undefined : { enabled: initialState });
      },
    } } };
    delete startupContent.__iKnowItContextReady;
    delete startupContent.__iKnowItPageContext;
    assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(path.join(__dirname, 'context.js'), 'utf8'), vm.createContext(startupContent)));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(startupSignals.length, initialState === true ? 1 : 0,
      'Only an authoritative initial ON reply may enable page reporting');
  }
  console.log('PASS: fresh/correlated context; verified tab/window fallback for internal or inaccessible pages without DOM injection/leakage; scheme/privacy boundaries and transition invalidation; negative/fractional coordinates and scaling; invalid windows/tabs, navigation, incognito, zoom/script failures; storage read/write recovery; strict popup controls, serialized/duplicate explicit states and disabled startup/reconnect; explicit-only permission request with trusted popup, enabled and permission-required guards; one-shot settings-return reconnect with failed-send, focus, OFF, ready and old-port guards; status validation and disconnect reset; pending reads across OFF; native port isolation; authoritative page state and failed-storage toggle propagation; immediate existing-page recovery only after missing ACK, current URL/privacy guards, injection-failure fallback, OFF-during-injection isolation and duplicate-collector prevention; trusted/fractional calibration preserved while stationary and across document scroll/scrollback with original timestamps; ineligible-event seed rejection without replacing valid calibration; invalid-age, hidden, pointer-lock, OFF and geometry clearing without resurrection; equal-size structural signals invalidate pending native estimates; metadata-only signals without DOM writes; geometry invalidation on different Chrome windows without same-window focus cancellation; authoritative BFCache/resume state, freeze clearing and stale-reply isolation; forged/iframe messages rejected.');
})().catch(error => { console.error(error); process.exitCode = 1; });
