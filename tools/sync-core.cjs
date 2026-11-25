'use strict';

function section(text, from, to) {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`Backend source anchor changed: ${from}`);
  return text.slice(start, end);
}

function cut(text, from, to, substitute = '') {
  return text.replace(section(text, from, to), () => substitute);
}

function edit(text, pattern, substitute) {
  if (typeof pattern === 'string' ? !text.includes(pattern) : !pattern.test(text)) {
    throw new Error(`Backend source anchor changed: ${String(pattern)}`);
  }
  if (pattern instanceof RegExp) pattern.lastIndex = 0;
  return text.replace(pattern, substitute);
}

function server(original) {
  const imports = section(original, "const http =", "const {\n  MUSIC_PATH")
    .replace(/^.*require\('\.\/api\/_(?:traffic-mirror|admin-diagnostics|feedback-relay)'\);\n/gm, '');
  const mime = section(original, 'const MIME =', 'const STATIC_FILES').replace(/^.*\.mp3.*\n/m, '');
  const adminFiles = section(original, 'const ADMIN_FILES =', '// 后台页面复用');
  const constants = section(original, 'const MAX_ADMIN_BODY', 'const LOOPBACK_HOST')
    .replace(/^const (?:SESSION_EXCHANGE|SITE_NOTICES_PATH).*\n/gm, '');
  const headers = section(original, 'function staticCacheHeaders(', 'function serveMusicPlaylist(');
  const staticTail = cut(section(original, 'function streamFile(', 'function parseLoopbackOrigin('), "    if (ext === '.mp3') {", '    res.writeHead(200, headers);')
    .replace("function streamFile(res, full, region)", "function streamFile(res, full)")
    .replace('fs.createReadStream(full, region)', 'fs.createReadStream(full)');
  const body = section(original, 'function readJson(', 'function createSiteServers(')
    .replace('function contentReply(res, result)', 'function contentReply(res, result, headers)')
    .replace('{ ETag: result.etag });', '{ ...headers, ETag: result.etag });');
  const startControllers = section(original, '  const adminNonces = ', '  const publicSite =');
  const permission = section(original, '  function browserPermission(', '  function exchangeCors(');
  const controllers = section(original, '  function accountError(', '  function renderAdminHeader(');
  const sponsors = section(original, '    async getSponsors()', '    traffic,');
  const publicRouter = section(original, '    if (getSponsors && pathname ===', "    if (req.method === 'GET' || req.method === 'HEAD') {")
    .replace(/^.*if \(readMusicPlaylist && pathname === MUSIC_PATH\).*\n/m, '')
    .replace('event-stream', 'event-stream');

  return `// Loopback entry point for the public-source edition of the site.
'use strict';

${imports}const { createFixtures } = require('./fixtures/demo');
const { PUBLIC_ASSETS, PUBLIC_PAGES, PAGE_SECURITY_HEADERS } = require('./site-assets');

const PUBLIC_FEEDBACK_ROUTES = new Set(['/api/feedback', '/api/feedback/replies', '/api/feedback/replies/read', '/api/site-notices']);
const ROOT = __dirname;
const LOOPBACK = '127.0.0.1';
const DEFAULT_PORT = 8787;
const RSS_TIMELINE_LIMIT = 100;
${mime}${adminFiles}${constants}${headers}${staticTail}${body}
function createSiteServer({
  runtimeDir = path.resolve(process.env.GTAVI_RUNTIME_DIR || path.join(ROOT, '.runtime')),
  accounts = null,
  now = Date.now,
  liveGitHub = process.env.GTAVI_GITHUB_REFRESH === '1',
  githubToken = process.env.GTAVI_GITHUB_TOKEN || '',
  store = createContentStore({ filePath: path.join(runtimeDir, 'content.json'), now }),
  dashboard = createDashboard({ now, initial: createFixtures(now()).metadata, liveGitHub, token: githubToken,
    progressHistoryPath: path.join(runtimeDir, 'progress-history.json') }),
  traffic = createTrafficHandler({ filePath: path.join(runtimeDir, 'traffic.json') }),
} = {}) {
  const auth = createAdminAuth({
    accounts, now,
    sessionFile: accounts ? path.join(runtimeDir, 'account-sessions.json') : undefined,
  });
${startControllers}  const danmaku = createDanmaku({
    readJson, sendJson, now,
    getAdminOrigin: req => req ? 'http://' + req.headers.host : null,
    muteFile: path.join(runtimeDir, 'danmaku-mutes.json'),
    communityMuteFile: path.join(runtimeDir, 'danmaku-community-mutes.json'),
    historyFile: path.join(runtimeDir, 'danmaku-history.jsonl'),
    wordFile: path.join(runtimeDir, 'danmaku-words.json'),
    settingsFile: path.join(runtimeDir, 'danmaku-settings.json'),
    scheduledFile: path.join(runtimeDir, 'danmaku-scheduled.json'),
  });
${permission}${controllers}
  const adminHeaders = {
    ...PAGE_SECURITY_HEADERS, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
  };
  async function handleAdmin(req, res, pathname, query) {
    const clientKey = req.socket.remoteAddress;
    const sessionOptions = {
      clientKey, secure: false, sendJson, readJson: request => readJson(request, 4096),
      isAccountBlocked: id => Boolean(danmaku.isManagementAccountMuted?.(id) || danmaku.isDeviceMuted?.(req)),
    };
    const headers = { ...adminHeaders, Connection: 'close' };
    if (pathname === REGISTER_PATH) {
      if (!accounts) return sendJson(res, 503, { error: '请先在本地初始化站长账号。' }, headers);
      if (danmaku.isDeviceMuted(req)) return forbidAdmin(res, { status: 403 }, headers);
      return registerAccount(req, res, clientKey, headers);
    }
    if (pathname === ADMIN_SESSION) {
      if (!accounts) return sendJson(res, 503, { accountMode: true, error: '请先在本地初始化站长账号。' }, headers);
      if (req.method === 'POST' && danmaku.isDeviceMuted(req)) return forbidAdmin(res, { status: 403 }, headers);
      return auth.handleSession(req, res, { ...sessionOptions, headers });
    }
    const accountMatch = /^\\/api\\/admin\\/accounts\\/([a-f0-9-]{36})(?:\\/reset-password)?$/.exec(pathname);
    if (accounts && (pathname === ADMIN_ACCOUNTS || pathname === ACCOUNT_PROFILE || pathname === ACCOUNT_PASSWORD || accountMatch)) {
      return handleAccounts(req, res, pathname, accountMatch?.[1], headers, sessionOptions);
    }
    if (pathname === ADMIN_SPONSORS || pathname === ADMIN_SPONSOR_ACCOUNTS || pathname.startsWith(ADMIN_SPONSOR_ACCOUNTS + '/')) {
      return handleAdminSponsors(req, res, pathname, query, clientKey, headers);
    }
    if (pathname.startsWith(ADMIN_DANMAKU + '/')) {
      return handleAdminDanmaku(req, res, pathname, query, clientKey, headers, null);
    }
    if (ADMIN_FEEDBACK_ROUTE.test(pathname)) {
      const permission = editorialPermission(req, clientKey);
      if (permission.status !== 200) return forbidAdmin(res, permission, headers);
      return feedback.handleAdmin(req, res, pathname, query, headers);
    }
    const contentRoute = /^\\/api\\/admin\\/content(?:\\/([a-z]+))?\\/?$/.exec(pathname);
    if (contentRoute) {
      const permission = browserPermission(req, EDITOR_ROLES);
      if (permission.status !== 200) return forbidAdmin(res, permission, headers);
      const section = contentRoute[1];
      if (req.method === 'GET') return contentReply(res, store.read(section), headers);
      if (req.method !== 'PUT') return sendJson(res, 405, { error: '仅支持 GET 或 PUT' }, { ...headers, Allow: 'GET, PUT' });
      const next = await readJson(req);
      const current = browserPermission(req, EDITOR_ROLES);
      if (current.status !== 200) return forbidAdmin(res, current, headers);
      return contentReply(res, await store.write(next, req.headers['if-match'], section), headers);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const redirect = location => {
        res.writeHead(302, { ...headers, Location: location });
        res.end();
      };
      if (pathname === ADMIN_SPONSOR_PREVIEW) return redirect('/thanks/');
      if (Object.hasOwn(ADMIN_FILES, pathname)) {
        const file = ADMIN_FILES[pathname];
        if (!file.endsWith('.html')) return serveStatic(res, file, req);
        const isLogin = file === 'admin/login.html';
        const signedIn = auth.hasSession(req);
        if (isLogin === signedIn) return redirect(signedIn ? '/admin/' : '/admin/login');
        if (file === 'admin/feedback.html' || file === 'admin/sponsors.html') {
          const permission = browserPermission(req, EDITOR_ROLES);
          if (permission.status !== 200) return forbidAdmin(res, permission, headers);
        }
        const device = req.method === 'GET' ? danmaku.issueBrowserDevice(req) : {};
        return serveHtml(res, file, req, { ...adminHeaders, 'Referrer-Policy': 'same-origin', ...device });
      }
    }
    return sendJson(res, 404, { error: '没有这个后台页面' }, headers);
  }
  return createPublicServer({
${sponsors}    traffic,
    trafficHistoryPath: path.join(runtimeDir, 'traffic-history.json'),
    danmaku,
    feedback: feedback.handlePublic,
    handleAdmin,
    now,
  });
}

function createPublicServer({ getContent, getSponsors, getSponsorAvatar, getDashboard, traffic, trafficHistoryPath, danmaku, feedback, handleAdmin, now }) {
  const history = createTrafficHistory({ filePath: trafficHistoryPath, getSnapshot: traffic.readSnapshot, now });
  const getTrafficHistory = history.read;
  const events = createTrafficEvents({ traffic });
  const publicOrigin = undefined;
  async function dispatch(req, res) {
    const host = req.headers.host;
    const localPort = req.socket.localPort;
    const validHost = host === LOOPBACK + ':' + localPort || host === 'localhost:' + localPort;
    if (!validHost || req.socket.remoteAddress !== LOOPBACK) {
      return sendJson(res, 403, { error: '请使用启动时显示的本地地址。' });
    }
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\\\')) {
      return sendJson(res, 400, { error: '请求路径无效' });
    }
    const origin = 'http://' + host;
    const url = new URL(req.url, origin);
    const pathname = url.pathname;
    const api = pathname.startsWith('/api/');
    if (api && ((req.headers.origin && req.headers.origin !== origin) ||
        (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])))) {
      return sendJson(res, 403, { error: '请从本站访问此接口。' }, { Connection: 'close' });
    }
    if (/^\\/(?:admin|api\\/admin)(?:\\/|$)/.test(pathname)) return handleAdmin(req, res, pathname, url.search.slice(1));
${publicRouter}    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const page = PUBLIC_PAGES.get(pathname);
      if (page) {
        const device = req.method === 'GET' ? danmaku.issueBrowserDevice(req) : {};
        return serveHtml(res, page, req, { ...PAGE_SECURITY_HEADERS, ...device });
      }
      if (PUBLIC_ASSETS.has(pathname)) return serveStatic(res, pathname.slice(1), req);
    }
    return sendJson(res, 404, { error: '没有这个页面' });
  }
  const site = http.createServer((req, res) => {
    dispatch(req, res).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      if (error instanceof ContentError) return sendJson(res, error.status, { error: error.message, details: error.details }, { Connection: 'close' });
      console.error('Local site request failed:', error.code || error.name);
      return sendJson(res, 503, { error: '暂时无法完成请求' }, { Connection: 'close' });
    });
  });
  site.on('listening', () => { danmaku.start(); history.start(); });
  site.on('close', () => { history.stop(); events.close(); void danmaku.close(); });
  site.closeDanmaku = () => danmaku.close();
  return site;
}

async function start() {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const runtimeDir = path.resolve(process.env.GTAVI_RUNTIME_DIR || path.join(ROOT, '.runtime'));
  const filePath = path.join(runtimeDir, 'accounts.json');
  const accounts = fs.existsSync(filePath) ? createAdminAccounts({ filePath }) : null;
  await accounts?.initialize();
  const site = createSiteServer({ runtimeDir, accounts });
  site.listen(port, LOOPBACK, () => {
    const address = 'http://' + LOOPBACK + ':' + site.address().port;
    console.log('GTAVI · ' + address);
    console.log('Console · ' + address + '/admin/');
    if (!accounts) console.log('Initialize the local owner with node scripts/bootstrap-account-owner.js <username>, then restart.');
  });
  const stop = () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    void site.closeDanmaku();
    site.close();
    site.closeIdleConnections?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) start().catch(error => {
  console.error('Unable to start GTAVI:', error.code || error.name);
  process.exitCode = 1;
});

module.exports = { createSiteServer };
`;
}

