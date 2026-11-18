// Reader overlay. Injected on demand (after vendor/Readability.js) and exposes
// window.__readerView = { open, close, toggle }. Re-injection is a no-op.
(() => {
  if (window.__readerView) return;

  // Zoom levels like Safari's (Ctrl/Cmd +/- step through these). 100% = 18px text.
  const ZOOMS = [50, 65, 75, 85, 100, 115, 125, 150, 175, 200, 250, 300];
  const BASE_SIZE = 18;
  const SIDEBAR_MIN_WIDTH = 1000; // below this the contents panel overlays the article

  const THEMES = [
    { id: "white", label: "White" },
    { id: "sepia", label: "Sepia" },
    { id: "gray", label: "Gray" },
    { id: "night", label: "Night" },
  ];

  // Each font falls back to a close Windows/Linux equivalent when the Mac font isn't installed.
  const FONTS = [
    { id: "athelas", label: "Athelas", stack: 'Athelas, Cambria, Georgia, serif' },
    { id: "charter", label: "Charter", stack: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif' },
    { id: "georgia", label: "Georgia", stack: "Georgia, serif" },
    { id: "iowan", label: "Iowan", stack: '"Iowan Old Style", "Sitka Text", "Palatino Linotype", Palatino, serif' },
    { id: "palatino", label: "Palatino", stack: 'Palatino, "Palatino Linotype", "Book Antiqua", serif' },
    { id: "system", label: "San Francisco", stack: '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif' },
    { id: "seravek", label: "Seravek", stack: 'Seravek, "Gill Sans Nova", "Gill Sans", Calibri, "Segoe UI", sans-serif' },
    { id: "times", label: "Times New Roman", stack: '"Times New Roman", Times, serif' },
  ];

  const DEFAULTS = { theme: "white", font: "system", zoom: 100, sidebar: true };
  const SETTING_KEYS = Object.keys(DEFAULTS);
  const HOST_ID = "__reader-view-host";
  const PRINT_STYLE_ID = "__reader-view-print";

  let settings = { ...DEFAULTS };
  let sheetPromise = null;
  let ui = null; // set while Reader is open

  // ---------- helpers ----------

  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  };

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

  function loadStylesheet() {
    if (!sheetPromise) {
      // Asked from the background worker, so the file needn't be visible to websites
      // (which could otherwise use it to detect the extension). The test harness has no
      // worker and loads the file directly.
      sheetPromise = chrome.runtime
        .sendMessage({ type: "get-css" })
        .catch(() => null)
        .then((css) => (typeof css === "string" ? css : fetch(chrome.runtime.getURL("src/reader.css")).then((r) => r.text())))
        .then((css) => {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(css);
          return sheet;
        });
    }
    return sheetPromise;
  }

  async function loadSettings() {
    try {
      const s = await chrome.storage.sync.get(SETTING_KEYS);
      settings = { ...DEFAULTS, ...s };
      if (!ZOOMS.includes(settings.zoom)) settings.zoom = 100;
    } catch {}
  }

  // Browser sync allows only ~120 writes a minute, so holding Ctrl+= mustn't write each step.
  let saveTimer = null;
  let lastSaved = "";
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const out = {};
      for (const k of SETTING_KEYS) out[k] = settings[k];
      const json = JSON.stringify(out);
      if (json === lastSaved) return;
      lastSaved = json;
      try {
        chrome.storage.sync.set(out).catch((err) => console.warn("Reader: could not save settings", err));
      } catch {}
    }, 400);
  }

  async function getAutoHosts() {
    try {
      return (await chrome.storage.sync.get("autoHosts")).autoHosts || [];
    } catch {
      return [];
    }
  }

  async function setAutoHost(host, on) {
    const hosts = new Set(await getAutoHosts());
    on ? hosts.add(host) : hosts.delete(host);
    try {
      await chrome.storage.sync.set({ autoHosts: [...hosts] });
    } catch {}
  }

  function notifyState(active) {
    try {
      chrome.runtime.sendMessage({ type: "reader-state", active }).catch(() => {});
    } catch {}
  }

  // ---------- article extraction ----------

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "BR", "WBR", "SOURCE", "TRACK"]);

  // Readability decides visibility from inline styles and hidden/aria-hidden attributes only.
  // Paywalled pages often mark the full body hidden that way and an unlocker (e.g. a paywall
  // bypass extension) then reveals it with CSS, so Readability would drop text the user can see.
  // Walk the live page and its clone in lockstep and make the clone match what's on screen.
  function prepareClone() {
    const clone = document.cloneNode(true);
    if (!document.body || !clone.body) return clone;

    const liveWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    const copyWalker = clone.createTreeWalker(clone.body, NodeFilter.SHOW_ELEMENT);
    const toRemove = [];
    const asidesToDiv = [];
    const codeBlocks = [];
    let live = liveWalker.currentNode;
    let copy = copyWalker.currentNode;

    while (live && copy) {
      if (live.tagName !== copy.tagName) break; // structures diverged; stop adjusting
      if (!SKIP_TAGS.has(live.tagName) && live.id !== HOST_ID && live.style) {
        const cs = getComputedStyle(live);
        const hidden = cs.display === "none" || cs.visibility === "hidden";
        if (hidden) {
          // Small hidden bits (menus, ad labels, modal text, duplicate mobile images) are noise.
          const textLen = (live.textContent || "").trim().length;
          // Never drop images: lazy-loaders sometimes hide them until they scroll into view.
          const hasMedia = /^(IMG|PICTURE|VIDEO|FIGURE)$/.test(live.tagName) || live.querySelector("img, picture, video");
          if (textLen < 300 && !hasMedia && !live.querySelector("p")) toRemove.push(copy);
          // An X/Bluesky post's original quote, hidden once the real embed has loaded.
          else if (live.matches("blockquote.twitter-tweet, blockquote.bluesky-embed")) toRemove.push(copy);
        } else {
          // Remember how tall embedded posts are on the page, so Reader can size them the same.
          if (live.tagName === "IFRAME") {
            const h = Math.round(live.getBoundingClientRect().height);
            if (h > 0) copy.setAttribute("data-rv-height", String(h));
            // Medium's embed frames: read the Gist or video they show (same site, so readable).
            const inner = codeSource(live.getAttribute("src") || "", location.href) ? framedContent(live) : null;
            if (inner && inner.files) codeBlocks.push([copy, inner.files]);
            else if (inner && inner.src) copy.setAttribute("src", inner.src);
          } else if (live.tagName === "PRE" && !live.parentElement.closest("pre, .gist")) {
            // Code as the reader sees it, without highlighting markup or line numbers.
            if (live.closest(".linenos, .gutter, .rouge-gutter, .linenodiv")) toRemove.push(copy);
            else codeBlocks.push([copy, liveCodeText(live), codeLang(live)]);
          } else if (live.classList.contains("gist") && live.querySelector(".gist-file")) {
            codeBlocks.push([copy, gistFiles(live)]); // a Gist the page rendered with GitHub's script
          }
          // Readability always deletes <aside>. Some sites (e.g. Business Daily) wrap each
          // body paragraph in an <aside>; keep visible ones that are plainly article text.
          if (live.tagName === "ASIDE" && looksLikeBodyText(live)) asidesToDiv.push(copy);
          // Author headshots, icons and logos: small on screen, never article photos.
          if (live.tagName === "IMG") {
            const r = live.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && r.width < 120 && r.height < 120) toRemove.push(copy);
          }
          // Visible on screen, so make sure Readability doesn't treat it as hidden.
          copy.removeAttribute("hidden");
          if (copy.getAttribute("aria-hidden") === "true") copy.removeAttribute("aria-hidden");
          if (copy.style.display === "none") copy.style.removeProperty("display");
          if (copy.style.visibility === "hidden") copy.style.removeProperty("visibility");
        }
      }
      live = liveWalker.nextNode();
      copy = copyWalker.nextNode();
    }
    for (const n of toRemove) n.remove();
    for (const [copy, code, lang] of codeBlocks) {
      if (!copy.parentNode) continue;
      if (Array.isArray(code)) {
        if (code.length) replaceWrapped(clone, copy, ...code.map((f) => makeCode(clone, f)));
      } else setCode(clone, copy, code, lang);
    }
    for (const aside of asidesToDiv) {
      if (!aside.parentNode) continue;
      const div = clone.createElement("div");
      for (const a of aside.attributes) div.setAttribute(a.name, a.value);
      div.append(...aside.childNodes);
      aside.replaceWith(div);
    }
    normalizePullQuotes(clone);
    normalizeCode(clone, location.href);
    normalizeEmbeds(clone, location.href);
    protectArticleAncestors(clone);
    return clone;
  }

  // An <aside> that is really article text: paragraphs with few links, sitting among other
  // paragraphs of the article rather than in a sidebar.
  function looksLikeBodyText(aside) {
    const text = (aside.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length < 40 || !aside.querySelector("p")) return false;
    const linkText = [...aside.querySelectorAll("a")].reduce((n, a) => n + a.textContent.trim().length, 0);
    if (linkText / text.length > 0.3) return false;
    if (aside.querySelector("img, picture, video, iframe, form, ul, ol, nav")) return false;
    const parent = aside.parentElement;
    if (!parent) return false;
    // Siblings must also carry paragraph text (it's interleaved with the article body).
    let siblingParas = 0;
    for (const s of parent.children) {
      if (s !== aside && s.querySelector && (s.tagName === "P" || s.querySelector(":scope > p, p")) && s.textContent.trim().length > 60) siblingParas++;
    }
    return siblingParas >= 2;
  }

  // Readability discards or down-weights elements whose class/id contains words like "header",
  // "sidebar", "hidden" or "share". Utility-class sites (Tailwind etc.) trip this constantly,
  // e.g. Time wraps the whole article in "... group/header-newsletter", so Readability throws
  // the article away. Strip those words from the elements that actually hold the body text.
  const MISLEADING =
    /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote|hidden|^hid$|masthead|media|meta|outbrain|promo|scroll|share|shopping|tags|widget|contact|com-/i;
  const MISLEADING_ROLES = new Set(["menu", "menubar", "complementary", "navigation", "alert", "alertdialog", "dialog"]);

  function protectArticleAncestors(doc) {
    if (!doc.body) return;
    const paras = [...doc.body.querySelectorAll("p")]
      .map((p) => [p, (p.textContent || "").trim().length])
      .filter(([, n]) => n > 80);
    const total = paras.reduce((s, [, n]) => s + n, 0);
    if (total < 500) return;

    const share = new Map();
    for (const [p, n] of paras) {
      for (let e = p.parentElement; e && e !== doc.body; e = e.parentElement) share.set(e, (share.get(e) || 0) + n);
    }
    for (const [e, n] of share) {
      if (n < total * 0.3) continue;
      const cls = e.getAttribute("class");
      if (cls) e.setAttribute("class", cls.split(/\s+/).filter((t) => t && !MISLEADING.test(t)).join(" "));
      if (e.id && MISLEADING.test(e.id)) e.removeAttribute("id");
      if (MISLEADING_ROLES.has(e.getAttribute("role"))) e.removeAttribute("role");
    }
    protectInlineBlocks(doc, new Set(paras.map(([p]) => p)));
  }

  // Section headings and photos that sit between the article's paragraphs, e.g. CNN's
  // <h2 class="subheader"> ("header") and photo captions in "media__metadata" ("media",
  // "meta"). Readability deletes those as page furniture; clear the misleading words so they
  // stay. Blocks that really are clutter (related stories, promos, sign-ups) are left alone.
  const INLINE_JUNK =
    /related|promo|newsletter|sponsor|outbrain|taboola|recommend|advert|(^|[-_])ads?([-_]|$)|share|social|subscribe|signup|sign-up|teaser|more-from|read-more|most-popular|trending/i;

  function protectInlineBlocks(doc, bodyParas) {
    const isBodyBlock = (n) => {
      if (!n) return false;
      if (bodyParas.has(n)) return true;
      // A wrapper holding one or two article paragraphs (The Verge wraps each one).
      return n.children.length <= 2 && [...n.querySelectorAll("p")].some((p) => bodyParas.has(p));
    };
    const looksLikeJunk = (e) =>
      [e, ...e.querySelectorAll("[class], [id]")].some((x) => INLINE_JUNK.test(`${x.getAttribute("class") || ""} ${x.id || ""}`));

    for (const item of [...doc.body.querySelectorAll("h2, h3, h4, img, picture")]) {
      // Climb to the block that sits next to the article's paragraphs.
      let block = item;
      let found = false;
      for (let i = 0; i < 6 && block && block.parentElement && block !== doc.body; i++) {
        if (isBodyBlock(block.previousElementSibling) || isBodyBlock(block.nextElementSibling)) {
          found = true;
          break;
        }
        block = block.parentElement;
      }
      if (!found || bodyParas.has(block) || block.tagName === "P") continue;
      const text = norm(block.textContent);
      if (text.length > 600 || looksLikeJunk(block)) continue;
      // A heading that's just a link is usually a "related story" teaser.
      if (/^H[2-4]$/.test(item.tagName) && item.querySelector("a") && norm(item.querySelector("a").textContent) === norm(item.textContent)) continue;
      for (const e of [block, ...block.querySelectorAll("*")]) stripMisleading(e);
      if (item.tagName === "IMG" || item.tagName === "PICTURE") toFigure(doc, block);
    }
  }

  // A photo block with its caption and credit in separate <div>s (CNN and many others) comes
  // out of Readability as a photo, a body-text paragraph and a stray credit. Rebuild it as a
  // <figure> so Reader shows the caption under the photo.
  function toFigure(doc, block) {
    if (block.tagName === "FIGURE" || !block.parentNode || block.querySelectorAll("img").length !== 1) return;
    const sel = '[itemprop="caption"], [itemprop="copyrightHolder"], [class*="caption" i], [class*="credit" i], figcaption';
    const parts = [...block.querySelectorAll(sel)].filter((e) => !e.querySelector("img"));
    const outer = parts.filter((e) => !parts.some((o) => o !== e && o.contains(e)));
    if (!outer.length) return;
    const media = block.querySelector("picture") || block.querySelector("img");
    const fig = doc.createElement("figure");
    const cap = doc.createElement("figcaption");
    const seen = new Set();
    for (const e of outer) {
      const t = e.textContent.replace(/\s+/g, " ").trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      const credit = /credit|copyright/i.test(`${e.getAttribute("class") || ""} ${e.getAttribute("itemprop") || ""}`) ||
        (e.tagName === "FIGCAPTION" && outer.length > 1 && t.length < 90);
      if (cap.childNodes.length) cap.append(" ");
      if (credit) {
        const s = doc.createElement("span");
        s.setAttribute("data-rv-credit", "");
        s.textContent = t;
        cap.append(s);
      } else cap.append(t);
    }
    fig.append(media);
    if (cap.childNodes.length) fig.append(cap);
    block.replaceWith(fig);
  }

  function stripMisleading(e) {
    const cls = e.getAttribute("class");
    if (cls) e.setAttribute("class", cls.split(/\s+/).filter((t) => t && !MISLEADING.test(t)).join(" "));
    if (e.id && MISLEADING.test(e.id)) e.removeAttribute("id");
  }

  // ---------- embedded videos and posts ----------
  // Like Safari, keep YouTube/Vimeo videos and X/Bluesky posts in the article. Readability
  // drops most iframes and strips the classes that mark posts, so we turn every embed into a
  // plain iframe tagged with data-rv-embed (data attributes survive Readability) beforehand.
  const EMBED_RE =
    /^https?:\/\/((www\.)?(youtube(-nocookie)?\.com\/embed\/|dailymotion\.com\/embed\/|archive\.org\/embed\/)|player\.vimeo\.com\/video\/|platform\.(twitter|x)\.com\/embed\/|embed\.bsky\.app\/embed\/|player\.twitch\.tv\/|upload\.wikimedia\.org\/)/i;

  function embedKind(src) {
    if (!src || !EMBED_RE.test(src)) return "";
    if (/\/\/platform\.(twitter|x)\.com\//i.test(src)) return "x";
    if (/\/\/embed\.bsky\.app\//i.test(src)) return "bluesky";
    return "video";
  }

  function youtubeId(href) {
    const m = /(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/)([\w-]{11})/.exec(href || "");
    return m ? m[1] : "";
  }

  function normalizeEmbeds(doc, base) {
    if (!doc.body) return;
    const abs = (u) => {
      try {
        return new URL(u, base).href;
      } catch {
        return "";
      }
    };
    const makeEmbed = (kind, src, height) => {
      const f = doc.createElement("iframe");
      f.setAttribute("src", src);
      f.setAttribute("data-rv-embed", kind);
      if (height) f.setAttribute("data-rv-height", String(height));
      return f;
    };
    // Replace the embed's whole wrapper (div > div > iframe) so wrapper class names like
    // "social-embed" can't make Readability throw it away.
    const replace = (node, embed) => {
      let target = node;
      for (let i = 0; i < 5; i++) {
        const p = target.parentElement;
        if (!p || p === doc.body || p.children.length !== 1 || norm(p.textContent) !== norm(target.textContent)) break;
        target = p;
      }
      target.replaceWith(embed);
      for (let a = embed.parentElement, i = 0; a && a !== doc.body && i < 3; a = a.parentElement, i++) {
        if (norm(a.textContent).length > 400) break;
        stripMisleading(a);
      }
    };

    // Real embeds, including lazy ones that keep their address in data-src until scrolled to.
    for (const f of [...doc.body.querySelectorAll("iframe")]) {
      const raw = [f.getAttribute("src"), f.getAttribute("data-src"), f.getAttribute("data-lazy-src")].find(
        (s) => s && !/^\s*(about:|javascript:|data:)/i.test(s)
      );
      const src = raw ? abs(raw) : "";
      const kind = embedKind(src);
      if (kind) replace(f, makeEmbed(kind, src, f.getAttribute("data-rv-height")));
    }

    // Bluesky posts the page hasn't loaded yet: build the embed from the post's address.
    for (const q of [...doc.body.querySelectorAll("blockquote.bluesky-embed[data-bluesky-uri]")]) {
      const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)/.exec(q.getAttribute("data-bluesky-uri"));
      if (!m) continue;
      const id = "rv" + Math.random().toString(36).slice(2, 10);
      replace(q, makeEmbed("bluesky", `https://embed.bsky.app/embed/${m[1]}/app.bsky.feed.post/${m[2]}?id=${id}`));
    }

    // X posts the page hasn't turned into an embed yet: keep the post's own text as a card.
    for (const q of [...doc.body.querySelectorAll("blockquote.twitter-tweet, blockquote.twitter-video")]) {
      if (!q.parentNode) continue;
      const card = doc.createElement("blockquote");
      card.setAttribute("data-rv-embed", "post-card");
      card.append(...q.childNodes);
      replace(q, card);
    }

    // YouTube "click to play" placeholders (a thumbnail standing in for the player).
    const facades = doc.body.querySelectorAll(
      "lite-youtube[videoid], [data-youtube-id], [data-youtube-video-id], a[href*='youtube.com/watch'], a[href*='youtu.be/']"
    );
    for (const n of [...facades]) {
      if (!n.parentNode || !doc.body.contains(n)) continue;
      let id = n.getAttribute("videoid") || n.getAttribute("data-youtube-id") || n.getAttribute("data-youtube-video-id");
      if (!id && n.tagName === "A") {
        if (!n.querySelector("img, picture") || norm(n.textContent).length > 80) continue; // a plain link, not a player
        id = youtubeId(abs(n.getAttribute("href")));
      }
      if (/^[\w-]{11}$/.test(id || "")) replace(n, makeEmbed("video", `https://www.youtube.com/embed/${id}`));
    }
  }

  // After extraction: make the kept embeds behave (sizes, fullscreen) and drop any other iframe.
  function finishEmbeds(frag) {
    for (const f of [...frag.querySelectorAll("iframe")]) {
      const kind = embedKind(f.getAttribute("src"));
      if (!kind) {
        f.remove();
        continue;
      }
      f.setAttribute("data-rv-embed", kind);
      f.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write");
      f.setAttribute("allowfullscreen", "");
      f.setAttribute("loading", "lazy");
      f.setAttribute("title", kind === "video" ? "Embedded video" : kind === "x" ? "Post on X" : "Post on Bluesky");
      for (const a of ["width", "height", "style", "frameborder", "scrolling", "srcdoc", "name"]) f.removeAttribute(a);
      if (kind !== "video") {
        // Posts size themselves via postMessage once loaded; start from the size on the page.
        const h = parseInt(f.getAttribute("data-rv-height"), 10);
        f.style.height = (h > 80 ? h : kind === "x" ? 480 : 380) + "px";
        f.setAttribute("scrolling", "no");
      }
    }
  }

  // X and Bluesky embeds report their rendered height to the page that holds them.
  function onEmbedMessage(e) {
    if (!ui || !/^https:\/\/(platform\.(twitter|x)\.com|embed\.bsky\.app)$/.test(e.origin)) return;
    const frame = [...ui.content.querySelectorAll('iframe[data-rv-embed="x"], iframe[data-rv-embed="bluesky"]')].find(
      (f) => f.contentWindow === e.source
    );
    if (!frame) return;
    let d = e.data;
    if (typeof d === "string") {
      try {
        d = JSON.parse(d);
      } catch {
        return;
      }
    }
    const tw = d && d["twttr.embed"];
    const h = tw ? tw.method === "twttr.private.resize" && tw.params && tw.params[0] && tw.params[0].height : d && d.height;
    if (h > 50 && h < 4000) frame.style.height = Math.ceil(h) + "px";
  }

  // ---------- pull quotes ----------
  // A line lifted from the article and set large on the page ("Refresh rates matter!").
  // Readability strips the class that marks it, leaving what looks like a stray one-line
  // paragraph. Turn it into a blockquote tagged for Reader's pull-quote style.
  function normalizePullQuotes(doc) {
    if (!doc.body) return;
    const sel = '[class*="pullquote" i], [class*="pull-quote" i], [class*="pull_quote" i]';
    for (const q of [...doc.body.querySelectorAll(sel)]) {
      if (!doc.body.contains(q)) continue; // inside a pull quote already converted
      const text = norm(q.textContent);
      if (!text || text.length > 400 || q.querySelector("img, picture, video, iframe, h1, h2")) continue;
      // Quote text, and the person quoted if the site names them (<cite>, WordPress style).
      const cite = q.querySelector("cite, figcaption, [class*='attribution' i], [class*='credit' i]");
      const citeText = cite ? cite.textContent.replace(/\s+/g, " ").trim() : "";
      if (cite) cite.remove();
      const quoteText = q.textContent.replace(/\s+/g, " ").trim();
      if (!quoteText) continue;
      const bq = doc.createElement("blockquote");
      bq.setAttribute("data-rv-pull", "");
      const p = doc.createElement("p");
      p.textContent = quoteText;
      bq.append(p);
      if (citeText) {
        const a = doc.createElement("p");
        a.setAttribute("data-rv-attribution", "");
        a.textContent = /^[—–-]/.test(citeText) ? citeText : "— " + citeText;
        bq.append(a);
      }
      q.replaceWith(bq);
    }
  }

  // ---------- code: GitHub Gists and code blocks ----------
  // Articles (Medium especially) show code as GitHub Gists, which Readability drops because
  // they're scripts or iframes. Turn them into plain code blocks, and clean up the site's own
  // code blocks (line breaks, line numbers, highlighting markup) so they copy cleanly.
  const GUTTER_SEL = ".gutter, .linenos, .lineno, .line-numbers-rows, .rouge-gutter, .hljs-ln-numbers, .blob-num";
  const LANG_NAMES = {
    js: "JavaScript", javascript: "JavaScript", jsx: "JSX", mjs: "JavaScript", ts: "TypeScript", typescript: "TypeScript",
    tsx: "TSX", py: "Python", python: "Python", python3: "Python", rb: "Ruby", ruby: "Ruby", sh: "Shell", shell: "Shell",
    bash: "Bash", zsh: "Shell", console: "Terminal", ps1: "PowerShell", powershell: "PowerShell", cs: "C#", csharp: "C#",
    cpp: "C++", "c++": "C++", c: "C", go: "Go", golang: "Go", rs: "Rust", rust: "Rust", java: "Java", kt: "Kotlin",
    kotlin: "Kotlin", swift: "Swift", php: "PHP", html: "HTML", xml: "XML", css: "CSS", scss: "SCSS", json: "JSON",
    yaml: "YAML", yml: "YAML", toml: "TOML", sql: "SQL", md: "Markdown", markdown: "Markdown", dockerfile: "Dockerfile",
    r: "R", scala: "Scala", dart: "Dart", lua: "Lua", diff: "Diff", graphql: "GraphQL", objectivec: "Objective-C",
    text: "", plaintext: "", plain: "", txt: "", none: "", nohighlight: "", undefined: "",
  };

  function langName(lang) {
    const key = (lang || "").trim().toLowerCase();
    if (key in LANG_NAMES) return LANG_NAMES[key];
    return key ? key[0].toUpperCase() + key.slice(1) : "";
  }

  // The code's language, from the markup highlighters and Medium leave on the block.
  function codeLang(pre) {
    const nodes = [pre, pre.querySelector("code, [data-code-block-lang], [data-lang], [data-language]")];
    // Wrappers carry it too (Sphinx: div.highlight-bash > table > … > pre).
    for (let a = pre.parentElement, i = 0; a && i < 7; a = a.parentElement, i++) nodes.push(a);
    for (const [i, n] of nodes.entries()) {
      if (!n || !n.getAttribute) continue;
      // Wrappers' "lang-en"/data-lang often mean the page's human language, so they only
      // count with highlighter-style names.
      const own = i < 2;
      const v = own && (n.getAttribute("data-code-block-lang") || n.getAttribute("data-lang") || n.getAttribute("data-language"));
      if (v) return v;
      const re = own ? /(?:^|\s)(?:language|lang|highlight-source|highlight)-([\w+#-]+)/i : /(?:^|\s)(?:highlight-source|highlight)-([\w+#-]+)/i;
      const m = re.exec(n.getAttribute("class") || "");
      if (m) return m[1];
    }
    return "";
  }

  // Code text of a block that isn't on screen: <br> means a new line; skip line numbers.
  function codeText(pre) {
    const c = pre.cloneNode(true);
    c.querySelectorAll(GUTTER_SEL).forEach((n) => n.remove());
    c.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    const rows = c.querySelectorAll("tr");
    if (rows.length) return [...rows].map((tr) => (tr.querySelector("td:last-child") || tr).textContent.replace(/\n$/, "")).join("\n");
    return c.textContent;
  }

  // Code as shown on screen (keeps line breaks that only exist in the site's styling).
  function liveCodeText(pre) {
    if (pre.querySelector(GUTTER_SEL + ", tr")) return codeText(pre);
    const t = pre.innerText;
    return t && t.trim() ? t : codeText(pre);
  }

  // Files of a rendered Gist (live on the page, or from GitHub's embed HTML).
  function gistFiles(root) {
    return [...root.querySelectorAll(".gist-file")].map((f) => {
      const lines = [...f.querySelectorAll("td.blob-code")].map((td) => td.textContent.replace(/\n$/, ""));
      const raw = f.querySelector(".gist-meta a[href*='/raw/']");
      let name = "";
      try {
        name = raw ? decodeURIComponent(new URL(raw.getAttribute("href"), "https://gist.github.com/").pathname.split("/").pop()) : "";
      } catch {}
      const typed = f.querySelector("[class*='type-']");
      const lang = typed ? /\btype-([\w+#-]+)/.exec(typed.className) : null;
      const body = f.querySelector(".blob-wrapper") || f.querySelector(".gist-data") || f;
      return { name, lang: lang ? lang[1] : "", code: lines.length ? lines.join("\n") : body.textContent.trim() };
    });
  }

  function makeCode(doc, { code, lang, name }) {
    const pre = doc.createElement("pre");
    pre.setAttribute("data-rv-code", "");
    if (lang) pre.setAttribute("data-rv-lang", lang);
    if (name) pre.setAttribute("data-rv-file", name);
    const c = doc.createElement("code");
    c.textContent = code;
    pre.append(c);
    return pre;
  }

  // A block whose code must be fetched (a Gist or Medium embed the page hasn't loaded).
  function makeCodePlaceholder(doc, src) {
    const pre = doc.createElement("pre");
    pre.setAttribute("data-rv-code", "");
    pre.setAttribute("data-rv-src", src);
    pre.textContent = "Loading…";
    return pre;
  }

  // Replace an embed's single-child wrappers too, and keep wrapper class names like "embed"
  // from making Readability throw the result away.
  function replaceWrapped(doc, node, ...nodes) {
    let target = node;
    for (let i = 0; i < 5; i++) {
      const p = target.parentElement;
      if (!p || p === doc.body || p.children.length !== 1 || norm(p.textContent) !== norm(target.textContent)) break;
      target = p;
    }
    target.replaceWith(...nodes);
    for (let a = nodes[0] && nodes[0].parentElement, i = 0; a && a !== doc.body && i < 3; a = a.parentElement, i++) {
      if (norm(a.textContent).length > 1500) break;
      stripMisleading(a);
    }
  }

  // An iframe or script that stands for code: a Gist, or Medium's /media/ embed pages
  // (on the article's own site or medium.com).
  function codeSource(raw, base) {
    let u, b;
    try {
      u = new URL(raw, base);
      b = new URL(base);
    } catch {
      return "";
    }
    if (u.hostname === "gist.github.com" && /\/[0-9a-f]{7,40}/i.test(u.pathname)) return u.href;
    if ((u.origin === b.origin || u.hostname === "medium.com") && /\/media\/[0-9a-f]{16,}/i.test(u.pathname)) return u.href;
    return "";
  }

  // What a same-site embed frame shows: a rendered Gist, or a video (often via Embedly).
  function framedContent(frame) {
    let d = null;
    try {
      d = frame.contentDocument;
    } catch {}
    if (!d || !d.body) return null;
    if (d.querySelector(".gist-file")) return { files: gistFiles(d) };
    for (const f of d.querySelectorAll("iframe[src]")) {
      let src = f.src;
      try {
        const u = new URL(src);
        if (u.hostname === "cdn.embedly.com") src = u.searchParams.get("src") || "";
      } catch {}
      if (embedKind(src)) return { src };
    }
    return null;
  }

  // Before Readability: code blocks the live-page pass (prepareClone) didn't already handle,
  // and Gists/Medium embeds that haven't loaded. Also used for later pages of an article.
  function normalizeCode(doc, base) {
    if (!doc.body) return;
    for (const pre of [...doc.body.querySelectorAll("pre:not([data-rv-code])")]) {
      if (!pre.parentNode || pre.parentElement.closest("pre")) continue;
      if (pre.closest(".linenos, .gutter, .rouge-gutter, .linenodiv")) {
        pre.remove(); // a column of line numbers next to the code
        continue;
      }
      setCode(doc, pre, codeText(pre), codeLang(pre));
    }
    for (const f of [...doc.body.querySelectorAll("iframe")]) {
      const raw = [f.getAttribute("src"), f.getAttribute("data-src"), f.getAttribute("data-lazy-src")].find(Boolean);
      const src = raw ? codeSource(raw, base) : "";
      if (src) replaceWrapped(doc, f, makeCodePlaceholder(doc, src));
    }
    // Gist scripts the page didn't run (when it did, the rendered Gist was already turned
    // into code and sits right after the script).
    for (const s of [...doc.querySelectorAll("script[src*='gist.github.com']")]) {
      const src = codeSource(s.getAttribute("src"), base);
      if (!src || !doc.body.contains(s)) continue;
      let n = s.nextElementSibling;
      while (n && n.tagName === "LINK") n = n.nextElementSibling;
      if (n && n.matches(".gist, pre[data-rv-code]")) s.remove();
      else replaceWrapped(doc, s, makeCodePlaceholder(doc, src.replace(/\.js(\?|$)/, "$1")));
    }
  }

  // Make a <pre> hold just its code as plain text, tagged so later steps know it's done.
  function setCode(doc, pre, code, lang) {
    for (const a of [...pre.attributes]) if (!/^data-/.test(a.name)) pre.removeAttribute(a.name);
    if (lang) pre.setAttribute("data-rv-lang", lang);
    pre.setAttribute("data-rv-code", "");
    const c = doc.createElement("code");
    c.textContent = code;
    pre.replaceChildren(c);
  }

  // After extraction: each code block gets a small header (language or file name) and a
  // Copy button; code that has to be fetched starts loading.
  function finishCode(frag) {
    const doc = frag.ownerDocument || document;
    for (const pre of [...frag.querySelectorAll("pre")]) {
      if (!pre.parentNode || pre.closest(".code-block") || (pre.parentElement && pre.parentElement.closest("pre"))) continue;
      if (!pre.hasAttribute("data-rv-code")) setCode(doc, pre, codeText(pre), codeLang(pre));
      const block = wrapCode(doc, pre);
      const src = pre.getAttribute("data-rv-src");
      if (src) loadRemoteCode(block, src);
    }
  }

  function wrapCode(doc, pre) {
    const code = pre.querySelector("code") || pre;
    code.textContent = code.textContent.replace(/^\s*\n/, "").replace(/\s+$/, "");
    const file = pre.getAttribute("data-rv-file") || "";
    const label = el("span", { class: "code-label" }, file || langName(pre.getAttribute("data-rv-lang")));
    const copy = el("button", { type: "button", class: "code-copy", "aria-label": "Copy code" }, "Copy");
    if (pre.hasAttribute("data-rv-src")) copy.hidden = true;
    const block = doc.createElement("div");
    block.className = "code-block";
    pre.replaceWith(block);
    block.append(el("div", { class: "code-head" }, [label, copy]), pre);
    return block;
  }

  async function loadRemoteCode(block, src) {
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: "fetch-code", url: src });
    } catch {}
    if (!block.parentNode) return;
    let replacement = [];
    if (res && res.embed) {
      const holder = document.createElement("div");
      holder.append(el("iframe", { src: res.embed, "data-rv-embed": "video" }));
      finishEmbeds(holder);
      replacement = [...holder.childNodes];
    } else if (res && res.gist) {
      let files = res.gist.files;
      if (!files && res.gist.html) {
        const t = document.createElement("template");
        t.innerHTML = res.gist.html;
        files = gistFiles(t.content);
      }
      if (files && files.length) {
        replacement = files.map((file) => {
          const holder = document.createElement("div");
          holder.append(makeCode(document, file));
          return wrapCode(document, holder.firstChild);
        });
      } else {
        // GitHub didn't answer (e.g. too many requests): link to the code instead.
        replacement = [el("p", {}, el("a", { href: res.gist.url }, "View this code on GitHub"))];
      }
    }
    if (replacement.length) block.replaceWith(...replacement);
    else block.remove();
    // Lets the reading-position restore re-anchor now that the text above has moved
    // (capture listeners on the content see it even though "load" doesn't bubble).
    const first = replacement[0];
    if (first && first.isConnected) first.dispatchEvent(new Event("load"));
  }

  async function copyCode(button) {
    const pre = button.closest(".code-block").querySelector("pre");
    const text = pre ? pre.textContent : "";
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // The page may block the clipboard API; fall back to a hidden text box.
      const ta = el("textarea", { readonly: "", style: "position:fixed;top:0;left:0;opacity:0" });
      ta.value = text;
      button.getRootNode().append(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {}
      ta.remove();
      button.focus();
    }
    button.textContent = ok ? "Copied" : "Couldn’t copy";
    clearTimeout(button._rvTimer);
    button._rvTimer = setTimeout(() => (button.textContent = "Copy"), 1600);
  }

  // Many news sites embed the full article text as structured data (schema.org articleBody).
  // Only used when the site doesn't mark the article as paid: Reader shows what the reader
  // can already see, it doesn't unlock paywalls.
  function structuredArticleBody() {
    let best = "";
    const paid = (o) => o.isAccessibleForFree === false || /^false$/i.test(String(o.isAccessibleForFree ?? ""));
    const visit = (o) => {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) return o.forEach(visit);
      if (paid(o)) return;
      if (typeof o.articleBody === "string" && o.articleBody.length > best.length) best = o.articleBody;
      if (o["@graph"]) visit(o["@graph"]);
      if (o.mainEntity) visit(o.mainEntity);
      if (o.hasPart) visit(o.hasPart);
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        visit(JSON.parse(s.textContent));
      } catch {}
    });
    return best.trim();
  }

  function paragraphsFromText(text) {
    const frag = document.createDocumentFragment();
    let blocks = text.split(/\n\s*\n|\r?\n/).map((s) => s.trim()).filter(Boolean);
    // One giant blob: split into paragraphs of ~4 sentences.
    if (blocks.length === 1 && blocks[0].length > 1200) {
      const sentences = blocks[0].match(/[^.!?]+[.!?]+["”’)]*\s*/g) || [blocks[0]];
      blocks = [];
      for (let i = 0; i < sentences.length; i += 4) blocks.push(sentences.slice(i, i + 4).join("").trim());
    }
    for (const b of blocks) {
      const p = document.createElement("p");
      p.textContent = b;
      frag.append(p);
    }
    return frag;
  }

  // Leftover ad/promo labels that survive extraction ("Ad Feedback", "Advertisement", ...).
  const JUNK_TEXT =
    /^(ad feedback|advertisement|advertisements|advertising|ad|ads|sponsored( content)?|paid content|story continues below( advertisement)?|article continues below( advertisement)?|continue reading( below| the main story)?|skip advertisement|scroll to continue( with content)?|related( articles| stories| content)?:?|read more:?|recommended( for you| stories)?:?|most read|trending( now)?|listen to this article|share( this article)?|copy link|sign up for .{0,60}|subscribe.{0,60}|supported by|prime|premium|exclusive|subscriber only|.{0,50}\b\d+\s*min(ute)?s?\s*read)$/i;

  // A quote paragraph followed by a short "— Name" line is a pull quote: show it as one.
  function markPullQuotes(frag) {
    for (const attr of [...frag.querySelectorAll("p")]) {
      const t = attr.textContent.replace(/\s+/g, " ").trim();
      if (t.length > 160 || !/^[—–]\s?\S/.test(t)) continue;
      const quote = attr.previousElementSibling;
      if (!quote || quote.tagName !== "P" || !/^["“‘]/.test(quote.textContent.trim())) continue;
      if (quote.closest("blockquote")) continue;
      const bq = document.createElement("blockquote");
      bq.className = "pull";
      quote.before(bq);
      bq.append(quote, attr);
      attr.className = "attribution";
    }
  }

  // Longer site boilerplate that sits at the end of articles.
  const SITE_PROMO =
    /^(follow (topics|authors|this author|the author|us)\b|(follow topics and authors )?from this story to see more like this|get the latest .{0,60} (in|to) your inbox|sign up for (our|the) .{0,40}newsletter|this story (was|has been) updated|most popular\b|more from\b|you might also like\b)/i;

  function removeJunk(frag) {
    // Site promos: remove the whole paragraph/block, not just the inner element that matched.
    for (const n of [...frag.querySelectorAll("p, li, div, section, aside")]) {
      if (!n.parentNode || n.querySelector("img, picture, video, iframe, p") || n.closest(".code-block, .procon")) continue;
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length && t.length < 300 && SITE_PROMO.test(t)) n.remove();
    }
    const nodes = [...frag.querySelectorAll("p, div, span, section, aside, h2, h3, h4, h5, h6, li, a, figcaption, button, strong")].reverse();
    for (const n of nodes) {
      if (!n.parentNode || n.closest(".code-block, .procon")) continue;
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (!t.length || n.querySelector("img, picture, video, iframe")) continue;
      if (t.length < 90 && JUNK_TEXT.test(t)) n.remove();
    }
    // Short author-box lines ("Correspondent", "Nation Media Group") above the first paragraph.
    for (const p of [...frag.querySelectorAll("p")]) {
      const len = p.textContent.replace(/\s+/g, " ").trim().length;
      if (len > 100) break;
      if (len < 40 && !p.querySelector("img, picture, a") && !p.closest(".procon")) p.remove();
    }
    // Collapse containers left empty.
    for (const n of [...frag.querySelectorAll("div, section, p, figure, span, li, ul, ol")].reverse()) {
      if (n.parentNode && !n.textContent.trim() && !n.querySelector("img, picture, video, iframe, svg, hr, table") && !n.closest(".code-block, .procon")) n.remove();
    }
    // "Related stories" link lists and "Follow <author>" button lists inside the body.
    for (const list of [...frag.querySelectorAll("ul, ol")]) {
      if (!list.parentNode) continue;
      const t = (list.textContent || "").replace(/\s+/g, " ").trim();
      const linkText = [...list.querySelectorAll("a")].reduce((n, a) => n + a.textContent.replace(/\s+/g, " ").trim().length, 0);
      const buttons = list.querySelectorAll('[role="button"], button').length;
      if (t.length && linkText / t.length > 0.8 && list.children.length <= 8) list.remove();
      else if (buttons && buttons >= list.children.length && t.length < 400) list.remove();
    }
  }

  // Safari shows the article's subtitle ("dek") under the headline. Use the page's description
  // only when the page actually displays it as a subtitle (not just as the first paragraph).
  function findDek(article, frag) {
    return dekFromDescription(article, frag) || dekBelowHeadline(article, frag);
  }

  // Remove the subtitle from the body if Readability also extracted it there.
  function dropFromBody(frag, key) {
    for (const c of frag.querySelectorAll("p, h2, h3, div")) {
      if (norm(c.textContent) === key) {
        c.remove();
        break;
      }
    }
  }

  // The text block shown just under the headline on the page (how most sites lay out a subtitle,
  // e.g. The Verge, whose subtitle differs from its description metadata).
  function dekBelowHeadline(article, frag) {
    const title = norm(article.title);
    // Sites often have a hidden mobile copy of the headline: prefer the visible one.
    const h1s = [...document.querySelectorAll("h1")].filter((h) => !h.closest(`#${HOST_ID}`));
    const visible = (h) => h.getClientRects().length > 0;
    const h1 =
      h1s.find((h) => visible(h) && norm(h.textContent) === title) ||
      h1s.find((h) => norm(h.textContent) === title) ||
      h1s.find(visible) ||
      h1s[0];
    if (!h1) return "";
    const firstP = norm([...frag.querySelectorAll("p")].find((p) => p.textContent.trim().length > 60)?.textContent);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = h1;
    let n;
    let steps = 0;
    while ((n = walker.nextNode()) && steps++ < 60) {
      if (h1.contains(n) || n.closest(`#${HOST_ID}`)) continue;
      if (/^(IMG|PICTURE|VIDEO|FIGURE)$/.test(n.tagName)) break; // reached the lead image
      if (!/^(P|H2|DIV|SPAN)$/.test(n.tagName)) continue;
      // Leaf-like text blocks only (a <p> may contain links/emphasis).
      if (n.tagName !== "P" && n.querySelector("p, div, h2, h3, img, ul, ol")) continue;
      if (!n.getClientRects().length) continue;
      const t = n.textContent.replace(/\s+/g, " ").trim();
      if (t.length < 40) continue;
      if (t.length > 350) break;
      if (/^by\s/i.test(t) || n.querySelector("time")) continue;
      const key = norm(t);
      if (firstP && (firstP === key || firstP.startsWith(key.slice(0, 60)))) break; // that's the body
      dropFromBody(frag, key);
      return t;
    }
    return "";
  }

  function dekFromDescription(article, frag) {
    const ex = (article.excerpt || "").trim();
    if (ex.length < 30 || ex.length > 400) return "";
    // Without description metadata, Readability's excerpt is just the first paragraph, which
    // is often the byline ("By Maya Okafor · November 2"), not a subtitle.
    const hasDescription = document.querySelector(
      'meta[name="description" i][content], meta[property="og:description"][content], meta[name="twitter:description"][content]'
    );
    if (!hasDescription || /^by\s/i.test(ex)) return "";
    const key = norm(ex);
    const firstP = norm(frag.querySelector("p")?.textContent);
    if (firstP && firstP.startsWith(key.slice(0, 50))) return "";
    const sel = 'h2, h3, p, [class*="dek"], [class*="deck"], [class*="subtitle"], [class*="sub-title"], [class*="subhead"], [class*="sub-head"], [class*="standfirst"], [class*="summary"], [class*="description"], [class*="excerpt"], [class*="lede"], [class*="intro"], [class*="strapline"]';
    for (const n of document.body.querySelectorAll(sel)) {
      if (n.closest(`#${HOST_ID}`)) continue;
      const t = n.textContent;
      if (t.length > ex.length * 1.3 + 20) continue;
      if (norm(t) === key) {
        dropFromBody(frag, key);
        return ex;
      }
    }
    return "";
  }

  // Many sites put the main photo in a hero section above the article body, outside the
  // container Readability keeps. Like Safari, bring it back as the lead image.
  function addLeadImage(frag) {
    // Already starts with an image? Keep it.
    const firstBlock = frag.querySelector("img, picture, video, iframe, figure, p, h2, h3, ul, ol, blockquote");
    if (firstBlock && /^(IMG|PICTURE|VIDEO|IFRAME|FIGURE)$/.test(firstBlock.tagName)) return;

    // Locate the article's first paragraph on the live page.
    const firstText = norm([...frag.querySelectorAll("p")].find((p) => p.textContent.trim().length > 60)?.textContent).slice(0, 80);
    let anchor = null;
    if (firstText) {
      for (const p of document.querySelectorAll("p")) {
        if (norm(p.textContent).startsWith(firstText)) {
          anchor = p;
          break;
        }
      }
    }

    const existing = new Set([...frag.querySelectorAll("img")].map((i) => i.src));
    let best = null;
    let bestArea = 0;
    for (const img of document.querySelectorAll("img")) {
      if (img.closest(`#${HOST_ID}, header nav, nav, footer, aside, [role="banner"] a, [role="navigation"]`)) continue;
      // Must come before the article text (hero position).
      if (anchor && !(img.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const r = img.getBoundingClientRect();
      const w = r.width || img.naturalWidth;
      const h = r.height || img.naturalHeight;
      if (w < 400 || h < 200) continue;
      const src = img.currentSrc || img.src;
      // Skip tiny inline placeholders (lazy-load stand-ins); allow real inline images.
      if (!src || existing.has(src) || (src.startsWith("data:") && img.naturalWidth < 400)) continue;
      if (w * h > bestArea) {
        best = img;
        bestArea = w * h;
      }
    }

    let src = best && (best.currentSrc || best.src);
    let alt = best ? best.alt : "";
    let caption = "";
    if (best) {
      const fig = best.closest("figure");
      const cap = fig && (fig.querySelector("figcaption") || [...fig.querySelectorAll("p, span, div")].find((n) => !n.querySelector("img") && n.textContent.trim().length > 20));
      caption = cap ? cap.textContent.replace(/\s+/g, " ").trim() : "";
    } else {
      // Fall back to the page's share image.
      const og = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
      src = og && og.content;
    }
    if (!src) return;

    const fig = document.createElement("figure");
    const img = document.createElement("img");
    try {
      img.src = new URL(src, location.href).href;
    } catch {
      return; // unusable address
    }
    if (!/^(https?:|data:image\/)/i.test(img.src)) return;
    img.alt = alt || "";
    // Keep every size the site offers so the browser picks a sharp one for the card width.
    const srcset = best && (best.getAttribute("srcset") || best.closest("picture")?.querySelector("source[srcset]")?.getAttribute("srcset"));
    if (srcset) {
      const abs = srcset
        .split(/,\s+/)
        .map((part) => {
          const [u, d] = part.trim().split(/\s+/);
          try {
            return new URL(u, location.href).href + (d ? " " + d : "");
          } catch {
            return "";
          }
        })
        .filter(Boolean)
        .join(", ");
      if (abs) {
        img.srcset = abs;
        img.sizes = "(max-width: 720px) 100vw, 900px";
      }
    }
    fig.append(img);
    if (caption) {
      // Don't repeat a caption the body already contains.
      for (const n of frag.querySelectorAll("p, figcaption, div")) {
        if (!n.querySelector("p, div") && norm(n.textContent) === norm(caption)) n.remove();
      }
      const fc = document.createElement("figcaption");
      fc.textContent = caption;
      fig.append(fc);
    }
    frag.prepend(fig);
  }

  // Safari runs the first image edge to edge across the page card.
  function markLeadMedia(frag) {
    const first = frag.querySelector("img, picture, video, figure, p, h2, h3, h4, ul, ol, blockquote, pre, table");
    if (!first) return;
    let media = null;
    if (/^(IMG|PICTURE|VIDEO|FIGURE)$/.test(first.tagName)) media = first.closest("figure") || first;
    else if (first.tagName === "P" && !first.textContent.trim() && first.querySelector("img, picture")) media = first;
    if (media) media.classList.add("lead-media");
  }

  function extract() {
    const clone = prepareClone();
    const article = new Readability(clone, { charThreshold: 300, allowedVideoRegex: EMBED_RE }).parse();
    if (!article || !article.content) return null;

    const tpl = document.createElement("template");
    tpl.innerHTML = article.content;
    const frag = tpl.content;

    // If the page carries a much longer full text in its structured data (common on paywalled
    // sites), use that for the body and keep the lead image Readability found.
    const ldBody = structuredArticleBody();
    const extractedLen = (frag.textContent || "").replace(/\s+/g, " ").trim().length;
    if (ldBody.length > 800 && ldBody.length > extractedLen * 1.4) {
      const lead = frag.querySelector("figure, picture, img");
      // Some sites put HTML in this text. Use only its words: page data that was harmless
      // inside a <script> tag must never become live markup in Reader.
      let text = ldBody;
      if (/<p[\s>]/i.test(ldBody)) {
        const t = document.createElement("template");
        t.innerHTML = ldBody;
        text = [...t.content.querySelectorAll("p, h2, h3, h4, li, blockquote")]
          .filter((n) => !n.parentElement || !n.parentElement.closest("p, li, blockquote"))
          .map((n) => n.textContent.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join("\n\n");
      }
      const body = paragraphsFromText(text);
      frag.replaceChildren();
      if (lead) frag.append(lead);
      frag.append(body);
    }

    sanitizeFragment(frag, article.title);
    addRatingToProsCons(frag);
    article.dek = findDek(article, frag);

    // Drop a short leading byline/dateline block, since the header already shows it.
    const bylineKey = norm(article.byline).replace(/^by\s+/, "");
    if (bylineKey) {
      const leading = [...frag.querySelectorAll("p, div, span, address, time")].slice(0, 6);
      const dup = leading.find((n) => {
        const t = norm(n.textContent);
        return t.length > 0 && t.length < 120 && t.includes(bylineKey) && !n.querySelector("img, p");
      });
      if (dup) dup.remove();
    }

    addLeadImage(frag);
    markLeadMedia(frag);

    return { ...article, fragment: frag };
  }

  const ACTIVE_ELEMENTS =
    "script, style, link, noscript, object, embed, applet, frame, frameset, meta, base, template, input, textarea, select, animate, set, animateTransform, animateMotion, foreignObject";
  const DANGEROUS_ATTRS = new Set(["srcdoc", "formaction", "action", "form", "autofocus", "http-equiv"]);
  const URL_ATTRS = new Set(["href", "src", "xlink:href", "poster", "data", "background", "cite", "longdesc"]);

  // Web addresses only. Images may also be inline data images (lazy-load placeholders).
  function safeUrl(value, tag, attr) {
    const v = String(value).replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
    if (!scheme) return true; // relative address
    const s = scheme[1].toLowerCase();
    if (s === "http" || s === "https") return true;
    if ((s === "mailto" || s === "tel") && attr === "href") return true;
    return s === "data" && attr === "src" && (tag === "IMG" || tag === "SOURCE") && /^data:image\/(png|gif|jpe?g|webp|avif|svg\+xml)[;,]/i.test(v);
  }

  // Icons drawn from the page's icon sheet (<svg><use href="#thumbsup">) can't render inside
  // Reader, and an <svg> without a size defaults to 300×150, leaving big empty gaps (e.g.
  // Engadget's pros and cons). Drop sprite icons and small inline icons sitting beside text.
  function removeIcons(frag) {
    for (const svg of [...frag.querySelectorAll("svg")]) {
      const shapes = svg.querySelectorAll("path, rect, circle, ellipse, line, polyline, polygon, text, image, g");
      const spriteOnly = svg.querySelector("use") && !shapes.length;
      const parent = svg.parentElement;
      const besideText = parent && norm(parent.textContent).length > 0 && !svg.getAttribute("width") && !svg.getAttribute("height");
      if (spriteOnly || besideText || !shapes.length) svg.remove();
    }
  }

  // Review scorecards: "Pros"/"Cons" (or "The Good"/"The Bad") labels, each followed by a
  // list. Show them as one tidy box with ✓ and ✕ marks instead of captions and loose lists.
  const PRO_LABEL = /^(pros|the good|likes|what we like|we like|positives|strengths|pluses|the positives)\s*:?$/i;
  const CON_LABEL = /^(cons|the bad|dislikes|what we don'?t like|we don'?t like|negatives|weaknesses|minuses|the negatives)\s*:?$/i;

  function markProsCons(frag) {
    const doc = frag.ownerDocument || document;
    const units = [];
    for (const label of [...frag.querySelectorAll("figcaption, h2, h3, h4, h5, h6, p, strong, b, span, div, dt")]) {
      if (label.closest(".procon")) continue;
      const t = label.textContent.replace(/\s+/g, " ").trim();
      const kind = PRO_LABEL.test(t) ? "pro" : CON_LABEL.test(t) ? "con" : "";
      if (!kind || label.querySelector("ul, ol, p, h2, h3, h4")) continue;
      // The label may be wrapped (<p><strong>Pros</strong></p>); the list follows the wrapper.
      let host = label;
      while (host.parentElement && host.parentElement !== frag && norm(host.parentElement.textContent) === norm(t)) host = host.parentElement;
      let list = host.nextElementSibling;
      while (list && !/^(UL|OL)$/.test(list.tagName) && !norm(list.textContent)) list = list.nextElementSibling;
      if (!list || !/^(UL|OL)$/.test(list.tagName) || host.hasAttribute("data-rv-procon-label")) continue;
      host.setAttribute("data-rv-procon-label", kind);
      list.setAttribute("data-rv-procon", kind);
      // Group the label and its list; widen to a wrapper that holds just the two.
      let unit = host.parentElement;
      if (!unit || unit === frag || [...unit.children].some((c) => c !== host && c !== list && norm(c.textContent))) {
        unit = doc.createElement("div");
        host.before(unit);
        unit.append(host, list);
      }
      units.push({ unit, kind });
    }
    // A pros unit followed by a cons unit (or the reverse) share one box, side by side.
    const placed = new Set();
    for (let i = 0; i < units.length; i++) {
      if (placed.has(units[i].unit)) continue;
      const a = units[i].unit;
      let next = a.nextElementSibling;
      while (next && !norm(next.textContent) && !next.querySelector("img")) next = next.nextElementSibling;
      const b = units.find((u) => u.unit === next && u.kind !== units[i].kind);
      const box = doc.createElement("div");
      box.className = "procon" + (b ? "" : " single");
      a.before(box);
      box.append(a);
      placed.add(a);
      if (b) {
        box.append(b.unit);
        placed.add(b.unit);
      }
    }
  }

  // The review's score, from the page's structured data (e.g. Engadget's "8.3 / 10"), shown at
  // the top of the pros-and-cons box. Readability usually drops the site's own score badge.
  function reviewRating() {
    let found = null;
    const visit = (o) => {
      if (found || !o || typeof o !== "object") return;
      if (Array.isArray(o)) return o.forEach(visit);
      const r = o.reviewRating;
      if (r && typeof r === "object" && r.ratingValue != null) {
        const value = parseFloat(r.ratingValue);
        const best = parseFloat(r.bestRating ?? 5);
        if (isFinite(value) && isFinite(best) && best > 0 && value >= 0 && value <= best) found = { value, best };
      }
      if (o["@graph"]) visit(o["@graph"]);
      if (o.mainEntity) visit(o.mainEntity);
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        visit(JSON.parse(s.textContent));
      } catch {}
    });
    return found;
  }

  function addRatingToProsCons(frag) {
    const box = frag.querySelector(".procon");
    if (!box) return;
    // The site's score badge often survives as loose lines just above the box: "8",
    // "Verge Score", "$699". Fold them into the box's top line instead.
    const leaves = [...frag.querySelectorAll("p, div, span, h3, h4, h5")].filter(
      (n) => !box.contains(n) && n.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING && !n.querySelector("p, div, img, picture, figure, ul, ol, h2, h3, h4, iframe")
    );
    let label = "";
    let score = "";
    let price = "";
    const used = new Set();
    for (const n of leaves.slice(-8).reverse()) {
      const t = n.textContent.replace(/\s+/g, " ").trim();
      if (!t || used.has(t)) {
        if (t) n.remove(); // the same badge text repeated (wrapper and inner span, or two prices)
        continue;
      }
      used.add(t);
      if (!score && /^\d{1,3}(\.\d)?$/.test(t)) score = t;
      else if (!label && t.length < 30 && /\b(score|rating)\b/i.test(t)) label = t.replace(/[:：]\s*$/, "");
      else if (!price && /^[$€£¥]\s?\d[\d,.]*$/.test(t)) price = t;
      else break;
      n.remove();
    }
    const r = reviewRating();
    const parts = [];
    if (r) parts.push(`${label || "Rating"}: `, el("strong", { text: `${r.value} / ${r.best}` }));
    else if (score) parts.push(`${label || "Score"}: `, el("strong", { text: score }));
    if (price) parts.push(parts.length ? ` · ${price}` : price);
    if (parts.length) box.prepend(el("div", { class: "procon-rating" }, parts));
  }

  // Cleanup shared by the first page and any later pages of a multi-page article.
  function sanitizeFragment(frag, title) {
    // Nothing in the Reader copy may run code: drop active elements, event handlers, inline
    // frame documents and any link or source that isn't plain web content.
    frag.querySelectorAll(ACTIVE_ELEMENTS).forEach((n) => n.remove());
    frag.querySelectorAll("form").forEach((f) => f.replaceWith(...f.childNodes));
    frag.querySelectorAll("*").forEach((n) => {
      for (const a of [...n.attributes]) {
        const name = a.name.toLowerCase();
        if (name.startsWith("on") || DANGEROUS_ATTRS.has(name)) n.removeAttribute(a.name);
        else if (URL_ATTRS.has(name) && !safeUrl(a.value, n.tagName, name)) n.removeAttribute(a.name);
      }
    });

    finishEmbeds(frag);
    finishCode(frag);
    removeIcons(frag);
    markProsCons(frag);
    removeJunk(frag);
    markPullQuotes(frag);
    for (const bq of frag.querySelectorAll("blockquote[data-rv-pull]")) {
      bq.classList.add("pull", "lifted");
      bq.querySelector("[data-rv-attribution]")?.classList.add("attribution");
    }

    // Drop a leading heading that just repeats the title (we render the title ourselves).
    const firstHeading = frag.querySelector("h1, h2");
    if (firstHeading && norm(firstHeading.textContent) === norm(title)) firstHeading.remove();

    // Images load eagerly so they're visible right away.
    frag.querySelectorAll("img").forEach((img) => {
      img.removeAttribute("loading");
      img.removeAttribute("width");
      img.removeAttribute("height");
    });
  }

  // ---------- multi-page articles ----------
  // Like Safari, follow "next page" links and show the whole article as one page.

  const PAGE_PARAMS = ["page", "p", "pg", "paged", "pagenum", "pageno", "pagina", "seite", "pn"];
  const NEXT_TEXT = /^(next|next page|next ›|next »|next >|›|»|>|→|continue|weiter|suivant|siguiente|próxima|avanti)$/i;
  const MAX_PAGES = 10;

  function pageInfo(href) {
    const url = new URL(href);
    url.hash = "";
    let num = null;
    for (const k of PAGE_PARAMS) {
      if (url.searchParams.has(k)) {
        const v = parseInt(url.searchParams.get(k), 10);
        if (!isNaN(v)) num = v;
        url.searchParams.delete(k);
      }
    }
    let path = url.pathname;
    const m =
      path.match(/\/page\/(\d{1,3})\/?$/i) ||
      path.match(/\/(\d{1,2})\/?$/) ||
      path.match(/[-_]page[-_]?(\d{1,3})(?=(\.[a-z]{2,5})?\/?$)/i) ||
      path.match(/[-_](\d{1,2})(?=\.[a-z]{2,5}$)/i);
    let trailingNum = null;
    if (m) {
      trailingNum = parseInt(m[1], 10);
      path = path.slice(0, m.index) + path.slice(m.index + m[0].length).replace(/^\/$/, "");
    }
    url.pathname = path.replace(/\/$/, "") || "/";
    return { path: url.origin + url.pathname, params: url.searchParams, num: num ?? trailingNum };
  }

  // Same article if the path (minus page markers) matches and every query value on the
  // candidate also appears on the current URL (so tracking tags like ?utm_source don't matter,
  // but article.php?id=123 vs ?id=456 is still a different article).
  function samePageSeries(cur, cand) {
    if (cur.path !== cand.path) return false;
    for (const [k, v] of cand.params) if (cur.params.get(k) !== v) return false;
    return true;
  }

  // The live page's own page number: only trust explicit page markers, so an article URL that
  // just ends in a number isn't mistaken for "page 12".
  function currentPageNumber(href) {
    const url = new URL(href);
    for (const k of PAGE_PARAMS) if (url.searchParams.has(k)) return parseInt(url.searchParams.get(k), 10) || 1;
    const m = url.pathname.match(/\/page\/(\d{1,3})\/?$/i);
    return m ? parseInt(m[1], 10) : 1;
  }

  function findNextPageUrl(doc, currentHref, expected) {
    const cur = pageInfo(currentHref);
    const candidates = [];
    const linkNext = doc.querySelector('link[rel~="next"][href]');
    if (linkNext) candidates.push(linkNext.getAttribute("href"));
    for (const a of doc.querySelectorAll("a[href]")) {
      const label = (a.getAttribute("aria-label") || a.textContent || "").replace(/\s+/g, " ").trim();
      const inPager = a.closest('[class*="pag" i], [id*="pag" i], nav[aria-label*="pag" i], [role="navigation"]');
      if (/(^|\s)next(\s|$)/i.test(a.getAttribute("rel") || "") || NEXT_TEXT.test(label) || /next page/i.test(label)) {
        candidates.push(a.getAttribute("href"));
      } else if (inPager && label === String(expected)) {
        candidates.push(a.getAttribute("href"));
      }
    }
    for (const raw of candidates) {
      let abs;
      try {
        abs = new URL(raw, currentHref).href;
      } catch {
        continue;
      }
      if (new URL(abs).origin !== new URL(currentHref).origin) continue;
      const info = pageInfo(abs);
      if (samePageSeries(cur, info) && info.num === expected) return abs.split("#")[0];
    }
    return null;
  }

  async function appendFollowingPages(title, firstText) {
    const session = ui; // a later Reader session must not receive this one's results
    let href = location.href;
    let doc = document;
    let num = currentPageNumber(href);
    const seenUrls = new Set([href.split("#")[0]]);
    const seenText = new Set([firstText]);

    for (let i = 0; i < MAX_PAGES - 1 && ui === session; i++) {
      const next = findNextPageUrl(doc, href, num + 1);
      if (!next || seenUrls.has(next)) break;
      seenUrls.add(next);
      setPageLoader(`Loading page ${num + 1}…`);

      let html;
      try {
        const res = await fetch(next, { credentials: "include" });
        if (!res.ok) break;
        html = await res.text();
      } catch {
        break;
      }
      if (ui !== session) return;

      const nextDoc = new DOMParser().parseFromString(html, "text/html");
      const base = nextDoc.createElement("base");
      base.href = next;
      nextDoc.head.prepend(base);
      // Find the following page's link before Readability rewrites the document.
      const followHref = next;
      const parseDoc = nextDoc.cloneNode(true);
      normalizePullQuotes(parseDoc);
      normalizeCode(parseDoc, next);
      normalizeEmbeds(parseDoc, next);
      protectArticleAncestors(parseDoc);
      const art = new Readability(parseDoc, { charThreshold: 300, allowedVideoRegex: EMBED_RE }).parse();
      if (!art || !art.content) break;

      const tpl = document.createElement("template");
      tpl.innerHTML = art.content;
      const frag = tpl.content;
      sanitizeFragment(frag, title);
      const sig = norm(frag.textContent).slice(0, 200);
      if (!sig || seenText.has(sig)) break; // same content again: not really a next page
      seenText.add(sig);

      const section = el("div", { class: "page-part", "data-page": String(num + 1) });
      section.append(frag);
      ui.content.append(el("hr", { class: "page-break", "aria-label": `Page ${num + 1}` }), section);
      refreshToc();

      doc = nextDoc;
      href = followHref;
      num += 1;
    }
    if (ui === session) setPageLoader("");
  }

  function setPageLoader(text) {
    if (!ui) return;
    ui.loader.textContent = text;
    ui.loader.hidden = !text;
  }

  // ---------- image lightbox ----------
  // Clicking an image enlarges it over the article instead of following its link.

  const IMAGE_PATH = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i;

  // Best available full-size version: a link straight to an image file, else the widest srcset entry.
  function largestSrc(img) {
    const link = img.closest("a[href]");
    if (link) {
      try {
        const u = new URL(link.getAttribute("href"), location.href);
        if (IMAGE_PATH.test(u.pathname)) return u.href;
      } catch {}
    }
    let best = img.currentSrc || img.src;
    let bestW = 0;
    const srcset =
      img.getAttribute("srcset") || img.closest("picture")?.querySelector("source[srcset]")?.getAttribute("srcset") || "";
    for (const part of srcset.split(/,\s+/)) {
      const [u, d] = part.trim().split(/\s+/);
      if (!u) continue;
      const w = d && /w$/i.test(d) ? parseInt(d, 10) : d && /x$/i.test(d) ? parseFloat(d) * 1000 : 1;
      if (w > bestW) {
        bestW = w;
        try {
          best = new URL(u, location.href).href;
        } catch {}
      }
    }
    return best;
  }

  function buildLightbox() {
    const img = el("img", { class: "lb-img", alt: "" });
    const cap = el("div", { class: "lb-caption" });
    const prev = el("button", { class: "lb-nav lb-prev", "aria-label": "Previous image", title: "Previous (←)", text: "‹" });
    const next = el("button", { class: "lb-nav lb-next", "aria-label": "Next image", title: "Next (→)", text: "›" });
    const closeBtn = el("button", { class: "lb-close", "aria-label": "Close image", title: "Close (Esc)" });
    closeBtn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    const box = el("div", { class: "lightbox", role: "dialog", "aria-modal": "true", "aria-label": "Image viewer", hidden: true }, [
      closeBtn,
      prev,
      el("figure", { class: "lb-figure" }, [img, cap]),
      next,
    ]);
    box.addEventListener("click", (e) => {
      if (e.target === box || e.target === img || e.composedPath().includes(closeBtn)) closeLightbox();
    });
    prev.addEventListener("click", (e) => {
      e.stopPropagation();
      stepLightbox(-1);
    });
    next.addEventListener("click", (e) => {
      e.stopPropagation();
      stepLightbox(1);
    });
    return { box, img, cap, prev, next, closeBtn };
  }

  const lightboxImages = () => [...ui.content.querySelectorAll("img")].filter((i) => i.currentSrc || i.src);

  function showLightboxImage(index) {
    const list = lightboxImages();
    if (!list.length) return;
    index = (index + list.length) % list.length;
    ui.lbIndex = index;
    const thumb = list[index];
    const lb = ui.lb;
    const shown = thumb.currentSrc || thumb.src;
    lb.img.src = shown;
    lb.img.alt = thumb.alt || "";
    // Swap in the full-size version once it has loaded.
    const full = largestSrc(thumb);
    if (full && full !== shown) {
      const pre = new Image();
      pre.onload = () => {
        if (ui && ui.lbIndex === index) lb.img.src = full;
      };
      pre.src = full;
    }
    const figCap = thumb.closest("figure")?.querySelector("figcaption");
    const caption = (figCap ? figCap.textContent : thumb.alt || "").replace(/\s+/g, " ").trim();
    lb.cap.textContent = caption;
    lb.cap.hidden = !caption;
    const multi = list.length > 1;
    lb.prev.hidden = !multi;
    lb.next.hidden = !multi;
  }

  function openLightbox(img) {
    const index = lightboxImages().indexOf(img);
    if (index < 0) return;
    ui.lb.box.hidden = false;
    ui.lightboxOpen = true;
    showLightboxImage(index);
    ui.lb.closeBtn.focus({ preventScroll: true });
  }

  function closeLightbox() {
    if (!ui || !ui.lightboxOpen) return;
    ui.lb.box.hidden = true;
    ui.lb.img.removeAttribute("src");
    ui.lightboxOpen = false;
    ui.reader.focus({ preventScroll: true });
  }

  const stepLightbox = (d) => showLightboxImage(ui.lbIndex + d);

  // ---------- table of contents ----------
  // Safari shows a Table of Contents beside longer articles that have sections.

  function collectHeadings() {
    let hs = [...ui.content.querySelectorAll("h2")];
    if (hs.length < 2) hs = [...ui.content.querySelectorAll("h2, h3")];
    hs = hs.filter((h) => h.textContent.trim().length > 1 && h.textContent.trim().length < 160);
    if (hs.length >= 2) return hs;
    // No real sections: some sites (The Verge's reviews) mark sections with pull quotes
    // instead, so list those. Quotes naming a person are real quotes, not section breaks.
    const pulls = [...ui.content.querySelectorAll("blockquote.pull.lifted")].filter(
      (b) => !b.querySelector(".attribution") && b.textContent.trim().length < 160
    );
    const both = [...hs, ...pulls].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return both.length >= 2 ? both : hs;
  }

  function refreshToc() {
    if (!ui) return;
    const headings = collectHeadings();
    ui.headings = headings;
    ui.tocList.replaceChildren(
      ...headings.map((h, i) => {
        h.id = h.id || `rv-section-${i + 1}`;
        const btn = el("button", {
          class: "toc-link",
          text: h.textContent.replace(/\s+/g, " ").trim(),
          onclick: () => {
            const top = ui.reader.scrollTop + h.getBoundingClientRect().top - ui.reader.getBoundingClientRect().top - 24;
            const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
            ui.reader.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
            if (isOverlaySidebar()) setSidebar(false, false);
          },
        });
        return el("li", {}, btn);
      })
    );
    applySidebar();
    updateActiveSection();
  }

  const isOverlaySidebar = () => window.innerWidth < SIDEBAR_MIN_WIDTH;

  function applySidebar() {
    if (!ui) return;
    const hasToc = !!ui.headings && ui.headings.length >= 2;
    const has = hasToc || ui.hasSummary;
    ui.tocSection.hidden = !hasToc;
    ui.summary.section.hidden = !ui.hasSummary;
    ui.sidebarBtn.hidden = !has;
    const open = has && ui.sidebarOpen;
    ui.reader.classList.toggle("with-sidebar", open);
    ui.reader.classList.toggle("sidebar-overlay", open && isOverlaySidebar());
    ui.sidebar.hidden = !open;
    ui.sidebarBtn.classList.toggle("on", open);
    ui.sidebarBtn.setAttribute("aria-expanded", String(open));
  }

  function setSidebar(open, remember = true) {
    ui.sidebarOpen = open;
    if (remember) {
      settings.sidebar = open;
      saveSettings();
    }
    applySidebar();
  }

  function updateActiveSection() {
    if (!ui || !ui.headings) return;
    let active = -1;
    ui.headings.forEach((h, i) => {
      if (h.getBoundingClientRect().top < 140) active = i;
    });
    [...ui.tocList.children].forEach((li, i) => li.classList.toggle("active", i === active));
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  // ---------- appearance ----------

  function applySettings() {
    if (!ui) return;
    const font = FONTS.find((f) => f.id === settings.font) || FONTS[0];
    const size = (BASE_SIZE * settings.zoom) / 100;
    // A new size or font reflows the text; keep the paragraph being read in place.
    const keep = ui.posReady && (ui.reader.style.getPropertyValue("--reader-size") !== size + "px" ||
      ui.reader.style.getPropertyValue("--reader-font") !== font.stack) ? currentPosition() : null;
    for (const c of [...ui.reader.classList]) if (c.startsWith("theme-")) ui.reader.classList.remove(c);
    ui.reader.classList.add(`theme-${settings.theme}`);
    ui.reader.style.setProperty("--reader-font", font.stack);
    ui.reader.style.setProperty("--reader-size", size + "px");
    if (keep) applyPosition(keep);

    ui.themeButtons.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.theme === settings.theme)));
    ui.fontButtons.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.font === settings.font)));
    const i = ZOOMS.indexOf(settings.zoom);
    ui.smaller.disabled = i <= 0;
    ui.larger.disabled = i >= ZOOMS.length - 1;
    ui.zoomLabel.textContent = settings.zoom + "%";
  }

  function changeSize(delta) {
    const i = ZOOMS.indexOf(settings.zoom);
    settings.zoom = delta === 0 ? 100 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + delta))];
    applySettings();
    saveSettings();
  }

  // ---------- UI ----------

  function buildPopover() {
    const smaller = el("button", { class: "size-btn", "aria-label": "Make text smaller", title: "Make text smaller", onclick: () => changeSize(-1) }, el("span", { class: "a-small", text: "A" }));
    const larger = el("button", { class: "size-btn", "aria-label": "Make text bigger", title: "Make text bigger", onclick: () => changeSize(1) }, el("span", { class: "a-large", text: "A" }));
    const zoomLabel = el("button", { class: "zoom-label", title: "Reset zoom (Ctrl+0)", "aria-label": "Zoom level, click to reset", onclick: () => changeSize(0), text: "100%" });

    const themeButtons = THEMES.map((t) =>
      el("button", {
        class: `swatch swatch-${t.id}`,
        role: "radio",
        "aria-label": t.label,
        title: t.label,
        "data-theme": t.id,
        onclick: () => {
          settings.theme = t.id;
          applySettings();
          saveSettings();
        },
      })
    );

    const fontButtons = FONTS.map((f) => {
      const btn = el(
        "button",
        {
          class: "font-btn",
          role: "radio",
          "data-font": f.id,
          onclick: () => {
            settings.font = f.id;
            applySettings();
            saveSettings();
          },
        },
        [el("span", { class: "font-name", text: f.label }), el("span", { class: "check", "aria-hidden": "true", text: "✓" })]
      );
      btn.querySelector(".font-name").style.fontFamily = f.stack;
      return btn;
    });

    const autoBox = el("input", { type: "checkbox" });
    getAutoHosts().then((hosts) => (autoBox.checked = hosts.includes(location.hostname)));
    autoBox.addEventListener("change", () => setAutoHost(location.hostname, autoBox.checked));

    const popover = el("div", { class: "popover", role: "dialog", "aria-label": "Reader appearance", hidden: true }, [
      el("div", { class: "row sizes" }, [smaller, el("div", { class: "divider" }), zoomLabel, el("div", { class: "divider" }), larger]),
      el("div", { class: "row themes", role: "radiogroup", "aria-label": "Theme" }, themeButtons),
      el("div", { class: "fonts", role: "radiogroup", "aria-label": "Font" }, fontButtons),
      el("label", { class: "auto" }, [autoBox, el("span", { text: `Use Reader automatically on “${location.hostname || "this site"}”` })]),
    ]);

    // Copies installed from GitHub learn about new versions from the background worker.
    try {
      chrome.runtime
        .sendMessage({ type: "update-info" })
        .then((info) => {
          if (!info || !info.version || !/^https:\/\/github\.com\//.test(info.url || "")) return;
          popover.append(
            el("a", { class: "update", href: info.url, target: "_blank", rel: "noopener noreferrer" }, [
              el("span", { class: "update-dot", "aria-hidden": "true" }),
              el("span", { text: `Reader View ${info.version} is available. Download it` }),
            ])
          );
        })
        .catch(() => {});
    } catch {}

    return { popover, smaller, larger, zoomLabel, themeButtons, fontButtons };
  }

  function buildArticle(article) {
    const metaParts = [article.siteName, article.byline, formatDate(article.publishedTime)].filter(Boolean);
    // Avoid "Example · Example" when byline equals site name.
    const meta = [...new Map(metaParts.map((m) => [norm(m), m])).values()];

    const content = el("div", { class: "content" });
    content.append(article.fragment);
    const loader = el("div", { class: "page-loader", role: "status", hidden: true });

    const page = el("article", { class: "rv-page", dir: article.dir || null, lang: article.lang || null }, [
      el("header", { class: "header" }, [
        el("h1", { class: "title", text: article.title || document.title }),
        article.dek ? el("p", { class: "dek", text: article.dek }) : null,
        meta.length ? el("div", { class: "meta", text: meta.join(" · ") }) : null,
      ]),
      content,
      loader,
    ]);
    return { page, content, loader };
  }

  const ICON_SIDEBAR =
    '<svg viewBox="0 0 18 16" aria-hidden="true"><rect x="1.25" y="1.75" width="15.5" height="12.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M11.5 2v12" stroke="currentColor" stroke-width="1.4"/></svg>';
  const ICON_TOC =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h1.2M2 8h1.2M2 12.5h1.2M5.5 3.5H14M5.5 8H14M5.5 12.5H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  const ICON_SUMMARY =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h8M2 7h6M2 10.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12.5 8.5l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z" fill="currentColor"/></svg>';

  function buildSidebar() {
    const tocList = el("ol", { class: "toc" });
    const tocTitle = el("h2", { class: "side-title" });
    tocTitle.innerHTML = ICON_TOC;
    tocTitle.append(el("span", { text: "Table of Contents" }));
    const tocSection = el("section", { class: "side-section", hidden: true }, [tocTitle, tocList]);

    const sumTitle = el("h2", { class: "side-title" });
    sumTitle.innerHTML = ICON_SUMMARY;
    sumTitle.append(el("span", { text: "Summary" }));
    const summary = {
      text: el("p", { class: "summary-text", "aria-live": "polite" }),
      note: el("p", { class: "summary-note" }),
      action: el("button", { class: "summary-action", hidden: true }),
    };
    summary.section = el("section", { class: "side-section summary", hidden: true }, [sumTitle, summary.text, summary.note, summary.action]);

    const sidebar = el("aside", { class: "sidebar", "aria-label": "Summary and Table of Contents", hidden: true }, [summary.section, tocSection]);
    return { sidebar, tocList, tocSection, summary };
  }

  // ---------- summary ----------
  // Safari summarizes longer articles with on-device AI. We use Chrome's built-in on-device model
  // (Summarizer API, Gemini Nano): free, private, nothing leaves the computer. Where it isn't
  // available we show the article's key sentences instead.

  const SUMMARY_MIN_WORDS = 500; // roughly a 2½-minute read
  const SUMMARY_CACHE_MAX = 150;
  const AI_OPTIONS = {
    type: "tldr",
    format: "plain-text",
    length: "medium",
    sharedContext: "An article shown in a distraction-free reading view.",
    expectedInputLanguages: ["en"],
    outputLanguage: "en",
  };
  const NOTE_AI = "Summarized on this device by Chrome's built-in AI.";
  const NOTE_KEY = "Key sentences from the article.";

  const summaryKey = () => "sum:" + location.href.split("#")[0];

  async function cachedSummary(key) {
    try {
      const { summaryCache = {} } = await chrome.storage.local.get("summaryCache");
      return summaryCache[key] || null;
    } catch {
      return null;
    }
  }

  async function cacheSummary(key, text) {
    try {
      const { summaryCache = {} } = await chrome.storage.local.get("summaryCache");
      summaryCache[key] = { text, t: Date.now() };
      const keys = Object.keys(summaryCache).sort((a, b) => summaryCache[b].t - summaryCache[a].t);
      for (const k of keys.slice(SUMMARY_CACHE_MAX)) delete summaryCache[k];
      await chrome.storage.local.set({ summaryCache });
    } catch {}
  }

  function articleText() {
    return [...ui.content.querySelectorAll("h2, h3, p, li, blockquote")]
      .filter((n) => !n.closest("figcaption") && !(n.tagName === "P" && n.closest("li, blockquote")))
      .map((n) => n.textContent.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  }

  function showSummary(text, kind) {
    if (!ui) return;
    const s = ui.summary;
    s.text.textContent = text;
    s.text.classList.toggle("pending", !text);
    s.note.textContent = kind === "ai" ? NOTE_AI : kind === "key" ? NOTE_KEY : kind || "";
  }

  function setSummaryAction(label, onClick) {
    const a = ui.summary.action;
    a.hidden = !label;
    a.textContent = label || "";
    a.onclick = onClick || null;
    a.disabled = false;
  }

  async function startSummary() {
    const session = ui; // a later Reader session must not receive this one's results
    if (ui !== session) return;
    const text = articleText();
    if (text.split(/\s+/).length < SUMMARY_MIN_WORDS) return;
    ui.hasSummary = true;
    applySidebar();

    const key = summaryKey();
    const cached = await cachedSummary(key);
    if (ui !== session) return;
    if (cached) return showSummary(cached.text, "ai");

    const AI = globalThis.Summarizer;
    let status = "unavailable";
    if (AI && typeof AI.availability === "function") {
      try {
        status = await AI.availability(AI_OPTIONS);
      } catch {}
    }
    if (ui !== session) return;

    if (status === "available") {
      showSummary("", "Summarizing…");
      try {
        await runAiSummary(text, key);
        return;
      } catch (err) {
        console.warn("Reader: on-device summary failed", err);
      }
    }

    // Instant fallback; offer the free model download where Chrome supports it.
    showSummary(keySentences(text), "key");
    if (status === "downloadable" || status === "downloading") {
      setSummaryAction("Summarize with Chrome's built-in AI", () => downloadAndSummarize(text, key));
      ui.summary.note.textContent = NOTE_KEY + " Chrome's free on-device AI can write a proper summary (one-time model download).";
    } else if (!AI) {
      // Chromium browsers other than Google Chrome (Dia, Arc, Brave…) don't ship the on-device model.
      ui.summary.note.textContent = NOTE_KEY + " This browser doesn't include Chrome's built-in AI.";
    } else {
      ui.summary.note.textContent = NOTE_KEY + " Chrome's built-in AI isn't available on this computer.";
    }
  }

  // Chrome only allows the model download after a click on the page, hence the button.
  async function downloadAndSummarize(text, key) {
    const session = ui; // a later Reader session must not receive this one's results
    const a = ui.summary.action;
    a.disabled = true;
    a.textContent = "Preparing on-device AI…";
    try {
      await runAiSummary(text, key, (p) => {
        if (ui === session) a.textContent = `Downloading on-device AI… ${Math.round(p * 100)}%`;
      });
      if (ui === session) setSummaryAction("");
    } catch (err) {
      console.warn("Reader: could not set up on-device AI", err);
      if (ui !== session) return;
      setSummaryAction("");
      ui.summary.note.textContent = NOTE_KEY + " Chrome's on-device AI isn't available on this computer.";
    }
  }

  async function runAiSummary(text, key, onProgress) {
    const session = ui; // a later Reader session must not receive this one's results
    const summarizer = await globalThis.Summarizer.create({
      ...AI_OPTIONS,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => onProgress && onProgress(e.loaded));
      },
    });
    try {
      const input = await fitToQuota(summarizer, text);
      if (ui !== session) return;
      let out = "";
      if (typeof summarizer.summarizeStreaming === "function") {
        showSummary("", "Summarizing…");
        for await (const chunk of summarizer.summarizeStreaming(input)) {
          if (ui !== session) return;
          // Older Chrome versions stream the whole text so far; newer ones stream only new text.
          out = chunk.startsWith(out) ? chunk : out + chunk;
          ui.summary.text.textContent = out;
          ui.summary.text.classList.remove("pending");
        }
      } else {
        out = await summarizer.summarize(input);
      }
      out = out.trim();
      if (!out) throw new Error("empty summary");
      showSummary(out, "ai");
      cacheSummary(key, out);
    } finally {
      summarizer.destroy?.();
    }
  }

  // Trim long articles to what the on-device model accepts.
  async function fitToQuota(summarizer, text) {
    if (!summarizer.inputQuota || typeof summarizer.measureInputUsage !== "function") return text.slice(0, 12000);
    let t = text;
    for (let i = 0; i < 6; i++) {
      const used = await summarizer.measureInputUsage(t);
      if (used <= summarizer.inputQuota) return t;
      t = t.slice(0, Math.floor((t.length * summarizer.inputQuota) / used) * 0.9);
    }
    return t;
  }

  // ---- key-sentence fallback (no AI): score sentences by how many of the article's frequent
  // words they contain, favour the opening, keep the best few in their original order.
  const STOP = new Set(
    "a an and are as at be been but by for from had has have he her his i if in into is it its just more most not of on or our out she so than that the their them then there these they this those to up was we were what when which who will with would you your about after also all can could did do does over said says say some such very".split(
      " "
    )
  );

  function keySentences(text, maxSentences = 3, maxChars = 650) {
    // Skip correction/update notes and editor's notes: they never summarize the story.
    const paras = text
      .split("\n")
      .filter((p) => p.length > 60 && !/^(correction|clarification|update|updated|editor['’]?s note)\b[^:]{0,40}:/i.test(p));
    const sentences = [];
    // Don't end a sentence at "Rep.", "Dr.", "U.S.", "Jr." or a single initial.
    const ABBREV = /(?:^|\s|\()(?:Mr|Mrs|Ms|Dr|Rep|Reps|Sen|Gov|Gen|Lt|Col|Capt|Sgt|St|Jr|Sr|Inc|Ltd|Co|Corp|Bros|vs|etc|No|Nos|Prof|Rev|Mt|Ft|Jan|Feb|Mar|Apr|Aug|Sept|Sep|Oct|Nov|Dec|U\.S|U\.K|U\.N|E\.U|e\.g|i\.e|a\.m|p\.m|[A-Z])\.\s*$/;
    paras.forEach((p, pi) => {
      // Split only at whitespace that follows ., ! or ? (plus closing quotes), so no text is lost.
      const raw = p.split(/(?<=[.!?]["”’)\]]*)\s+/);
      const parts = [];
      for (const piece of raw) {
        if (parts.length && ABBREV.test(parts[parts.length - 1])) parts[parts.length - 1] += " " + piece;
        else parts.push(piece);
      }
      parts.forEach((s, si) => {
        s = s.trim();
        if (s.length >= 50 && s.length <= 320) sentences.push({ s, pi, si, i: sentences.length });
      });
    });
    if (!sentences.length) return paras[0] ? paras[0].slice(0, maxChars) : "";

    const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []).filter((w) => w.length > 2 && !STOP.has(w));
    const freq = new Map();
    for (const { s } of sentences) for (const w of new Set(words(s))) freq.set(w, (freq.get(w) || 0) + 1);

    for (const x of sentences) {
      const ws = words(x.s);
      const score = ws.reduce((n, w) => n + (freq.get(w) || 0), 0) / Math.sqrt(ws.length || 1);
      const lead = x.pi === 0 ? 1.5 : x.pi < 3 ? 1.15 : 1;
      const quote = /^["“]/.test(x.s) ? 0.7 : 1; // quotes rarely summarize well
      x.score = score * lead * quote * (x.si === 0 ? 1.1 : 1);
    }
    const picked = [];
    let chars = 0;
    for (const x of [...sentences].sort((a, b) => b.score - a.score)) {
      if (picked.length >= maxSentences) break;
      if (chars + x.s.length > maxChars && picked.length) continue;
      picked.push(x);
      chars += x.s.length;
    }
    return picked.sort((a, b) => a.i - b.i).map((x) => x.s).join(" ");
  }

  // ---------- reading position ----------
  // Reopening Reader on an article returns to where you stopped. Positions are kept per
  // article address in chrome.storage.local, anchored to a paragraph (not a pixel offset),
  // so they survive a different window size, zoom level or font.
  const POS_KEY = "readingPositions";
  const POS_MAX = 300;
  const POS_OFFSET = 70; // keep the remembered line a little below the top edge
  const BLOCK_SEL = "p, h2, h3, h4, h5, h6, li, figure, blockquote, pre, table, iframe, img, hr";
  const TRACKING_PARAM = /^(utm_|mc_|fbclid$|gclid$|dclid$|msclkid$|itid$|smid$|cmpid$|ref$|ref_src$|ocid$|taid$)/i;

  function articleKey() {
    const u = new URL(location.href);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    return u.href;
  }

  function readingBlocks() {
    return [...ui.content.querySelectorAll(BLOCK_SEL)].filter((b) => !b.parentElement.closest(BLOCK_SEL));
  }

  function blockTop(b) {
    return b.getBoundingClientRect().top - ui.reader.getBoundingClientRect().top + ui.reader.scrollTop;
  }

  function currentPosition() {
    const r = ui.reader;
    const y = r.scrollTop;
    if (y < 150) return null; // still at the top
    if (y + r.clientHeight >= r.scrollHeight - 40) return null; // finished: start from the top next time
    const anchorY = y + POS_OFFSET;
    const blocks = readingBlocks();
    for (let i = 0; i < blocks.length; i++) {
      const top = blockTop(blocks[i]);
      const h = blocks[i].getBoundingClientRect().height;
      if (top + h > anchorY) {
        return {
          i,
          f: h ? Math.min(1, Math.max(0, (anchorY - top) / h)) : 0,
          s: norm(blocks[i].textContent).slice(0, 60),
          r: y / Math.max(1, r.scrollHeight - r.clientHeight),
          t: Date.now(),
        };
      }
    }
    return null;
  }

  async function savePosition() {
    if (!ui || !ui.posReady) return;
    const key = ui.posKey;
    const pos = currentPosition(); // measured now, before Reader can close
    try {
      const { [POS_KEY]: all = {} } = await chrome.storage.local.get(POS_KEY);
      if (pos) all[key] = pos;
      else if (all[key]) delete all[key];
      else return;
      const keys = Object.keys(all);
      if (keys.length > POS_MAX) {
        keys.sort((a, b) => all[a].t - all[b].t);
        for (const k of keys.slice(0, keys.length - POS_MAX)) delete all[k];
      }
      await chrome.storage.local.set({ [POS_KEY]: all });
    } catch {}
  }

  // Scroll to a saved position. Returns false if its paragraph isn't on screen yet (e.g. it's
  // on page 3 of a multi-page article that is still loading).
  function applyPosition(pos) {
    const blocks = readingBlocks();
    let b = blocks[pos.i];
    if (b && pos.s && !norm(b.textContent).startsWith(pos.s)) b = null;
    if (!b && pos.s) b = blocks.find((x) => norm(x.textContent).startsWith(pos.s));
    const r = ui.reader;
    let y;
    if (b) y = blockTop(b) + pos.f * b.getBoundingClientRect().height - POS_OFFSET;
    else y = pos.r * (r.scrollHeight - r.clientHeight);
    r.scrollTo({ top: Math.max(0, y), behavior: "instant" });
    return !!b;
  }

  async function restorePosition() {
    const session = ui; // a later Reader session must not receive this one's results
    let pos = null;
    try {
      const { [POS_KEY]: all = {} } = await chrome.storage.local.get(POS_KEY);
      pos = all[session.posKey] || null;
    } catch {}
    if (ui !== session) return;
    if (pos) {
      if (!applyPosition(pos)) ui.posPending = pos;
      // Photos above the spot load after this and push the text down. Hold the place for a
      // few seconds as they arrive, unless the reader starts scrolling themselves.
      const until = Date.now() + 4000;
      const hold = () => {
        if (ui !== session || ui.userScrolled || Date.now() > until) return session.content.removeEventListener("load", hold, true);
        if (applyPosition(pos)) ui.posPending = null;
      };
      ui.content.addEventListener("load", hold, true);
    }
    ui.posReady = true;
  }

  function showToast(root, message) {
    const toast = el("div", { class: "toast", role: "status", text: message });
    root.append(toast);
    setTimeout(() => toast.classList.add("show"), 10);
    return new Promise((r) => setTimeout(r, 2200));
  }

  function makeHost() {
    document.getElementById(HOST_ID)?.remove();
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute(
      "style",
      "all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; display: block !important;"
    );
    // Attach to <html> (sibling of <body>) so the print stylesheet can hide the page cleanly.
    document.documentElement.append(host);
    return host;
  }

  // ---------- open / close ----------

  // Reader takes a moment to build (styles, extraction, layout). Listen for Esc from
  // the very first moment so a quick "open, then Esc" cancels instead of being lost.
  let opening = null;
  let pendingFinish = null; // the previous Reader's fade-out, if it hasn't finished yet

  async function open() {
    if (ui || opening) return;
    // Reopened while the last Reader is still fading out: finish closing it first, so its
    // page settings (scrolling, focus) are restored before this one saves them.
    if (pendingFinish) pendingFinish();
    const state = { cancelled: false };
    opening = state;
    const onEarlyKey = (e) => {
      if (e.key !== "Escape") return;
      state.cancelled = true;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onEarlyKey, true);
    window.addEventListener("keyup", onEarlyKey, true);
    try {
      await build(state);
    } finally {
      window.removeEventListener("keydown", onEarlyKey, true);
      window.removeEventListener("keyup", onEarlyKey, true);
      opening = null;
    }
    if (state.cancelled && ui) close();
  }

  async function build(state) {
    const [sheet] = await Promise.all([loadStylesheet(), loadSettings()]);
    if (ui || state.cancelled) return;

    let article = null;
    try {
      article = extract();
    } catch (err) {
      console.warn("Reader: extraction failed", err);
    }
    if (state.cancelled) return;

    const host = makeHost();
    const root = host.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = [sheet];
    if (!article) {
      const wrap = el("div", { class: `reader theme-white toast-only` });
      root.append(wrap);
      await showToast(wrap, "Reader isn't available for this page");
      host.remove();
      return;
    }

    const pop = buildPopover();
    const aaBtn = el("button", { class: "ctrl aa", "aria-label": "Reader appearance", title: "Appearance", "aria-expanded": "false", text: "Aa" });
    const closeBtn = el("button", { class: "ctrl close", "aria-label": "Hide Reader", title: "Hide Reader (Esc)" });
    closeBtn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

    const sidebarBtn = el("button", { class: "ctrl side-toggle", "aria-label": "Show Table of Contents", title: "Table of Contents", "aria-expanded": "false", hidden: true });
    sidebarBtn.innerHTML = ICON_SIDEBAR;
    const built = buildArticle(article);
    const side = buildSidebar();
    const lb = buildLightbox();

    const reader = el("div", { class: "reader entering", tabindex: "-1" }, [
      el("div", { class: "controls" }, [sidebarBtn, aaBtn, closeBtn, pop.popover]),
      el("div", { class: "stage" }, built.page),
      side.sidebar,
      lb.box,
    ]);
    root.append(reader);

    // Images enlarge in place instead of opening their link.
    built.content.addEventListener("click", (e) => {
      const copyBtn = e.target.closest && e.target.closest(".code-copy");
      if (copyBtn) return copyCode(copyBtn);
      const jump = e.target.closest && e.target.closest('a[href^="#"]');
      if (jump) {
        e.preventDefault();
        let id = "";
        try {
          id = decodeURIComponent(jump.getAttribute("href").slice(1));
        } catch {}
        const target = id && (built.content.querySelector(`[id="${CSS.escape(id)}"]`) || built.content.querySelector(`a[name="${CSS.escape(id)}"]`));
        if (target) target.scrollIntoView({ block: "start" });
        return;
      }
      const img = e.target.closest && e.target.closest("img");
      if (!img) return;
      e.preventDefault();
      e.stopPropagation();
      openLightbox(img);
    });

    const prev = {
      htmlOverflow: document.documentElement.style.getPropertyValue("overflow"),
      htmlPriority: document.documentElement.style.getPropertyPriority("overflow"),
      bodyOverflow: document.body ? document.body.style.getPropertyValue("overflow") : "",
      bodyPriority: document.body ? document.body.style.getPropertyPriority("overflow") : "",
      activeElement: document.activeElement,
    };
    document.documentElement.style.setProperty("overflow", "hidden", "important");
    document.body && document.body.style.setProperty("overflow", "hidden", "important");

    // Print only the reader content (like Safari's "Print" while in Reader).
    const printStyle = document.createElement("style");
    printStyle.id = PRINT_STYLE_ID;
    printStyle.textContent = `@media print {
      html > body { display: none !important; }
      html, html > #${HOST_ID} { position: static !important; overflow: visible !important; height: auto !important; }
    }`;
    (document.head || document.documentElement).append(printStyle);

    ui = {
      host, root, reader, prev, printStyle, popover: pop.popover, aaBtn, ...pop,
      content: built.content, loader: built.loader,
      sidebar: side.sidebar, tocList: side.tocList, tocSection: side.tocSection, summary: side.summary, hasSummary: false, sidebarBtn,
      lb, lbIndex: 0, lightboxOpen: false,
      // Remembered preference, but start closed when the window is too narrow to show it beside the text.
      sidebarOpen: settings.sidebar && !isOverlaySidebar(),
      headings: [],
    };
    applySettings();
    refreshToc();
    sidebarBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setSidebar(!ui.sidebarOpen, !isOverlaySidebar());
    });
    // Like Safari: hide the panel when the window gets narrow, restore it when it widens again.
    ui.wasNarrow = isOverlaySidebar();
    ui.onResize = () => {
      if (!ui) return;
      const narrow = isOverlaySidebar();
      if (narrow !== ui.wasNarrow) {
        ui.wasNarrow = narrow;
        ui.sidebarOpen = narrow ? false : settings.sidebar;
      }
      applySidebar();
    };
    ui.resizeObserver = new ResizeObserver(ui.onResize);
    ui.resizeObserver.observe(reader);
    window.addEventListener("resize", ui.onResize);

    // Popover
    const setPopover = (show) => {
      pop.popover.hidden = !show;
      aaBtn.setAttribute("aria-expanded", String(show));
      aaBtn.classList.toggle("on", show);
      if (show) reader.classList.remove("controls-hidden");
    };
    ui.setPopover = setPopover;
    aaBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setPopover(pop.popover.hidden);
    });
    closeBtn.addEventListener("click", () => close());
    reader.addEventListener("click", (e) => {
      if (!pop.popover.hidden && !e.composedPath().includes(pop.popover) && !e.composedPath().includes(aaBtn)) setPopover(false);
    });

    // Controls fade out while scrolling down, come back when scrolling up or hovering near the top.
    let lastY = 0;
    reader.addEventListener(
      "scroll",
      () => {
        const y = reader.scrollTop;
        if (pop.popover.hidden) {
          if (y > lastY + 4 && y > 80) reader.classList.add("controls-hidden");
          else if (y < lastY - 4 || y <= 80) reader.classList.remove("controls-hidden");
        }
        lastY = y;
        updateActiveSection();
        if (ui) {
          clearTimeout(ui.posTimer);
          ui.posTimer = setTimeout(savePosition, 600);
        }
      },
      { passive: true }
    );
    // Any scrolling by the reader themselves ends the "hold my place while photos load" phase.
    for (const type of ["wheel", "touchstart", "mousedown"]) {
      reader.addEventListener(type, () => ui && (ui.userScrolled = true), { passive: true });
    }
    ui.posKey = articleKey();
    restorePosition();
    window.addEventListener("message", onEmbedMessage);
    reader.addEventListener("mousemove", (e) => {
      if (e.clientY < 90) reader.classList.remove("controls-hidden");
    });

    // Keyboard: Esc closes Reader (an open Aa menu or enlarged image first),
    // Ctrl/Cmd +/-/0 change text size.
    const onEscape = () => {
      if (!pop.popover.hidden) setPopover(false);
      else close();
    };
    ui.onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.type === "keyup") {
        // Esc normally acts on keydown. Act on keyup only if the page's own
        // key handlers swallowed the keydown before Reader saw it.
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (ui.escSeen) ui.escSeen = false;
        else if (ui.lightboxOpen) closeLightbox();
        else onEscape();
        return;
      }
      if (e.key === "Escape") ui.escSeen = true;
      else ui.userScrolled = true; // arrows / Space / PageDown: the reader is moving on their own
      if (ui.lightboxOpen) {
        if (e.key === "Escape") closeLightbox();
        else if (e.key === "ArrowLeft") stepLightbox(-1);
        else if (e.key === "ArrowRight") stepLightbox(1);
        else if (e.key !== "Tab") return void e.stopImmediatePropagation();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onEscape();
        return;
      }
      if (mod && !e.altKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        changeSize(1);
      } else if (mod && !e.altKey && e.key === "-") {
        e.preventDefault();
        changeSize(-1);
      } else if (mod && !e.altKey && e.key === "0") {
        e.preventDefault();
        changeSize(0);
      }
      // Keep the page's own keyboard shortcuts from firing underneath Reader.
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", ui.onKey, true);
    window.addEventListener("keyup", ui.onKey, true);

    // Enter animation, then focus so Space / arrows / PageDown scroll the article.
    // If an embedded frame (video, ad) had focus, keys would go there and never reach Reader.
    requestAnimationFrame(() => requestAnimationFrame(() => reader.classList.remove("entering")));
    if (document.activeElement && document.activeElement.tagName === "IFRAME") document.activeElement.blur();
    // Some browsers (e.g. Dia) leave keyboard focus on their toolbar after the button is
    // clicked, so Esc never reaches the page. Ask for focus back; browsers may ignore this.
    try {
      window.focus();
    } catch {}
    reader.focus({ preventScroll: true });
    notifyState(true);

    // Pull in the rest of a multi-page article in the background.
    const firstText = norm(built.content.textContent).slice(0, 200);
    // Then summarize the whole article (all pages).
    const session = ui;
    appendFollowingPages(article.title, firstText)
      .catch((err) => {
        console.warn("Reader: could not load following pages", err);
        setPageLoader("");
      })
      .then(() => {
        // The saved spot may be on a page that only just arrived.
        if (ui === session && ui.posPending && !ui.userScrolled && applyPosition(ui.posPending)) ui.posPending = null;
      })
      .then(() => ui === session && startSummary())
      .catch((err) => console.warn("Reader: summary failed", err));
  }

  function close() {
    if (!ui) return;
    clearTimeout(ui.posTimer);
    savePosition();
    const { host, reader, prev, printStyle, onKey, onResize, resizeObserver } = ui;
    ui = null;

    window.removeEventListener("message", onEmbedMessage);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    window.removeEventListener("resize", onResize);
    resizeObserver.disconnect();
    reader.classList.add("leaving");

    const finish = () => {
      if (pendingFinish === finish) pendingFinish = null;
      host.remove();
      printStyle.remove();
      document.documentElement.style.setProperty("overflow", prev.htmlOverflow, prev.htmlPriority);
      if (document.body) document.body.style.setProperty("overflow", prev.bodyOverflow, prev.bodyPriority);
      if (prev.activeElement && prev.activeElement.focus) prev.activeElement.focus({ preventScroll: true });
    };
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    pendingFinish = finish;
    reduced ? finish() : setTimeout(() => pendingFinish === finish && finish(), 220);
    notifyState(false);
  }

  window.__readerView = {
    open,
    close,
    isOpen: () => !!ui || !!opening,
    // Clicking the button again while Reader is still opening cancels it.
    toggle: () => (ui ? close() : opening ? void (opening.cancelled = true) : open()),
  };
})();
