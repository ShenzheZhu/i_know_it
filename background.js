let enabled = false;
let port;
let timer;
let revision = 0;
let inputStatus = 'disconnected';
let permissionReturn;
let reconnectTimer;
let lastFocusedWindowId;
const state = () => ({ enabled, inputStatus });

function updateInputStatus(status) {
  if (['ready', 'off', 'disconnected'].includes(status)) permissionReturn = undefined;
  if (inputStatus === status) return;
  inputStatus = status;
  void chrome.runtime.sendMessage({ type: 'input-status', ...state() }).catch(() => {});
}

function send(message) {
  if (!port) return false;
  try { port.postMessage(message); return true; } catch { /* Reconnect on the next alarm. */ return false; }
}

function unavailable(window, tabId) {
  return {
    type: 'browser-context', observedAt: new Date().toISOString(), available: false,
    ...(window && {
      windowId: window.id, tabId,
      window: Object.fromEntries(['focused', 'left', 'top', 'width', 'height', 'state']
        .map((key) => [key, window[key]])),
    }),
  };
}

function pageContext() {
  if (typeof globalThis.__iKnowItPageContext === 'function') return globalThis.__iKnowItPageContext();
  return {
    url: location.href, title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY }, devicePixelRatio,
    visualViewport: {
      scale: visualViewport?.scale ?? 1,
      offsetLeft: visualViewport?.offsetLeft ?? 0,
      offsetTop: visualViewport?.offsetTop ?? 0,
    },
  };
}

function invalidateGeometry() {
  if (enabled) send({ type: 'browser-geometry-invalidated' });
}

async function updatePages() {
  // Keep OFF effective in open pages even if persisting the setting fails.
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.filter(tab => !tab.incognito && /^https?:\/\//.test(tab.url ?? ''))
      .map(tab => chrome.tabs.sendMessage(tab.id, { type: 'page-state', enabled }, { frameId: 0 }).catch(() => {})));
  } catch { /* Closing tabs or pages without our content script need no update. */ }
}

async function readContext(version, requestId) {
  const recipient = port;
  let context = unavailable();
  try {
    if (!enabled) throw new Error('Disabled');
    const window = await chrome.windows.getLastFocused({ populate: true });
    if (lastFocusedWindowId === undefined && Number.isInteger(window?.id) && window.id >= 0) {
      lastFocusedWindowId = window.id;
    }
    const tab = window.tabs?.find((item) => item.active);
    context = unavailable(window, tab?.id);
    if (window.focused && !window.incognito && tab && !tab.incognito
      && tab.status === 'complete' && /^(?:https?|chrome):\/\//.test(tab.url ?? '')) {
      const observedAt = new Date().toISOString();
      const internalPage = tab.url.startsWith('chrome://');
      const [script, scale] = await Promise.allSettled([
        internalPage ? Promise.resolve([])
          : chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageContext }),
        chrome.tabs.getZoom(tab.id),
      ]);
      const current = await chrome.windows.getLastFocused({ populate: true });
      const active = current.tabs?.find((item) => item.active);
      const page = script.status === 'fulfilled' && Array.isArray(script.value)
        ? script.value.find((item) => item.frameId === 0)?.result : undefined;
      if (current.focused && !current.incognito && current.id === window.id && active?.id === tab.id
        && !active.incognito && active.status === 'complete' && active.url === tab.url
        && (internalPage || script.status === 'rejected' || page?.url === tab.url)
        && ['left', 'top', 'width', 'height', 'state'].every((key) => current[key] === window[key])) {
        const pageAvailable = !internalPage && page?.url === active.url;
        context = {
          ...context, ...(pageAvailable && page), observedAt, available: true,
          url: active.url, title: active.title, pageAvailable,
          ...(!pageAvailable && { pageUnavailableReason: internalPage ? 'browser-internal-page' : 'page-read-failed' }),
          ...(scale.status === 'fulfilled' && { zoom: scale.value }),
        };
      } else {
        context = unavailable(current, active?.id);
      }
    }
  } catch { /* Unverifiable windows and closing tabs have no browser context. */ }
  if (port !== recipient) return;
  if (requestId) {
    send({ ...(enabled && version === revision ? context : unavailable()), requestId });
  } else if (enabled && version === revision) send(context);
}

function refresh(invalidate = false) {
  revision++;
  if (!enabled) return;
  if (invalidate) send(unavailable());
  clearTimeout(timer);
  timer = setTimeout(() => { void readContext(revision); }, 60);
}

