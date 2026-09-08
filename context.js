(() => {
  if (globalThis.__iKnowItContextReady) return;
  globalThis.__iKnowItContextReady = true;
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
  function report(force = false) {
    if (!enabled || document.visibilityState !== 'visible') { anchor = undefined; return; }
    const page = snapshot();
    const current = geometry(page);
    const geometryChanged = force === true || current !== previous;
    if (!geometryChanged && page.title === previousTitle) return;
    if (geometryChanged) anchor = undefined;
    previous = current; previousTitle = page.title;
    try { chrome.runtime.sendMessage({ type: 'context-changed', geometryChanged }).catch(() => {}); }
    catch { enabled = false; anchor = undefined; }
  }
  function invalidate() { anchor = undefined; report(true); }
  function setEnabled(value) {
    stateRevision++;
    enabled = value === true;
    anchor = undefined;
    previous = undefined;
    report();
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'page-state' && typeof message.enabled === 'boolean'
      && sender?.id === chrome.runtime.id && sender.tab === undefined) {
      setEnabled(message.enabled);
      sendResponse?.({ contextReady: true });
    }
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
    if (document.pointerLockElement || document.visibilityState !== 'visible'
      || !Number.isFinite(now) || (anchor && now < anchor.time)) { anchor = undefined; return; }
    if (!event.isTrusted || event.pointerType !== 'mouse' || event.buttons !== 0
      || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey
      || !document.hasFocus()
      || ![now, event.timeStamp, event.screenX, event.screenY, event.clientX, event.clientY].every(Number.isFinite)
      || now - event.timeStamp < 0 || now - event.timeStamp > 100) return;
    // ponytail: retain one calibration while its geometry stays unchanged, not a pointer trace.
    anchor = {
      screen: { x: event.screenX, y: event.screenY }, client: { x: event.clientX, y: event.clientY },
      time: event.timeStamp, observedAt: new Date().toISOString(), signature: previous,
    };
  }, { passive: true });
  // This function lives in Chrome's isolated extension world, not the page's world.
  globalThis.__iKnowItPageContext = () => {
    const page = snapshot();
    const ageMs = anchor ? performance.now() - anchor.time : Infinity;
    if (anchor && anchor.signature !== geometry(page)) invalidate();
    if (enabled && document.visibilityState === 'visible' && !document.pointerLockElement && anchor
      && Number.isFinite(ageMs) && ageMs >= 0) {
      page.pointerAnchor = { screen: anchor.screen, client: anchor.client, ageMs, observedAt: anchor.observedAt };
    } else { anchor = undefined; }
    return page;
  };
  for (const event of ['scroll', 'resize', 'hashchange', 'popstate']) {
    addEventListener(event, invalidate, { passive: true });
  }
  addEventListener('pageshow', event => { if (event.persisted) readState(); else report(); }, { passive: true });
  document.addEventListener('freeze', () => setEnabled(false));
  document.addEventListener('resume', readState);
  document.addEventListener('visibilitychange', report);
  document.addEventListener('fullscreenchange', invalidate);
  document.addEventListener('pointerlockchange', invalidate);
  visualViewport?.addEventListener('scroll', invalidate, { passive: true });
  visualViewport?.addEventListener('resize', invalidate, { passive: true });
  // Detect SPA URL/title and window-position changes without replacing page APIs.
  setInterval(report, 1000);
})();
