// Automated checks. Loads the extension into Chromium and uses it the way a person would:
// on the test pages in this folder and, optionally, on real websites.
//
//   npm install --no-save playwright && npx playwright install chromium     (once)
//   node test/check.js                      the test pages
//   node test/check.js --sites urls.txt     real pages too (one address per line): for each,
//                                           how much of the page's visible article Reader shows
//
// Exits with status 1 if a check fails.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HOST_ID = "__reader-view-host";
const TYPES = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name);
  const extra = detail === undefined ? "" : "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : extra}`);
}

// Serves the repository. "?csp" adds a strict Content-Security-Policy with Trusted Types.
function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const headers = { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" };
    if (url.searchParams.has("csp")) {
      headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'none'; require-trusted-types-for 'script'";
    }
    res.writeHead(200, headers);
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/test/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "reader-view-check-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1360, height: 900 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles", // west of Greenwich, for the date check
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  // The pages load a manual-testing harness that would open a second Reader; leave it out.
  await ctx.route("**/harness.js*", (route) => route.abort());
  const worker = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));

  // What clicking the toolbar button does, for the tab showing this page.
  const press = (page) =>
    worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
      await runReader(tab.id, "toggle");
    }, page.url());
  const button = (page) =>
    worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
      return { enabled: await chrome.action.isEnabled(tab.id), title: await chrome.action.getTitle({ tabId: tab.id }) };
    }, page.url());
  // Run code inside Reader: `root` is its shadow root, `reader` the scrolling pane, `content` the article.
  const inReader = (page, body) =>
    page.evaluate(`(() => { const host = document.getElementById("${HOST_ID}"); const root = host && host.shadowRoot;
      const reader = root && root.querySelector(".reader"); const content = root && root.querySelector(".content"); ${body} })()`);
  const isOpen = (page) => inReader(page, "return !!content;");
  const text = (page) => inReader(page, 'return content ? content.textContent.replace(/\\s+/g, " ").trim() : "";');
  const pause = (page, ms) => page.waitForTimeout(ms);

  async function visit(name, wait = 1000) {
    const page = await ctx.newPage();
    await page.goto(/^https?:/.test(name) ? name : base + name, { waitUntil: "domcontentloaded", timeout: 45000 });
    await pause(page, wait);
    return page;
  }
  async function openReader(name, wait) {
    const page = await visit(name, wait);
    await press(page);
    await page.waitForFunction((id) => document.getElementById(id)?.shadowRoot?.querySelector(".content, .toast"), HOST_ID, { timeout: 10000 }).catch(() => {});
    await pause(page, 500);
    return page;
  }

  // ---------- what Reader shows ----------
  let page = await openReader("hidden-dialog-article.html");
  let t = await text(page);
  check("hidden cookie panel: the article is shown", t.includes("first crossing in a decade") && t.includes("hourly at weekends"), t.slice(0, 120));
  check("hidden cookie panel: its text is not", !/store cookies|Consent Preferences/.test(t));
  await page.close();

  page = await openReader("split-article.html");
  t = await text(page);
  check("article cut into blocks: starts at the first paragraph", t.indexOf("Opening the keynote") >= 0 && t.indexOf("Opening the keynote") < 60, t.slice(0, 120));
  check("article cut into blocks: every block is there", ["All about agents", "loudest applause", "Governance over trust", "keynote forgotten"].every((s) => t.includes(s)));
  check("article cut into blocks: the ad label is not", !/Advertisement/.test(t));
  await page.close();

  page = await openReader("words-article.html");
  t = await text(page);
  check("short opening paragraphs are kept", t.includes("It was over.") && t.includes("Or so everyone thought."));
  check("words inside sentences are kept", t.includes("company's advertising business") && t.includes("the Premium tier") && t.includes("has Prime placement"), t.slice(0, 200));
  check("sentences that start like a promo are kept", t.includes("Subscribers who joined before March") && t.includes("Most popular among the new features"));
  const headings = await inReader(page, 'return [...content.querySelectorAll("h2")].map((h) => h.textContent.trim());');
  check('sections named "Exclusive" and "Share" are kept, without their "edit" links', headings.includes("Exclusive") && headings.includes("Share") && !/edit/.test(t), headings);
  check('"Copy link" is removed from a heading', headings.includes("Copy link test"), headings);
  check("table of contents lists the sections", (await inReader(page, 'return root.querySelectorAll(".toc li").length;')) === 3);
  check("a list of links to other sites is kept", t.includes("The annual report") && t.includes("The university study"));
  const meta = await inReader(page, 'return root.querySelector(".meta").textContent;');
  check("a date without a time shows the day it names", meta.includes("May 1, 2024"), meta);
  await page.close();

  page = await openReader("other-story-article.html");
  t = await text(page);
  check("another story's text is not shown under this headline", t.includes("voted on Tuesday") && !t.includes("OTHER STORY"), t.slice(0, 120));
  await page.close();

  page = await openReader("paywall-article.html");
  t = await text(page);
  check("text revealed on screen is shown", t.includes("retired engineers") && t.includes("return the following month"));
  check('ad labels are removed ("Ad Feedback", "Advertisement")', !/Ad Feedback|Advertisement/.test(t));
  check("lead photo is shown", await inReader(page, 'return !!content.querySelector(".lead-media img");'));
  await page.close();

  page = await openReader("review-article.html");
  check("review: pros and cons box", (await inReader(page, 'return content.querySelectorAll(".procon").length;')) >= 1);
  check(
    "a site's own video player becomes a video with its poster",
    await inReader(page, 'const v = content.querySelector("video[data-rv-stream$=\'master.m3u8\']"); return !!v && /town\\.svg/.test(v.poster);')
  );
  await page.close();

  page = await openReader("chart-article.html");
  const embeds = await inReader(page, 'return [...content.querySelectorAll("iframe")].map((f) => f.dataset.rvEmbed + " " + f.title);');
  check("a Datawrapper chart among the paragraphs is shown, with its name", embeds.includes("chart Inflation by month"), embeds);
  check("a video in a sidebar aside is not", !embeds.some((e) => e.startsWith("video")), embeds);
  const drawn = await inReader(page, `const f = content.querySelector("figure[data-rv-chart]"); if (!f) return null;
    const plot = f.querySelector("svg svg"); const bar = plot && plot.querySelector("rect");
    return { title: f.textContent.includes("Monthly inflation"), y: plot && plot.getAttribute("y"), fill: bar && getComputedStyle(bar).fill };`);
  check("a chart drawn on the page is shown, its layers together and in its colours",
    !!drawn && drawn.title && drawn.y === "30" && drawn.fill === "rgb(0, 160, 136)", drawn);
  await page.close();

  page = await openReader("images-article.html");
  const photos = await inReader(page, 'return [...content.querySelectorAll("img")].map((i) => i.getAttribute("src"));');
  check("photos that load as you scroll are shown", ["hills-1400.svg", "town.svg", "coast-large.svg"].every((f) => photos.some((s) => s.endsWith("img/" + f))) && !photos.some((s) => s.startsWith("data:")), photos);
  check("a picture the site has in desktop and mobile copies is shown once", photos.filter((s) => s.endsWith("?series")).length === 1);
  check("a membership box inside the article is removed", !/not a member yet|Cancel anytime/.test(await text(page)));
  await page.close();
  page = await openReader("code-article.html");
  check("code blocks with a Copy button", (await inReader(page, 'return content.querySelectorAll(".code-block .code-copy").length;')) >= 3);
  await page.close();

  page = await openReader("security-article.html");
  const hostile = await inReader(
    page,
    `return { ran: window.__pwned || null,
      handlers: [...content.querySelectorAll("*")].filter((n) => [...n.attributes].some((a) => /^on/i.test(a.name))).length,
      scripts: content.querySelectorAll("script, object, embed, iframe[srcdoc], animate").length,
      addresses: [...content.querySelectorAll("[href], [src]")].filter((n) => /^(java|vbscript|data:text)/i.test((n.getAttribute("href") || n.getAttribute("src")).replace(/[\\u0000-\\u0020]/g, ""))).length };`
  );
  check("hostile page: nothing that can run reaches Reader", !hostile.ran && !hostile.handlers && !hostile.scripts && !hostile.addresses, hostile);
  await inReader(page, 'content.querySelectorAll("a").forEach((a) => { if (!/^https?:/.test(a.getAttribute("href") || "")) a.click(); });');
  await pause(page, 300);
  check("hostile page: clicking its links runs nothing", (await page.evaluate(() => window.__pwned || null)) === null);
  await page.close();

  page = await openReader("sample-article.html?csp");
  check("opens, styled, on a page with a strict security policy", (await isOpen(page)) && (await inReader(page, 'return getComputedStyle(reader).position === "fixed" && content.textContent.length > 1000;')));
  await page.close();

  page = await openReader("multipage/garden-guide.html", 1000);
  await pause(page, 2500);
  check("three-page article is joined into one", (await inReader(page, 'return [...content.querySelectorAll(".page-part")].map((p) => p.dataset.page).join();')) === "2,3");
  await page.close();

  // ---------- how Reader behaves ----------
  page = await visit("sample-article.html", 1500);
  check("button lights up on an article", (await button(page)).enabled);
  await page.evaluate(() => (document.body.style.overflow = "scroll"));
  await press(page);
  await pause(page, 1200);
  check("button opens Reader and offers to hide it", (await isOpen(page)) && /Hide Reader/.test((await button(page)).title));
  check("headline without the site's name", (await inReader(page, 'return root.querySelector(".title").textContent;')) === "The Quiet Return of the Night Train");
  await page.keyboard.press("Escape");
  await pause(page, 600);
  check("Esc closes Reader", !(await isOpen(page)));
  check("the page is left exactly as it was", await page.evaluate(() => document.body.style.overflow === "scroll" && document.documentElement.style.overflow === "" && !document.getElementById("__reader-view-print")));
  for (let i = 0; i < 5; i++) {
    press(page).catch(() => {});
    await pause(page, 60);
  }
  await pause(page, 1800);
  const after = await page.evaluate((id) => ({ readers: document.querySelectorAll("#" + id).length, scroll: document.documentElement.style.overflow }), HOST_ID);
  check("five quick clicks end open or closed, never in between", (after.readers === 1 && after.scroll === "hidden") || (after.readers === 0 && after.scroll === ""), after);
  if (!(await isOpen(page))) {
    await press(page);
    await pause(page, 1000);
  }
  await page.keyboard.press("Control+=");
  await page.keyboard.press("Control+=");
  await inReader(page, 'root.querySelector(".swatch-night").click();');
  await pause(page, 700);
  const saved = await worker.evaluate(() => chrome.storage.sync.get(["zoom", "theme"]));
  check("zoom and theme are applied and saved", saved.zoom === 125 && saved.theme === "night" && (await inReader(page, 'return reader.classList.contains("theme-night");')), saved);
  await page.close();

  page = await openReader("images-article.html");
  check("settings carry over to the next article", await inReader(page, 'return reader.classList.contains("theme-night") && root.querySelector(".zoom-label").textContent === "125%";'));
  await page.keyboard.press("Control+0");
  check("Ctrl+0 resets the zoom", (await inReader(page, 'return root.querySelector(".zoom-label").textContent;')) === "100%");
  await inReader(page, 'content.querySelector("img").click();');
  const first = await inReader(page, 'return root.querySelector(".lightbox").hidden ? "" : root.querySelector(".lb-img").src;');
  await page.keyboard.press("ArrowRight");
  await pause(page, 150);
  check("a photo enlarges, and the arrow key moves to the next", !!first && (await inReader(page, 'return root.querySelector(".lb-img").src;')) !== first);
  await page.keyboard.press("Escape");
  await pause(page, 200);
  check("Esc closes the photo first, Reader stays", (await inReader(page, 'return root.querySelector(".lightbox").hidden;')) && (await isOpen(page)));
  await page.close();

  page = await openReader("embeds-article.html");
  const where = 'const y = reader.getBoundingClientRect().top + 70; return [...content.querySelectorAll("p")].find((p) => p.getBoundingClientRect().bottom > y)?.textContent.slice(0, 40);';
  await inReader(page, "reader.scrollTop = 900;");
  await pause(page, 900);
  const reading = await inReader(page, where);
  await page.keyboard.press("Escape");
  await pause(page, 600);
  await press(page);
  await pause(page, 1500);
  check("reopening returns to the paragraph being read", !!reading && (await inReader(page, where)) === reading, reading);
  const pdf = await page.pdf({ format: "A4" });
  const sheets = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  check("printing gives the whole article, not just the first sheet", sheets >= 2, `${sheets} sheet(s)`);
  await pause(page, 300);
  check("Reader is back in place after printing", await page.evaluate((id) => getComputedStyle(document.getElementById(id)).position === "fixed" && document.documentElement.style.overflow === "hidden", HOST_ID));
  await page.close();

  page = await openReader("sample-article.html");
  await inReader(page, 'root.querySelector(".ctrl.aa").click(); root.querySelector(".auto input").click();');
  await pause(page, 500);
  await page.reload({ waitUntil: "load" });
  await pause(page, 2500);
  check('"Use Reader automatically" opens Reader on the next visit', await isOpen(page));
  await page.keyboard.press("Escape");
  await pause(page, 600);
  await page.evaluate(() => (location.hash = "#somewhere"));
  await pause(page, 5500);
  check("after closing it, a jump within the page does not reopen it", !(await isOpen(page)));
  await page.close();

  // ---------- real websites ----------
  const sitesAt = process.argv.indexOf("--sites");
  if (sitesAt > 0) {
    const urls = fs.readFileSync(process.argv[sitesAt + 1], "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:/.test(s));
    console.log(`\nReal pages (${urls.length}). "Shown" = how many of the page's visible article paragraphs are in Reader.\n`);
    for (const url of urls) {
      let line = "";
      try {
        page = await visit(url, 4500);
        const lit = (await button(page)).enabled;
        await press(page);
        await page.waitForFunction((id) => document.getElementById(id)?.shadowRoot?.querySelector(".content, .toast"), HOST_ID, { timeout: 15000 }).catch(() => {});
        await pause(page, 1500);
        const r = await inReader(
          page,
          `if (!content) return null;
          const loose = (s) => (s || "").toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, "");
          const shown = loose(content.textContent);
          const articles = document.querySelectorAll("article");
          const region = articles.length === 1 ? articles[0] : document.querySelector('main, [role="main"]') || document.body;
          const paras = [...region.querySelectorAll("p")].filter((p) => p.getClientRects().length && p.textContent.trim().length > 100 &&
            !p.closest('nav, footer, aside, [role="dialog"], [class*="comment" i], [class*="related" i], [class*="newsletter" i]'));
          const missing = paras.filter((p) => !shown.includes(loose(p.textContent).slice(0, 50)));
          return { paras: paras.length, missing: missing.length, example: missing[0] ? missing[0].textContent.trim().slice(0, 60) : "",
            title: root.querySelector(".title").textContent.trim().slice(0, 50), chars: content.textContent.length,
            headings: content.querySelectorAll("h2, h3").length, images: content.querySelectorAll("img").length };`
        );
        if (!r) line = `NO READER  button ${lit ? "lit" : "grey"}`;
        else {
          const pct = r.paras ? Math.round((100 * (r.paras - r.missing)) / r.paras) : 100;
          line = `${pct < 80 ? "LOOK     " : "ok       "} shown ${String(pct).padStart(3)}% of ${String(r.paras).padStart(3)}  ${String(r.chars).padStart(6)} chars  ${r.headings} headings  ${r.images} images  button ${lit ? "lit " : "grey"}  "${r.title}"${r.missing ? `  missing e.g. "${r.example}"` : ""}`;
        }
        await page.close();
      } catch (err) {
        line = "ERROR     " + String(err.message).split("\n")[0].slice(0, 100);
        await page.close().catch(() => {});
      }
      console.log(`${line}\n          ${url}`);
    }
  }

  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ":\n  - " + failures.join("\n  - ") : ""}`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
