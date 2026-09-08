let enabled = false;
let port;
let timer;
let revision = 0;

function send(message) {
  try { port?.postMessage(message); } catch { /* Reconnect on the next alarm. */ }
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

async function readContext(version, requestId) {
  const recipient = port;
  let context = unavailable();
  try {
    if (!enabled) throw new Error('Disabled');
    const window = await chrome.windows.getLastFocused({ populate: true });
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
  if (port) return;
  try {
    const connection = chrome.runtime.connectNative('com.iknowit.bridge');
    port = connection;
    connection.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port === connection) port = undefined;
    });
    connection.onMessage.addListener((message) => {
      if (port !== connection || message?.type !== 'request-context') return;
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
});

let changing = ready;
function setEnabled(value) {
  const operation = changing.then(async () => {
    if (enabled === value) { connect(); return { enabled }; }
    enabled = value;
    revision++;
    clearTimeout(timer);
    send({ type: 'enabled', enabled });
    await Promise.all([chrome.storage.local.set({ enabled }).catch(() => {}), updateButton()]);
    connect();
    if (enabled) refresh(true);
    return { enabled };
  });
  changing = operation.catch(() => {});
  return operation;
}
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'native-reconnect') { await ready; connect(); }
});
chrome.runtime.onInstalled.addListener(() => { void ready.then(() => refresh(true)); });
chrome.runtime.onStartup.addListener(() => { void ready.then(() => refresh(true)); });
chrome.tabs.onActivated.addListener(() => refresh(true));
chrome.tabs.onRemoved.addListener(() => refresh(true));
chrome.tabs.onUpdated.addListener((_id, changes, tab) => {
  if (tab.active && (changes.status || changes.url || changes.title)) refresh(true);
});
chrome.tabs.onZoomChange.addListener(() => refresh());
chrome.windows.onFocusChanged.addListener(() => refresh(true));
chrome.windows.onBoundsChanged.addListener(() => refresh(true));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'context-changed' && sender?.id === chrome.runtime.id
    && sender.frameId === 0 && sender.tab?.active && !sender.tab.incognito
    && /^https?:\/\//.test(sender.url ?? '')) refresh();
  if ((message?.type !== 'get-state' && message?.type !== 'set-enabled')
    || sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')
    || sender.tab !== undefined || (message.type === 'set-enabled' && typeof message.enabled !== 'boolean')) return;
  const operation = message.type === 'get-state'
    ? changing.then(() => ({ enabled })) : setEnabled(message.enabled);
  void operation.then(sendResponse, () => sendResponse({ enabled })).catch(() => {});
  return true;
});