function content(text) {
  let js = edit(text, "const ROOT = path.join(__dirname, '..');", "const ROOT = path.join(__dirname, '..');\nconst { createFixtures } = require('../fixtures/demo');");
  js = cut(js, 'function validUrl(', 'function validAvatar(', `function validUrl(value, kind = 'https') {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\\u0000-\\u0020\\u007f\\\\]/.test(value)) return false;
  if (/^#[a-z0-9][a-z0-9-]*$/i.test(value) || (kind === 'announcement' && /^\\/(?!\\/)/.test(value))) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

`);
  js = edit(js, "'需要 HTTPS 或有效的磁力链接'", "'需要 HTTPS 链接'");
  js = edit(js, 'process.env.TRACKER_RUNTIME_DIR', 'process.env.GTAVI_RUNTIME_DIR');
  js = edit(js, "  seedPath = path.join(__dirname, 'content.json'),", '  seedPath,');
  js = edit(js, "    record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));\n  }", "    record = seedPath ? JSON.parse(fs.readFileSync(seedPath, 'utf8')) : { content: createFixtures(now()).content, updatedAt: new Date(now()).toISOString() };\n  }");
  js = edit(js, '  if (recordPath !== seedPath &&', '  if (seedPath && recordPath !== seedPath &&');
  return js.replace("'qq'", "'https'");
}

