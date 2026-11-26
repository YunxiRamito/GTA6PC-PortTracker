'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = 'release-manifest.json';
const allowlist = [
  '.gitattributes', '.gitignore', 'README.md', 'about.html', 'app.js', 'feedback.html',
  'index.html', 'package.json', 'preview.js', 'server.js', 'site-assets.js',
  'styles.css', 'thanks.css', 'thanks.html', 'thanks.js',
  'docs/localization.md', 'docs/sync.md',
  'admin/account.js', 'admin/admin.css', 'admin/admin.js', 'admin/avatar.js',
  'admin/danmaku.js', 'admin/rank-tags.js', 'admin/feedback.css', 'admin/feedback.html', 'admin/feedback.js',
  'admin/index.html', 'admin/login.css', 'admin/login.html', 'admin/login.js',
  'admin/router.js', 'admin/shell.js', 'admin/sponsors.css', 'admin/sponsors.html', 'admin/sponsors.js',
  'api/_admin-accounts.js', 'api/_admin-auth.js', 'api/_content-locale.js', 'api/_content.js',
  'api/_danmaku-community-mutes.js', 'api/_danmaku-filter.js', 'api/_danmaku-history.js',
  'api/_danmaku-mutes.js', 'api/_danmaku-nonces.js', 'api/_danmaku-rank-grants.js', 'api/_danmaku-scheduled.js',
  'api/_danmaku-settings.js', 'api/_danmaku-words.js', 'api/_danmaku.js', 'api/_feedback.js',
  'api/_progress-history.js', 'api/_rss.js', 'api/_sponsors.js', 'api/_traffic-events.js',
  'api/_traffic-history.js', 'api/dashboard.js', 'api/preview-dashboard.js', 'api/traffic.js',
  'assets/danmaku-mount.js', 'assets/danmaku-translate.js', 'assets/danmaku.css', 'assets/danmaku.js', 'assets/feedback.css', 'assets/feedback.js',
  'assets/about.css', 'assets/chapters.css', 'assets/dashboard.css', 'assets/demo.css', 'assets/demo.js',
  'assets/hero-opening.css', 'assets/i18n-home.js', 'assets/i18n-pages.js', 'assets/i18n-widgets.js', 'assets/i18n.css', 'assets/i18n.js',
  'assets/motion.js', 'assets/navigation.js', 'assets/port-score.js',
  'assets/progress-motion.css', 'assets/project-progress.js', 'assets/site-content.js', 'assets/site-topbar.css',
  'assets/site-widgets.css', 'assets/traffic-history.js', 'assets/traffic.js',
  'assets/ui/Fluent-LICENSE.txt', 'assets/ui/OFL-Barlow.txt', 'assets/ui/OFL-BarlowCondensed.txt', 'assets/ui/Octicons-LICENSE.txt',
  'assets/ui/barlow-400-latin.woff2', 'assets/ui/barlow-700-latin.woff2',
  'assets/ui/barlow-condensed-700-latin.woff2', 'assets/ui/barlow-condensed-900-latin.woff2',
  'assets/ui/fluent.svg', 'assets/ui/octicons.svg', 'assets/vendor/Lenis-LICENSE.txt', 'assets/vendor/lenis.min.js',
  'docs/demo-screenshot.png', 'docs/provenance.md', 'fixtures/demo.js',
  'scripts/bootstrap-account-owner.js', 'test/i18n.test.js', 'test/port-score.test.js', 'test/server.test.js', 'tools/check-release.js', 'tools/sync-core.cjs', 'tools/sync-from-site.cjs',
].sort();
const permitted = new Set([...allowlist, manifest]);
const directories = new Set();
for (const file of allowlist) {
  const parts = file.split('/');
  for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join('/'));
}

