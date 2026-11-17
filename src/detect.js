// Runs on every page. Like Safari, Reader is only offered when the page looks like an article:
// we tell the background worker so it can enable/disable the toolbar button for this tab,
// and auto-open Reader on sites the user chose "Use Reader automatically" for.
(() => {
  if (window.top !== window) return;

  const WATCH_MS = 30000; // keep watching for late-arriving article text this long
  let lastResult = null;
  let autoOpened = false;
  let urlTimer = null;

  // The browser's light/dark setting, so the toolbar icon can use light lines on dark toolbars.
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  const readerOpen = () => !!(window.__readerView && window.__readerView.isOpen && window.__readerView.isOpen());

  // After the extension is updated or removed, this old copy can't reach it any more: stop.
  const orphaned = () => !(chrome.runtime && chrome.runtime.id);

  async function check(force = false) {
    if (orphaned()) return shutDown();
    // While Reader is showing, keep the button on (the browser may have reset it, e.g. when
    // the site changed its address or the page came back from the back/forward cache).
    if (readerOpen()) {
      if (force) chrome.runtime.sendMessage({ type: "reader-state", active: true, dark: darkQuery.matches }).catch(() => {});
      return;
    }
    let ok = false;
    try {
      ok = isProbablyReaderable(document, { minContentLength: 140, minScore: 20 });
    } catch {}
    if (ok !== lastResult || force) {
      lastResult = ok;
      chrome.runtime.sendMessage({ type: "readerable", ok, dark: darkQuery.matches }).catch(() => {});
    }
    if (ok) stopWatching();
    if (ok && !autoOpened) {
      const { autoHosts = [] } = await chrome.storage.sync.get("autoHosts");
      if (autoHosts.includes(location.hostname)) {
        autoOpened = true;
        chrome.runtime.sendMessage({ type: "open-reader" }).catch(() => {});
      }
    }
  }

  // Article text often arrives after load (client-side rendering, paywall scripts, bypass
  // extensions). Watch the page for a while and re-check shortly after it changes.
  let observer = null;
  let debounce = null;
  let watchTimer = null;
  function watch() {
    stopWatching();
    if (!document.body) return;
    observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => check(), 700);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    watchTimer = setTimeout(stopWatching, WATCH_MS);
  }
  function stopWatching() {
    if (observer) observer.disconnect();
    observer = null;
    clearTimeout(debounce);
    clearTimeout(watchTimer);
  }

  check(true);
  if (!lastResult) watch();
  setTimeout(() => check(), 1500);
  setTimeout(() => check(), 4000);

  // The background worker greys the button whenever the tab's address changes (including
  // in-page address updates many news sites make after loading), then asks us to re-check.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "recheck") check(true);
  });

  // Browser switched between light and dark: redraw this tab's icon to match.
  darkQuery.addEventListener("change", () => {
    if (readerOpen()) chrome.runtime.sendMessage({ type: "reader-state", active: true, dark: darkQuery.matches }).catch(() => {});
    else check(true);
  });

  // Single-page apps: re-check after in-page navigation, and always report the result,
  // since the button was reset when the address changed.
  let lastUrl = location.href;
  urlTimer = setInterval(() => {
    if (orphaned()) return shutDown();
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      autoOpened = false;
      setTimeout(() => {
        check(true);
        if (!lastResult) watch();
      }, 800);
    }
  }, 1000);

  function shutDown() {
    stopWatching();
    clearInterval(urlTimer);
  }
})();