function dashboard(text) {
  let js = edit(text, "const fs = require('node:fs');\nconst path = require('node:path');\n", '');
  js = cut(js, 'const stored = ', 'const DAY = ', 'const repoKey = repo => repo.toLowerCase();\n');
  js = edit(js, 'initial = snapshotMeta, progressHistoryPath = null', "initial = new Map(), liveGitHub = false, token = '', progressHistoryPath = null");
  js = edit(js, '  const progressHistory =', '  const QUIET_MS = token ? 5 * 60_000 : 65 * 60_000;\n  const progressHistory =');
  js = edit(js, 'let generatedAt = stored.generatedAt;', 'let generatedAt = new Date(now()).toISOString();');
  js = edit(js, 'let stale = true;', 'let stale = liveGitHub;');
  js = edit(js, '    schedule(content.projects, force);', '    if (liveGitHub) schedule(content.projects, force);');
  js = edit(js, 'liveTimeline: Boolean(token)', 'liveTimeline: liveGitHub && Boolean(token)');
  js = edit(js, 'hasToken: Boolean(token)', 'hasToken: liveGitHub && Boolean(token)');
  js = edit(js, "url: \`https://github.com/\${p.repo}\`", "url: p.repo.startsWith('demo-workshop/') ? '' : \`https://github.com/\${p.repo}\`");
  js = edit(js, "(n.repo ? \`https://github.com/\${n.repo}\` : '')", "(n.repo && !n.repo.startsWith('demo-workshop/') ? \`https://github.com/\${n.repo}\` : '')");
  return js;
}