const privateBrand = ['rami', 'rinko'].join('');
const sensitive = [
  ['project identity', new RegExp(privateBrand, 'gi')],
  ['private key block', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g],
  ['token-shaped value', /\b(?:github_pat_[a-z0-9_]{20,}|gh[pousr]_[a-z0-9]{24,}|AKIA[A-Z0-9]{16}|xox[baprs]-[a-z0-9-]{12,}|sk-(?:proj-)?[a-z0-9_-]{20,})\b/gi],
  ['literal credential', /(?:^|[,{;]|\b(?:const|let|var)\s+)[ \t]*["']?\b(?:password|secret|api[_-]?key|access[_-]?token|admin[_-]?token)\b["']?[ \t]*[:=][ \t]*["'][^\s"']{12,}["']/gim],
  ['service connection string', /\b(?:ssh|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'`]+/gi],
  ['peer-to-peer locator', /magnet:\?xt=|urn:btih\x3a/gi],
  ['original media path', /\/assets\/(?:art|audio|logos)\//gi],
  ['embedded media payload', /data:(?:image|audio)\/[^\s,]+;base64,[A-Z0-9+/]{80,}/gi],
  ['possible personal address', /\b[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi],
];
const markdownHosts = new Set(['127.0.0.1', 'github.com', 'registry.npmjs.org', 'fonts.gstatic.com']);
const namespaceHosts = new Set(['www.w3.org']);
const licenseHosts = new Set(['github.com', 'scripts.sil.org']);
const loopbackHosts = new Set(['127.0.0.1', 'localhost']);

function permittedHost(file, host) {
  if (namespaceHosts.has(host)) return true;
  if (file === 'README.md' || file === 'docs/provenance.md') return markdownHosts.has(host);
  if (/^assets\/ui\/OFL-.*\.txt$/.test(file)) return licenseHosts.has(host);
  if (file === 'api/dashboard.js') return host === 'api.github.com' || host === 'github.com';
  if (file === 'assets/navigation.js') return host === 'github.com' || loopbackHosts.has(host);
  if (file === 'assets/navigation.js') return host === 'github.com' || loopbackHosts.has(host);
  if (file.startsWith('tools/sync-')) return ['api.github.com', 'github.com', '127.0.0.1'].includes(host);
  return loopbackHosts.has(host);
}

function list(relative = '') {
  const found = [];
  for (const entry of fs.readdirSync(path.resolve(root, relative), { withFileTypes: true })) {
    if (!relative && entry.isDirectory() && !entry.isSymbolicLink() && (entry.name === '.git' || entry.name === '.preview')) continue;
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), `Unexpected link: ${file}`);
    if (entry.isDirectory() && directories.has(file)) found.push(...list(file));
    else if (entry.isFile() && permitted.has(file)) found.push(file);
    else throw new Error(`Outside release allowlist: ${file}`);
  }
  return found;
}

function scanPng(bytes) {
  assert(bytes.length < 4 * 1024 * 1024 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid README screenshot');
  const permittedChunks = new Set(['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'iCCP']);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    assert(permittedChunks.has(type), `Screenshot has unreviewed PNG chunk ${type}`);
    offset += size + 12;
    assert(offset <= bytes.length, 'Invalid screenshot chunk length');
    if (type === 'IEND') {
      assert(offset === bytes.length, 'Unexpected data after screenshot');
      return;
    }
  }
  throw new Error('Screenshot has no PNG end marker');
}

function scan(file) {
  const data = fs.readFileSync(path.join(root, file));
  if (file === 'docs/demo-screenshot.png') {
    scanPng(data);
    return data;
  }
  if (file.endsWith('.woff2')) {
    assert.equal(data.toString('ascii', 0, 4), 'wOF2', `Unexpected font format: ${file}`);
    return data;
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/\r\n/g, '\n');
  function flag(category, offset) {
    throw new Error(`${file}:${text.slice(0, offset).split('\n').length} ${category}`);
  }
  for (const [category, pattern] of sensitive) {
    const first = text.matchAll(pattern).next().value;
    if (first) flag(category, first.index);
  }
  for (const match of text.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+)(?=[\s/?#:'"`)>]|$)/gi)) {
    if (!permittedHost(file, match[1].toLowerCase())) flag('Unreviewed endpoint', match.index);
  }
  return text;
}

function main() {
  const seal = process.argv[2] === '--seal';
  if (process.argv.length > 2 && !seal) throw new Error('Use node tools/check-release.js [--seal]');
  const actual = new Set(list());
  for (const file of allowlist) assert(actual.has(file), `Missing release file: ${file}`);
  const files = Object.fromEntries(allowlist.map(file => [file, createHash('sha256').update(scan(file)).digest('hex')]));
  if (seal) fs.writeFileSync(path.join(root, manifest), JSON.stringify({ algorithm: 'sha256', files }, null, 2) + '\n');
  else {
    const saved = JSON.parse(fs.readFileSync(path.join(root, manifest), 'utf8'));
    assert.equal(saved.algorithm, 'sha256');
    assert.deepEqual(Object.keys(saved.files), allowlist, 'Manifest does not match file allowlist');
    for (const file of allowlist) assert(saved.files[file] === files[file], `Changed since sealed: ${file}`);
  }
  console.log(`${allowlist.length} release files passed path, endpoint, sensitive-content, and integrity checks.`);
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
