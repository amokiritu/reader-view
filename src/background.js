// Toolbar button behaves like Safari's Reader button:
//  - greyed out unless the page looks like an article (detect.js tells us)
//  - highlighted while Reader is showing
//  - click / Alt+Shift+R toggles Reader

importScripts("code-fetch.js");

const ICON = {
  idle: { 16: "/icons/reader-16.png", 32: "/icons/reader-32.png", 48: "/icons/reader-48.png", 128: "/icons/reader-128.png" },
  // Light lines for dark toolbars (browser in dark mode), like Safari's Reader button.
  idleOnDark: { 16: "/icons/reader-ondark-16.png", 32: "/icons/reader-ondark-32.png", 48: "/icons/reader-ondark-48.png", 128: "/icons/reader-ondark-128.png" },
  active: { 16: "/icons/reader-active-16.png", 32: "/icons/reader-active-32.png", 48: "/icons/reader-active-48.png", 128: "/icons/reader-active-128.png" },
};

// Pages report the browser's light/dark setting (a service worker can't see it). Remembered for
// the session so tabs without a page script (new tab, settings) get the right icon too.
let darkMode = false;
const schemeLoaded = chrome.storage.session
  .get("darkMode")
  .then((r) => (darkMode = !!r.darkMode))
  .catch(() => {});

async function updateScheme(dark) {
  await schemeLoaded;
  if (typeof dark !== "boolean" || dark === darkMode) return;
  darkMode = dark;
  chrome.storage.session.set({ darkMode }).catch(() => {});
  chrome.action.setIcon({ path: darkMode ? ICON.idleOnDark : ICON.idle }).catch(() => {});
}

// ---------- "new version available" (copies installed from GitHub) ----------
// Store copies update themselves (the store adds update_url to the manifest). Copies installed
// from the GitHub zip can't, so once a day ask GitHub for the latest release and, if it's
// newer, show an arrow on the button and a link in Reader's Aa menu.
const REPO_RELEASES = "https://github.com/amokiritu/reader-view/releases/latest";
const RELEASES_API = "https://api.github.com/repos/amokiritu/reader-view/releases/latest";
const UPDATE_CHECK_EVERY = 24 * 60 * 60 * 1000;
const fromStore = "update_url" in chrome.runtime.getManifest();
let update = null; // { version, url } while a newer release exists

function isNewer(a, b) {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

function applyUpdateInfo(info) {
  const current = chrome.runtime.getManifest().version;
  update = !fromStore && info && info.version && isNewer(info.version, current) ? info : null;
  chrome.action.setBadgeText({ text: update ? "↑" : "" }).catch(() => {});
  if (update) {
    chrome.action.setBadgeBackgroundColor({ color: "#007aff" }).catch(() => {});
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#ffffff" }).catch(() => {});
  }
}

const updateLoaded = chrome.storage.local
  .get("update")
  .then((r) => applyUpdateInfo(r.update))
  .catch(() => {});

async function checkForUpdate(force = false) {
  if (fromStore) return;
  try {
    const { updateCheckedAt = 0 } = await chrome.storage.local.get("updateCheckedAt");
    if (!force && Date.now() - updateCheckedAt < UPDATE_CHECK_EVERY) return;
    await chrome.storage.local.set({ updateCheckedAt: Date.now() });
    const res = await fetch(RELEASES_API, { credentials: "omit", headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return;
    const j = await res.json();
    const version = String(j.tag_name || "").replace(/^v/i, "");
    if (j.draft || j.prerelease || !/^\d+(\.\d+){0,3}$/.test(version)) return;
    const url = /^https:\/\/github\.com\/amokiritu\/reader-view\//.test(j.html_url || "") ? j.html_url : REPO_RELEASES;
    const info = { version, url };
    await chrome.storage.local.set({ update: info });
    applyUpdateInfo(info);
  } catch {
    // Offline or GitHub unavailable: try again next time.
  }
}

chrome.runtime.onStartup.addListener(() => checkForUpdate());

async function setTabState(tabId, { available, active }) {
  await schemeLoaded;
  await updateLoaded;
  try {
    if (available) await chrome.action.enable(tabId);
    else await chrome.action.disable(tabId);
    await chrome.action.setIcon({ tabId, path: active ? ICON.active : darkMode ? ICON.idleOnDark : ICON.idle });
    await chrome.action.setTitle({
      tabId,
      title:
        (!available ? "Reader is unavailable for this page" : active ? "Hide Reader (Alt+Shift+R)" : "Show Reader (Alt+Shift+R)") +
        (update ? ` · Version ${update.version} is available` : ""),
    });
  } catch {
    // Tab closed or not accessible.
  }
}

async function runReader(tabId, mode) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["vendor/Readability.js", "src/reader.js"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (m) => window.__readerView && window.__readerView[m](),
      args: [mode],
    });
  } catch (err) {
    console.warn("Reader could not run on this page:", err);
  }
}

// Disabled by default; detect.js enables it per tab when the page is readerable.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.action.disable();
  // Just installed or updated: forget an old notice if this is the new version, and check.
  await updateLoaded;
  chrome.storage.local.get("update").then((r) => applyUpdateInfo(r.update)).catch(() => {});
  checkForUpdate(true);
  // Run detection in tabs that were already open before install/update.
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*", "file:///*"] });
  for (const tab of tabs) {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: ["vendor/Readability-readerable.js", "src/detect.js"] })
      .catch(() => {});
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  // Some browsers (e.g. Dia) keep keyboard focus on the toolbar after the click, so Esc
  // wouldn't reach Reader. Re-focusing the window is the closest an extension can get.
  if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  runReader(tab.id, "toggle");
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) setTabState(tabId, { available: false, active: false });
  // Sites often update the address after loading, which greys the button above even though
  // the article is still there. Once loading finishes, ask the page to report again.
  if (info.status === "complete") chrome.tabs.sendMessage(tabId, { type: "recheck" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) return;
  switch (msg.type) {
    case "get-css":
      // Reader's stylesheet, handed over directly so it needn't be exposed to websites.
      fetch(chrome.runtime.getURL("src/reader.css"))
        .then((r) => r.text())
        .then(sendResponse, () => sendResponse(null));
      return true;
    case "fetch-code":
      // Reader asks for a Gist (or Medium embed) the article only links to.
      resolveCode(msg.url, sender.tab.url || "").then(sendResponse, () => sendResponse(null));
      return true; // answer arrives asynchronously
    case "load-hls":
      // hls.js, for an article with a streaming video (see setupStreams in reader.js).
      chrome.scripting
        .executeScript({ target: { tabId, frameIds: [sender.frameId || 0] }, files: ["vendor/hls.light.min.js"] })
        .then(() => sendResponse(true), () => sendResponse(false));
      return true;
    case "update-info":
      updateLoaded.then(() => sendResponse(update));
      return true;
    case "readerable":
      checkForUpdate(); // at most once a day
      updateScheme(msg.dark).then(() => setTabState(tabId, { available: msg.ok, active: false }));
      break;
    case "reader-state":
      updateScheme(msg.dark).then(() => setTabState(tabId, { available: true, active: msg.active }));
      break;
    case "open-reader":
      runReader(tabId, "open");
      break;
  }
});
