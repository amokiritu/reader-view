// Copies Mozilla's Readability (Apache-2.0) into vendor/ so the extension can load it directly.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkgDir = path.dirname(require.resolve("@mozilla/readability/package.json", { paths: [root] }));
const destDir = path.join(root, "vendor");
fs.mkdirSync(destDir, { recursive: true });

for (const [from, to] of [
  ["Readability.js", "Readability.js"],
  ["Readability-readerable.js", "Readability-readerable.js"],
  ["LICENSE.md", "Readability-LICENSE.md"],
]) {
  fs.copyFileSync(path.join(pkgDir, from), path.join(destDir, to));
  console.log(`Copied ${from} -> vendor/${to}`);
}

// hls.js (Apache-2.0) plays the streaming videos (.m3u8) that sites' own players use, which
// Chromium can't play by itself. Reader loads it only on articles that have one.
const hlsDir = path.dirname(require.resolve("hls.js/package.json", { paths: [root] }));
const hls = fs.readFileSync(path.join(hlsDir, "dist", "hls.light.min.js"), "utf8").replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, "\n");
fs.writeFileSync(path.join(destDir, "hls.light.min.js"), hls);
fs.copyFileSync(path.join(hlsDir, "LICENSE"), path.join(destDir, "hls-LICENSE"));
console.log("Copied hls.js -> vendor/hls.light.min.js");
