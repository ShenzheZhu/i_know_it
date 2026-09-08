(() => {
  if (globalThis.__iKnowItContextReady) return;
  globalThis.__iKnowItContextReady = true;
  let enabled = false;
  let stateRevision = 0;
  let previous;
  let previousTitle;
  let anchor;
  let calibrationStatus = 'not-observed';
  function clearAnchor(reason) { anchor = undefined; calibrationStatus = reason; }
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
  function report(force = false, reason = 'geometry-changed') {
    if (!enabled) { anchor = undefined; return; }
    if (document.visibilityState !== 'visible') { clearAnchor('hidden'); return; }
    const page = snapshot();
    const current = geometry(page);
    const geometryChanged = force === true || current !== previous;
    if (!geometryChanged && page.title === previousTitle) return;
    if (geometryChanged) clearAnchor(reason);
    previous = current; previousTitle = page.title;
    try { chrome.runtime.sendMessage({ type: 'context-changed', geometryChanged }).catch(() => {}); }
    catch { enabled = false; clearAnchor('extension-unavailable'); }
  }
  function invalidate(reason = 'geometry-changed') {
    if (!enabled) return;
    clearAnchor(reason); report(true, reason);
  }
  function setEnabled(value) {
    stateRevision++;
    if (enabled && value === true) { report(); return; }
    enabled = value === true;
    clearAnchor(enabled ? 'awaiting-pointer' : 'disabled');
    previous = undefined;
    report(false, calibrationStatus);
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
    if (document.pointerLockElement) { clearAnchor('pointer-lock'); return; }
    if (document.visibilityState !== 'visible') { clearAnchor('hidden'); return; }
    if (!Number.isFinite(now) || (anchor && now < anchor.time)) { clearAnchor('invalid-clock'); return; }
    if (!event.isTrusted || event.pointerType !== 'mouse') return;
    const rejected = event.buttons !== 0 || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey
      ? 'modified-or-pressed-pointer' : !document.hasFocus() ? 'unfocused-pointer'
        : ![event.timeStamp, event.screenX, event.screenY, event.clientX, event.clientY].every(Number.isFinite)
          ? 'invalid-pointer-data' : now - event.timeStamp < 0 || now - event.timeStamp > 100
            ? 'out-of-time-pointer' : undefined;
    if (rejected) { if (!anchor) calibrationStatus = rejected; return; }
    // ponytail: retain one calibration while its geometry stays unchanged, not a pointer trace.
    anchor = {
      screen: { x: event.screenX, y: event.screenY }, client: { x: event.clientX, y: event.clientY },
      time: event.timeStamp, observedAt: new Date().toISOString(), signature: previous,
    };
    calibrationStatus = 'ready';
  }, { passive: true });
  // This function lives in Chrome's isolated extension world, not the page's world.
  globalThis.__iKnowItPageContext = () => {
    const page = snapshot();
    const ageMs = anchor ? performance.now() - anchor.time : Infinity;
    if (anchor && anchor.signature !== geometry(page)) invalidate('geometry-mismatch');
    if (enabled && document.visibilityState === 'visible' && !document.pointerLockElement && anchor
      && Number.isFinite(ageMs) && ageMs >= 0) {
      page.pointerAnchor = { screen: anchor.screen, client: anchor.client, ageMs, observedAt: anchor.observedAt };
    } else if (!enabled) anchor = undefined;
    else if (document.visibilityState !== 'visible') clearAnchor('hidden');
    else if (document.pointerLockElement) clearAnchor('pointer-lock');
    else if (anchor) clearAnchor('invalid-clock');
    // Keep only the current reason, never an input/event history or rejected coordinates.
    page.pointerCalibration = {
      status: calibrationStatus, enabled, visibility: document.visibilityState, focused: document.hasFocus(),
    };
    return page;
  };
  for (const event of ['scroll', 'resize', 'hashchange', 'popstate']) {
    addEventListener(event, () => invalidate(`window-${event}`), { passive: true });
  }
  addEventListener('pageshow', event => { if (event.persisted) readState(); else report(); }, { passive: true });
  document.addEventListener('freeze', () => setEnabled(false));
  document.addEventListener('resume', readState);
  document.addEventListener('visibilitychange', report);
  document.addEventListener('fullscreenchange', () => invalidate('fullscreen-change'));
  document.addEventListener('pointerlockchange', () => invalidate('pointer-lock-change'));
  visualViewport?.addEventListener('scroll', () => invalidate('viewport-scroll'), { passive: true });
  visualViewport?.addEventListener('resize', () => invalidate('viewport-resize'), { passive: true });
  // Detect SPA URL/title and window-position changes without replacing page APIs.
  setInterval(report, 1000);
})();