function filter(text) {
  let js = edit(text, "const { readFileSync } = require('node:fs');\nconst path = require('node:path');\n\n", '');
  js = cut(js, 'const DICTIONARY = ', 'const NOISE = ');
  js = cut(js, 'function loadTerms(', 'function fold(');
  return edit(js, '  builtInWords ||= Object.freeze(loadTerms(DICTIONARY));', '  builtInWords ||= Object.freeze([]);');
}

function danmaku(text) {
  return cut(text, "      if (fallbackHistory && typeof body?.text === 'string'", '      const nonce = body?.nonce;');
}

function feedback(text) {
  return edit(text, /const LINK_ORIGIN = '[^']+';/, "const LINK_ORIGIN = 'http://127.0.0.1';");
}

function bootstrap(text) {
  let js = edit(text, /const USAGE = `[^]*?`;/, `const USAGE = \`Usage:
  node scripts/bootstrap-account-owner.js <username>

Reads the owner password from stdin without echo. Set GTAVI_RUNTIME_DIR to use a different local runtime directory.\`;`);
  js = cut(js, '  const filePath = process.env.', "  let password = '';\n  try", `  const directory = path.resolve(process.env.GTAVI_RUNTIME_DIR || path.join(__dirname, '../.runtime'));
  const filePath = path.join(directory, 'accounts.json');
  if (require('node:fs').existsSync(filePath)) {
    process.stderr.write('The local accounts store already exists.\\n');
    process.exitCode = 1;
    return;
  }

`);
  return edit(js, '      bootstrap: { username: args[0], password },', '      bootstrap: { username: args[0], password },\n      confirmedInitialOwner: args[0],');
}

module.exports = { server, content, dashboard, filter, danmaku, feedback, bootstrap };