function connect() {
  if (port || reconnectTimer) return;
  try {
    const connection = chrome.runtime.connectNative('com.iknowit.bridge');
    port = connection;
    connection.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port === connection) { port = undefined; updateInputStatus('disconnected'); }
    });
    connection.onMessage.addListener((message) => {
      if (port !== connection) return;
      if (message?.type === 'input-status') {
        if (['ready', 'permission-required', 'unavailable', 'off'].includes(message.status)) updateInputStatus(message.status);
        return;
      }
      if (message?.type !== 'request-context') return;
      if (typeof message.requestId === 'string' && message.requestId.length <= 128) {
        void readContext(revision, message.requestId);
      } else refresh();
    });
    send({ type: 'enabled', enabled });
    refresh(true);
  } catch { /* The installer may not have registered the host yet. */ }
}

function updateButton() {
  return Promise.all([
    chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' }),
    chrome.action.setTitle({ title: `I Know It! — ${enabled ? 'On' : 'Off'}` }),
  ]);
}

const ready = chrome.storage.local.get({ enabled: true }).catch(() => ({ enabled: false })).then(async (settings) => {
  enabled = settings.enabled !== false;
  await updateButton();
  await chrome.alarms.create('native-reconnect', { periodInMinutes: 0.5 });
  connect();
  await updatePages();
});

let changing = ready;
function setEnabled(value) {
  const operation = changing.then(async () => {
    if (enabled === value) { connect(); return state(); }
    enabled = value;
    if (!enabled) permissionReturn = undefined;
    inputStatus = enabled ? 'disconnected' : 'off';
    revision++;
    clearTimeout(timer);
    send({ type: 'enabled', enabled });
    await Promise.all([chrome.storage.local.set({ enabled }).catch(() => {}), updateButton(), updatePages()]);
    connect();
    if (enabled) refresh(true);
    return state();
  });
  changing = operation.catch(() => {});
  return operation;
}
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'native-reconnect') { await ready; connect(); }
});
chrome.runtime.onInstalled.addListener(() => { void ready.then(() => refresh(true)); });
chrome.runtime.onStartup.addListener(() => { void ready.then(() => refresh(true)); });
chrome.tabs.onActivated.addListener(() => { invalidateGeometry(); refresh(true); });
chrome.tabs.onRemoved.addListener(() => { invalidateGeometry(); refresh(true); });
chrome.tabs.onUpdated.addListener((_id, changes, tab) => {
  if (tab.active && (changes.status || changes.url)) invalidateGeometry();
  if (tab.active && (changes.status || changes.url || changes.title)) refresh(true);
});
chrome.tabs.onZoomChange.addListener(() => { invalidateGeometry(); refresh(); });
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (Number.isInteger(windowId) && windowId >= 0) {
    if (lastFocusedWindowId !== undefined && lastFocusedWindowId !== windowId) invalidateGeometry();
    lastFocusedWindowId = windowId;
  }
  if (permissionReturn && enabled && port) {
    if (windowId === chrome.windows.WINDOW_ID_NONE) permissionReturn.blurred = true;
    else if (Number.isInteger(windowId) && windowId >= 0 && permissionReturn.blurred) {
      // macOS caches an earlier Input Monitoring denial until the host exits.
      const connection = port;
      port = undefined;
      updateInputStatus('disconnected');
      reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, 100);
      try { connection.disconnect(); } catch { /* The host may already have exited. */ }
    }
  }
  refresh(true);
});
chrome.windows.onBoundsChanged.addListener(() => { invalidateGeometry(); refresh(true); });
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const pageSender = sender?.id === chrome.runtime.id && sender.frameId === 0
    && sender.tab && !sender.tab.incognito && /^https?:\/\//.test(sender.url ?? '');
  if (message?.type === 'get-page-state' && pageSender) {
    void changing.then(() => sendResponse({ enabled }));
    return true;
  }
  if (message?.type === 'context-changed' && pageSender && sender.tab.active) {
    if (message.geometryChanged === true) invalidateGeometry();
    refresh();
  }
  if (!['get-state', 'set-enabled', 'request-input-access'].includes(message?.type)
    || sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')
    || sender.tab !== undefined || (message.type === 'set-enabled' && typeof message.enabled !== 'boolean')) return;
  const operation = message.type === 'set-enabled' ? setEnabled(message.enabled) : changing.then(() => {
    if (message.type === 'request-input-access' && enabled && inputStatus === 'permission-required') {
      if (send({ type: 'request-input-access' })) permissionReturn = { blurred: false };
    }
    return state();
  });
  void operation.then(sendResponse, () => sendResponse(state())).catch(() => {});
  return true;
});
