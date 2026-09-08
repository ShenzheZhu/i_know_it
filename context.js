(() => {
  let previous;
  function report() {
    if (document.visibilityState !== 'visible') return;
    const current = JSON.stringify([
      location.href, document.title, innerWidth, innerHeight, scrollX, scrollY,
      devicePixelRatio, visualViewport?.scale, visualViewport?.offsetLeft, visualViewport?.offsetTop,
    ]);
    if (current === previous) return;
    previous = current;
    try { chrome.runtime.sendMessage({ type: 'context-changed' }).catch(() => {}); }
    catch { /* The extension may have been reloaded or removed. */ }
  }
  for (const event of ['scroll', 'resize', 'hashchange', 'popstate', 'pageshow']) {
    addEventListener(event, report, { passive: true });
  }
  document.addEventListener('visibilitychange', report);
  visualViewport?.addEventListener('scroll', report, { passive: true });
  visualViewport?.addEventListener('resize', report, { passive: true });
  // Detect SPA URL/title changes without replacing the page's history APIs.
  setInterval(report, 1000);
  report();
})();
