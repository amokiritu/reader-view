// Toolbar button behaves like Safari's Reader button:
//  - greyed out unless the page looks like an article (detect.js tells us)
//  - highlighted while Reader is showing
//  - click / Alt+Shift+R toggles Reader

importScripts("code-fetch.js");

const ICON = {
  idle: { 16: "icons/reader-16.png", 32: "icons/reader-32.png", 48: "icons/reader-48.png", 128: "icons/reader-128.png" },
  // Light lines for dark toolbars (browser in dark mode), like Safari's Reader button.
  idleOnDark: { 16: "icons/reader-ondark-16.png", 32: "icons/reader-ondark-32.png", 48: "icons/reader-ondark-48.png", 128: "icons/reader-ondark-128.png" },
  active: { 16: "icons/reader-active-16.png", 32: "icons/reader-active-32.png", 48: "icons/reader-active-48.png", 128: "icons/reader-active-128.png" },
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

async function setTabState(tabId, { available, active }) {
  await schemeLoaded;
  try {
    if (available) await chrome.action.enable(tabId);
    else await chrome.action.disable(tabId);
    await chrome.action.setIcon({ tabId, path: active ? ICON.active : darkMode ? ICON.idleOnDark : ICON.idle });
    await chrome.action.setTitle({
      tabId,
      title: !available ? "Reader is unavailable for this page" : active ? "Hide Reader (Alt+Shift+R)" : "Show Reader (Alt+Shift+R)",
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
    case "fetch-code":
      // Reader asks for a Gist (or Medium embed) the article only links to.
      resolveCode(msg.url, sender.tab.url || "").then(sendResponse, () => sendResponse(null));
      return true; // answer arrives asynchronously
    case "readerable":
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
