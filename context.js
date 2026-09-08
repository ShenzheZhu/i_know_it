(() => {
  let enabled = false;
  let stateRevision = 0;
  let previous;
  let previousTitle;
  let anchor;
  function snapshot() {
    return {
      url: location.href, title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      scroll: { x: scrollX, y: scrollY }, devicePixelRatio,
      visualViewport: {
        scale: visualViewport?.scale ?? 1,
        offsetLeft: visualViewport?.offsetLeft ?? 0,
        offsetTop: visualViewport?.offsetTop ?? 0,
      },
      pageWindow: { screenX, screenY, outerWidth, outerHeight },
      fullscreen: !!document.fullscreenElement,
    };
  }
  const geometry = page => JSON.stringify({ ...page, title: undefined });
  function report() {
    if (!enabled || document.visibilityState !== 'visible') { anchor = undefined; return; }
    const page = snapshot();
    const current = geometry(page);
    const geometryChanged = current !== previous;
    if (!geometryChanged && page.title === previousTitle) return;
    if (geometryChanged) anchor = undefined;
    previous = current; previousTitle = page.title;
    try { chrome.runtime.sendMessage({ type: 'context-changed', geometryChanged }).catch(() => {}); }
    catch { enabled = false; anchor = undefined; }
  }
  function setEnabled(value) {
    stateRevision++;
    enabled = value === true;
    anchor = undefined;
    previous = undefined;
    report();
  }
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === 'page-state' && sender.id === chrome.runtime.id && !sender.tab) setEnabled(message.enabled);
  });
  function readState() {
    setEnabled(false);
    const requestedRevision = stateRevision;
    try {
      chrome.runtime.sendMessage({ type: 'get-page-state' }).then(state => {
        if (stateRevision === requestedRevision) setEnabled(state?.enabled);
      }).catch(() => {});
    } catch { /* An unavailable extension stays OFF. */ }
  }
  readState();

  addEventListener('pointermove', event => {
    if (!enabled) return;
    report();
    const now = performance.now();
    if (!event.isTrusted || event.pointerType !== 'mouse' || event.buttons !== 0
      || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey
      || document.pointerLockElement || document.visibilityState !== 'visible' || !document.hasFocus()
      || ![now, event.timeStamp, event.screenX, event.screenY, event.clientX, event.clientY].every(Number.isFinite)
      || now - event.timeStamp < 0 || now - event.timeStamp > 100) { anchor = undefined; return; }
    // ponytail: retain one recent observation, not a trace; unsupported layouts stay unknown.
    anchor = {
      screen: { x: event.screenX, y: event.screenY }, client: { x: event.clientX, y: event.clientY },
      time: event.timeStamp, observedAt: new Date().toISOString(), signature: previous,
    };
  }, { passive: true });
  // This function lives in Chrome's isolated extension world, not the page's world.
  globalThis.__iKnowItPageContext = () => {
    const page = snapshot();
    const ageMs = anchor ? performance.now() - anchor.time : Infinity;
    if (enabled && document.visibilityState === 'visible' && anchor?.signature === geometry(page)
      && ageMs >= 0 && ageMs <= 1000) {
      page.pointerAnchor = { screen: anchor.screen, client: anchor.client, ageMs, observedAt: anchor.observedAt };
    }
    return page;
  };
  for (const event of ['scroll', 'resize', 'hashchange', 'popstate']) {
    addEventListener(event, report, { passive: true });
  }
  addEventListener('pageshow', event => { if (event.persisted) readState(); else report(); }, { passive: true });
  document.addEventListener('freeze', () => setEnabled(false));
  document.addEventListener('resume', readState);
  document.addEventListener('visibilitychange', report);
  document.addEventListener('fullscreenchange', report);
  visualViewport?.addEventListener('scroll', report, { passive: true });
  visualViewport?.addEventListener('resize', report, { passive: true });
  // Detect SPA URL/title and window-position changes without replacing page APIs.
  setInterval(report, 1000);
})();
