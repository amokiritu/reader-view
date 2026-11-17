// Dev-only harness: lets you exercise reader.js in a plain browser tab (no extension install).
// Serve the repo root (e.g. `python -m http.server 8766`) and open /test/sample-article.html.
const HARNESS_ORIGIN = new URL(document.currentScript.src).origin;
(async () => {
  const mem = {};
  window.chrome = window.chrome || {};
  chrome.runtime = {
    getURL: (p) => HARNESS_ORIGIN + "/" + p + "?t=" + Date.now(),
    sendMessage: async (m) => {
      console.log("[harness] message", m);
      // Stand-in for the background worker's code fetcher (src/code-fetch.js).
      if (m && m.type === "fetch-code") return resolveCode(m.url, location.href);
    },
  };
  chrome.storage = {
    sync: {
      get: async (keys) => {
        const out = {};
        for (const k of [].concat(keys)) if (k in mem) out[k] = mem[k];
        return out;
      },
      set: async (obj) => Object.assign(mem, obj),
    },
  };
  const localMem = {};
  chrome.storage.local = {
    get: async (keys) => {
      const out = {};
      for (const k of [].concat(keys)) if (k in localMem) out[k] = structuredClone(localMem[k]);
      return out;
    },
    set: async (obj) => Object.assign(localMem, structuredClone(obj)),
  };
  window.__harnessLocal = localMem;

  // ?mockai=available | downloadable | unavailable  → fake Chrome's Summarizer API for testing.
  const mock = new URLSearchParams(location.search).get("mockai");
  if (mock === "missing") {
    // Simulate a Chromium browser without the API (e.g. Dia).
    delete window.Summarizer;
    window.Summarizer = undefined;
  } else if (mock) {
    let status = mock;
    window.Summarizer = {
      availability: async () => status,
      create: async ({ monitor } = {}) => {
        if (status === "downloadable") {
          const target = new EventTarget();
          monitor && monitor(target);
          for (const p of [0.25, 0.6, 1]) {
            await new Promise((r) => setTimeout(r, 150));
            const ev = new Event("downloadprogress");
            ev.loaded = p;
            target.dispatchEvent(ev);
          }
          status = "available";
        }
        return {
          inputQuota: 4000,
          measureInputUsage: async (t) => Math.ceil(t.length / 4),
          async *summarizeStreaming(input) {
            window.__mockInputLength = input.length;
            for (const part of ["[Mock on-device summary] ", "The article explains its main point ", "in a few short sentences."]) {
              await new Promise((r) => setTimeout(r, 80));
              yield part;
            }
          },
          destroy() {},
        };
      },
    };
  }

  const load = (src) =>
    new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src + "?t=" + Date.now();
      s.onload = res;
      s.onerror = rej;
      document.head.append(s);
    });

  await load(HARNESS_ORIGIN + "/vendor/Readability-readerable.js");
  await load(HARNESS_ORIGIN + "/vendor/Readability.js");
  await load(HARNESS_ORIGIN + "/src/code-fetch.js");
  await load(HARNESS_ORIGIN + "/src/reader.js");

  window.__readerable = isProbablyReaderable(document, { minContentLength: 140, minScore: 20 });
  console.log("[harness] isProbablyReaderable:", window.__readerable);

  const btn = document.createElement("button");
  btn.textContent = "Toggle Reader (harness)";
  btn.style.cssText = "position:fixed;top:8px;right:8px;z-index:10;padding:8px 12px";
  btn.onclick = () => window.__readerView.toggle();
  document.body.append(btn);
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && e.code === "KeyR") window.__readerView.toggle();
  });
})();
