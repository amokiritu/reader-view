# Reader View (Chrome extension)

A Safari-Reader-style reading mode for Chrome (Manifest V3).

## Install (developer mode)

1. `npm install` (copies Mozilla Readability into `vendor/`)
2. Open `chrome://extensions`, turn on **Developer mode**
3. **Load unpacked** → pick this folder (`C:\Dev\ReaderView`)
4. Pin the extension to the toolbar

## How it behaves

- The toolbar button is greyed out unless the page looks like an article (`src/detect.js`).
- Click it or press **Alt+Shift+R** to show/hide Reader. The icon turns blue while Reader is on,
  and uses light lines when the browser is in dark mode (like Safari's Reader button).
- **Aa** menu: zoom level (50%–300%, click the percentage to reset), White / Sepia / Gray /
  Night themes, 8 fonts, and "Use Reader automatically on this site".
- **Summary** at the top of the right-hand panel for longer articles (500+ words), made with
  Chrome's free built-in on-device AI (Summarizer API / Gemini Nano). Nothing leaves the
  computer. If the model isn't downloaded yet, a button offers the one-time download. Where
  Chrome can't run it, Reader shows the article's key sentences instead (labelled as such).
  AI summaries are cached per article in `chrome.storage.local`.
  Check your PC's support at `chrome://on-device-internals`.
- **Table of Contents** panel on the right for articles with two or more sections; click an
  entry to jump there. Toggle it with the sidebar button. It hides itself in narrow windows.
- **Multi-page articles** are joined into one page: Reader follows the site's "next page"
  links (same article only) and appends pages 2, 3, … (up to 10).
- **Embedded videos and posts** stay in the article: YouTube (including "click to play"
  placeholders), Vimeo, X posts and Bluesky posts. Posts size themselves like on the page;
  an X post the page hadn't loaded yet appears as a text card. Ad and widget frames are dropped.
- **Code** stays readable: GitHub Gists (including Medium's, which most reader modes lose) become
  code blocks, fetched from GitHub when the page hadn't loaded them yet. Site code blocks lose
  line numbers and highlighting markup. Each block shows its language or file name and has a
  **Copy** button.
- **Reading position** is remembered per article: reopen Reader and it returns to the paragraph
  you were on (even at a different zoom, font or window size, and on later pages of a multi-page
  article). Finishing the article or scrolling back to the top forgets it. Changing the zoom or
  font keeps your place. Kept for the last 300 articles in `chrome.storage.local`.
- **Click an image** to enlarge it in place (uses the full-size file when the site links to one
  or offers a larger `srcset`). ← / → move between images; Esc or a click closes it.
- **Ctrl/Cmd + = / − / 0** change zoom while in Reader. **Esc** closes Reader (or, if the Aa menu
  or an enlarged image is open, closes that first), even when the side panel is open.
- **Ctrl+P** while in Reader prints only the article.
- Reader shows what's visible on the page. It never unlocks paywalled text by itself.
- Settings sync through `chrome.storage.sync`.

## Layout

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `src/background.js` | Toolbar button state, injects Reader on click |
| `src/detect.js` | Runs on every page; checks whether it's readable, handles auto-Reader |
| `src/reader.js` | Extracts the article (Readability) and renders the overlay in a shadow DOM |
| `src/code-fetch.js` | Background helper: fetches Gists (GitHub API) and Medium embed pages |
| `src/reader.css` | Reader typography, themes, Aa popover |
| `vendor/` | Mozilla Readability (Apache-2.0), copied by `npm install` |
| `test/` | Dev harness: `python -m http.server 8766` then open `/test/sample-article.html` (or `embeds-article.html`, `code-article.html`, `paywall-article.html`, `images-article.html`, `multipage/garden-guide.html`). Add `?mockai=available` or `?mockai=downloadable` to fake Chrome's on-device AI |

## Notes

- Mac-only fonts (Athelas, Charter, Iowan, Seravek, San Francisco) fall back to close
  Windows fonts when not installed.
- After editing files, click the reload icon on the extension card in `chrome://extensions`
  and refresh the tab.
