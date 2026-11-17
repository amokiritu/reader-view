// Fetches code that an article only references: GitHub Gists, and Medium's embed pages
// (/media/<id>), which wrap a Gist or a video. Runs in the background worker so page security
// rules can't block it; the test harness loads it directly.

const GIST_RE = /gist\.github\.com\/(?:([\w-]+)\/)?([0-9a-f]{7,40})(?:\.js(?:on)?)?(?:\?file=([^"'&\s<>]+))?/i;
const VIDEO_RE = /https:\/\/(?:www\.)?(?:youtube(?:-nocookie)?\.com\/embed\/[\w-]{11}|player\.vimeo\.com\/video\/\d+)/i;
const WATCH_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/i;

// pageUrl: the article's address. Medium embed pages are only fetched from the article's own
// site (or medium.com), never from an address that points elsewhere.
async function resolveCode(url, pageUrl) {
  let u, page;
  try {
    u = new URL(url);
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  let gist = u.hostname === "gist.github.com" ? GIST_RE.exec(u.href) : null;
  if (!gist) {
    const sameSite = u.origin === page.origin || u.hostname === "medium.com";
    if (!sameSite || !/\/media\/[0-9a-f]{16,}/i.test(u.pathname)) return null;
    let html;
    try {
      const res = await fetch(u.href, { credentials: "omit" });
      if (!res.ok) return null;
      html = await res.text();
    } catch {
      return null;
    }
    // Embed addresses are often URL-encoded inside an embed service's link.
    html += "\n" + html.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    gist = GIST_RE.exec(html);
    if (!gist) {
      const video = VIDEO_RE.exec(html);
      if (video) return { embed: video[0] };
      const watch = WATCH_RE.exec(html);
      return watch ? { embed: `https://www.youtube.com/embed/${watch[1]}` } : null;
    }
  }
  const [, user, id, file] = gist;
  return { gist: await fetchGist(id, user, file ? decodeURIComponent(file) : "") };
}

async function fetchGist(id, user, file) {
  const page = `https://gist.github.com/${user ? user + "/" : ""}${id}`;
  // GitHub's API gives each file's text and language (60 requests an hour without signing in).
  try {
    const res = await fetch(`https://api.github.com/gists/${id}`, {
      credentials: "omit",
      headers: { Accept: "application/vnd.github+json" },
    });
    if (res.ok) {
      const j = await res.json();
      let files = Object.values(j.files || {}).map((f) => ({ name: f.filename || "", lang: f.language || "", code: f.content || "" }));
      if (file) {
        const pick = files.filter((f) => f.name === file || f.name.toLowerCase() === file.toLowerCase());
        if (pick.length) files = pick;
      }
      return { url: j.html_url || page, files };
    }
  } catch {}
  // Over the limit: fall back to the Gist's own embed HTML, which Reader turns into code.
  try {
    const res = await fetch(`${page}.json${file ? "?file=" + encodeURIComponent(file) : ""}`, { credentials: "omit" });
    if (res.ok) {
      const j = await res.json();
      if (j.div) return { url: page, html: j.div };
    }
  } catch {}
  return { url: page, failed: true };
}
