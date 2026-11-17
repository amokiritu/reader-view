// Builds the zip people download from GitHub Releases: only the files the extension needs,
// taken from the last commit (so the zip always matches what's on GitHub).
//   npm run package   ->  dist/reader-view-v<version>.zip
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.version !== version) {
  console.error(`Version mismatch: manifest.json ${version}, package.json ${pkg.version}`);
  process.exit(1);
}

const dirty = execFileSync("git", ["status", "--porcelain", "--", "manifest.json", "src", "icons", "vendor", "LICENSE"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (dirty) console.warn("Warning: uncommitted changes are NOT included in the zip:\n" + dirty);

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
const out = path.join("dist", `reader-view-v${version}.zip`);
execFileSync("git", ["archive", "--format=zip", "-o", out, "HEAD", "manifest.json", "src", "icons", "vendor", "LICENSE"], {
  cwd: root,
  stdio: "inherit",
});
console.log(`Built ${out}`);
