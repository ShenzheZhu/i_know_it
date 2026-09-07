function pageContext() {
  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY },
    devicePixelRatio,
    visualScale: visualViewport?.scale ?? 1,
  };
}

let capturing = false;
chrome.action.onClicked.addListener(async (tab) => {
  if (capturing) return;
  capturing = true;
  const id = crypto.randomUUID();
  try {
    await chrome.action.setBadgeText({ text: "", tabId: tab.id });
    const read = async () => (await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: pageContext,
    }))[0].result;
    const context = await read();
    if (context.visualScale !== 1) throw new Error("Reset trackpad pinch zoom before capturing.");
    const zoom = await chrome.tabs.getZoom(tab.id);
    const timestamp = new Date().toISOString();
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (active?.id !== tab.id || JSON.stringify(context) !== JSON.stringify(await read())) {
      throw new Error("The page changed during capture. Please try again.");
    }
    // Only the pending capture is stored; opening the selection page consumes it.
    await chrome.storage.session.clear();
    await chrome.storage.session.set({ [id]: { image, context: { ...context, timestamp, zoom } } });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`capture.html#${id}`) });
  } catch (error) {
    await chrome.storage.session.remove(id);
    await chrome.action.setBadgeText({ text: "!", tabId: tab.id }).catch(() => {});
    await chrome.action.setTitle({ title: `Capture failed: ${error.message}`, tabId: tab.id }).catch(() => {});
    await chrome.tabs.create({ url: chrome.runtime.getURL(`capture.html#error=${encodeURIComponent(error.message)}`) });
  } finally {
    capturing = false;
  }
});
