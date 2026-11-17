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
