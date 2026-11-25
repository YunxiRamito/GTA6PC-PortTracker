// Loopback entry point for the public-source edition of the site.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isIP } = require('node:net');
const { gzipSync } = require('node:zlib');
const { createDashboard } = require('./api/dashboard');
const { createTrafficHandler } = require('./api/traffic');
const { createTrafficHistory } = require('./api/_traffic-history');
const { createTrafficEvents } = require('./api/_traffic-events');
const { SEND_PATH, STREAM_PATH, RECENT_PATH, HISTORY_PATH, CONFIG_PATH, STATUS_PATH, LIKE_PATH, NONCE_PATH, COMMUNITY_VOTES_PATH, AVATAR_PATH, createDanmaku } = require('./api/_danmaku');
const { UUID: DANMAKU_ID } = require('./api/_danmaku-mutes');
const { createAdminAuth } = require('./api/_admin-auth');
const { createAdminAccounts } = require('./api/_admin-accounts');
const { createSponsors, UUID: SPONSOR_UUID } = require('./api/_sponsors');
const { createDanmakuNonces } = require('./api/_danmaku-nonces');
const { createFeedback } = require('./api/_feedback');
const { createContentStore, projectPublicContent, ContentError } = require('./api/_content');
const { RSS_PATH, buildNewsFeed } = require('./api/_rss');
const { createFixtures } = require('./fixtures/demo');
const { PUBLIC_ASSETS, PUBLIC_PAGES, PAGE_SECURITY_HEADERS } = require('./site-assets');

const PUBLIC_FEEDBACK_ROUTES = new Set(['/api/feedback', '/api/feedback/replies', '/api/feedback/replies/read', '/api/site-notices']);
const ROOT = __dirname;
const LOOPBACK = '127.0.0.1';
const DEFAULT_PORT = 8787;
const RSS_TIMELINE_LIMIT = 100;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const ADMIN_FILES = {
  '/': 'admin/index.html',
  '/admin': 'admin/index.html',
  '/admin/': 'admin/index.html',
  '/admin/index.html': 'admin/index.html',
  '/admin/admin.js': 'admin/admin.js',
  '/admin/admin.css': 'admin/admin.css',
  '/admin/danmaku.js': 'admin/danmaku.js',
  '/admin/feedback': 'admin/feedback.html',
  '/admin/feedback/': 'admin/feedback.html',
  '/admin/feedback.js': 'admin/feedback.js',
  '/admin/feedback.css': 'admin/feedback.css',
  '/admin/sponsors': 'admin/sponsors.html',
  '/admin/sponsors/': 'admin/sponsors.html',
  '/admin/sponsors.html': 'admin/sponsors.html',
  '/admin/sponsors.js': 'admin/sponsors.js',
  '/admin/sponsors.css': 'admin/sponsors.css',
  '/admin/login': 'admin/login.html',
  '/admin/login/': 'admin/login.html',
  '/admin/login.js': 'admin/login.js',
  '/admin/login.css': 'admin/login.css',
  '/admin/avatar.js': 'admin/avatar.js',
  '/admin/account.js': 'admin/account.js',
  '/admin/router.js': 'admin/router.js',
  '/admin/shell.js': 'admin/shell.js',
};
const MAX_ADMIN_BODY = 768 * 1024;
const ADMIN_DANMAKU = '/api/admin/danmaku';
const ADMIN_SESSION = '/api/admin/session';
const ADMIN_ACCOUNTS = '/api/admin/accounts';
const ADMIN_SPONSORS = '/api/admin/sponsors';
const ADMIN_SPONSOR_ACCOUNTS = `${ADMIN_SPONSORS}/accounts`;
const ADMIN_SPONSOR_PREVIEW = '/admin/sponsors/preview';
const SPONSORS_PATH = '/api/sponsors';
const SPONSOR_PNG_PREFIX = 'data:image/png;base64,';
const ACCOUNT_PASSWORD = '/api/admin/account/password';
const ACCOUNT_PROFILE = '/api/admin/account/profile';
const REGISTER_PATH = '/api/admin/register';
const MAX_PROFILE_BODY = 112 * 1024;
const REGISTRATION_WINDOW_MS = 15 * 60_000;
const REGISTRATION_IP_LIMIT = 8;
const MAX_REGISTRATIONS_IN_FLIGHT = 2;
const OWNER_ROLES = new Set(['owner']);
const EDITOR_ROLES = new Set(['owner', 'admin']);
const MODERATOR_ROLES = new Set(['owner', 'admin', 'moderator']);
const DANMAKU_SETTINGS_PATH = `${ADMIN_DANMAKU}/settings`;
const DANMAKU_SCHEDULED_PATH = `${ADMIN_DANMAKU}/scheduled`;
const SITE_DANMAKU_METHODS = new Map([
  [`${ADMIN_DANMAKU}/session`, 'GET'],
  [`${ADMIN_DANMAKU}/avatar`, 'GET'],
  [`${ADMIN_DANMAKU}/status`, 'GET'],
  [`${ADMIN_DANMAKU}/nonce`, 'GET'],
  [`${ADMIN_DANMAKU}/messages`, 'POST'],
  [`${ADMIN_DANMAKU}/mutes`, 'POST'],
  [`${ADMIN_DANMAKU}/community-votes`, 'GET, POST'],
]);
const DANMAKU_ROUTES = new Set([SEND_PATH, STREAM_PATH, RECENT_PATH, HISTORY_PATH, CONFIG_PATH, STATUS_PATH, LIKE_PATH, NONCE_PATH, COMMUNITY_VOTES_PATH]);
const isPublicDanmakuRoute = pathname => DANMAKU_ROUTES.has(pathname) || AVATAR_PATH.test(pathname);

function servePublicDanmaku(danmaku, req, res, pathname, browserListener) {
  return danmaku.handle(req, res, pathname, browserListener).catch(error => {
    console.error('Danmaku request failed:', error.code || error.name);
    if (res.headersSent) res.destroy();
    else if (!res.destroyed) sendJson(res, 503, { error: '弹幕暂时不可用' }, { Connection: 'close' });
  });
}

const ADMIN_FEEDBACK_ROUTE = /^\/api\/admin\/(?:site-notices|feedback(?:\/[a-f0-9-]{36}\/reply)?)$/;
function staticCacheHeaders(stat, full) {
  const etag = '"' + crypto.createHash('md5')
    .update(full + ':' + stat.mtimeMs + ':' + stat.size)
    .digest('hex') + '"';
  return {
    'Cache-Control': 'no-cache, must-revalidate',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
  };
}

function notModified(res, headers) {
  res.writeHead(304, {
    'Cache-Control': headers['Cache-Control'],
    ETag: headers.ETag,
    'Last-Modified': headers['Last-Modified'],
  });
  res.end();
}

function sendJson(res, status, obj, headers = {}, req = null) {
  let body = Buffer.from(JSON.stringify(obj), 'utf8');
  const accepted = req?.headers['accept-encoding'] || '';
  const gzip = accepted.split(',').some(part => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.find(p => p.trim().startsWith('q='));
    return name.trim() === 'gzip' && (q === undefined || Number(q.trim().slice(2)) > 0);
  });
  if (body.length >= 1024 && gzip) {
    body = gzipSync(body);
    headers = { ...headers, 'Content-Encoding': 'gzip' };
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(req ? { Vary: 'Accept-Encoding' } : {}),
    ...headers,
  });
  res.end(body);
}

// HTML：动态给静态资源引用注入 ?v=<文件 mtime>，作为强缓存穿透指纹。
// 文件一改动 URL 即变化，浏览器与中间 CDN 都会视为全新资源重新拉取。
function serveHtml(res, filePath, req, headers = {}, renderPage) {
  const full = path.join(ROOT, filePath);
  fs.readFile(full, 'utf8', (err, raw) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const html = (renderPage ? renderPage(raw) : raw).replace(
      /(["'])(\/[^"'#?]+\.(?:css|js|svg|png|jpe?g|webp|ico|woff2))(#[^"']*)?\1/gi,
      (match, quote, ref, fragment = '') => {
        const abs = path.join(ROOT, ref.slice(1));
        try {
          const st = fs.statSync(abs);
          return quote + ref + '?v=' + st.mtimeMs + fragment + quote;
        } catch (_) {
          return match;
        }
      }
    );
    const body = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache, must-revalidate',
      ...headers,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

function streamFile(res, full) {
  const stream = fs.createReadStream(full);
  res.once('close', () => stream.destroy());
  stream.once('error', () => res.destroy());
  stream.pipe(res);
}

function serveStatic(res, filePath, req) {
  const scope = filePath.startsWith('assets/') ? path.join(ROOT, 'assets')
    : filePath.startsWith('data/') ? path.join(ROOT, 'data') : ROOT;
  const full = path.resolve(ROOT, filePath);
  const relative = path.relative(scope, full);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(full).toLowerCase();
    const cache = staticCacheHeaders(stat, full);
    if (filePath.startsWith('assets/')) cache['Cache-Control'] = 'public, max-age=86400, stale-while-revalidate=300';
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    if (inm && inm === cache.ETag) return notModified(res, cache);
    if (!inm && ims && new Date(ims).getTime() >= Math.floor(stat.mtimeMs / 1000) * 1000) {
      return notModified(res, cache);
    }

    const headers = Object.assign({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
    }, cache);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    streamFile(res, full);
  });
}

function readJson(req, maxBytes = MAX_ADMIN_BODY) {
  const type = req.headers['content-type'] || '';
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(type) ||
      (req.headers['content-encoding'] && req.headers['content-encoding'].toLowerCase() !== 'identity')) {
    throw new ContentError(415, '请使用未压缩的 application/json');
  }
  if (Number(req.headers['content-length']) > maxBytes) throw new ContentError(413, '内容过大');
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        req.pause();
        reject(new ContentError(413, '内容过大'));
      } else chunks.push(chunk);
    });
    req.on('aborted', () => reject(new ContentError(400, '请求已断开')));
    req.on('error', reject);
    req.on('end', () => {
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new ContentError(400, 'JSON 格式有误')); }
    });
  });
}

function serveSponsorAvatar(req, res, avatar, headers = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: '只支持 GET 或 HEAD' }, { ...headers, Allow: 'GET, HEAD' });
  }
  if (!avatar?.startsWith(SPONSOR_PNG_PREFIX)) return sendJson(res, 404, { error: '没有这个头像' }, headers);
  const etag = `"${crypto.createHash('sha256').update(avatar).digest('hex')}"`;
  const responseHeaders = { 'Cache-Control': 'no-cache', ...headers, ETag: etag, 'X-Content-Type-Options': 'nosniff' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, responseHeaders);
    return res.end();
  }
  const image = Buffer.from(avatar.slice(SPONSOR_PNG_PREFIX.length), 'base64');
  res.writeHead(200, { ...responseHeaders, 'Content-Type': 'image/png', 'Content-Length': image.length });
  res.end(req.method === 'HEAD' ? undefined : image);
}

function contentReply(res, result, headers) {
  return sendJson(res, 200, { content: result.content, updatedAt: result.updatedAt }, { ...headers, ETag: result.etag });
}

function serveNewsFeed(req, res, timeline, publicOrigin) {
  // Configured HTTPS origin in production; use the actual listener for a local preview.
  const address = req.socket.localAddress;
  const host = address.includes(':') ? `[${address}]` : address;
  const body = buildNewsFeed(timeline.slice(0, RSS_TIMELINE_LIMIT), publicOrigin || `http://${host}:${req.socket.localPort}`);
  const etag = '"' + crypto.createHash('sha256').update(body).digest('hex') + '"';
  const headers = { 'Cache-Control': 'public, max-age=120', ETag: etag };
  const previous = (req.headers['if-none-match'] || '').split(',').map(value => value.trim().replace(/^W\//, ''));
  if (previous.includes(etag) || previous.includes('*')) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, {
    ...headers,
    'Content-Type': 'application/rss+xml; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}


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
  const adminNonces = createDanmakuNonces({ now });
  const registrationsByIp = new Map();
  let registrationsInFlight = 0;
  const feedback = createFeedback({ filePath: path.join(runtimeDir, 'site-feedback.json'), now, readJson, sendJson });
  const sponsorStore = createSponsors({
    filePath: path.join(runtimeDir, 'sponsors.json'),
    accountExists: id => Boolean(accounts?.get(id)),
  });
  let sponsorReadFailed = false;
  async function isSponsor(accountId) {
    try {
      const { sponsors } = await sponsorStore.read();
      sponsorReadFailed = false;
      return sponsors.some(sponsor => sponsor.accountId === accountId);
    } catch (error) {
      if (!sponsorReadFailed) console.error('Cannot read sponsor eligibility:', error.code || error.name);
      sponsorReadFailed = true;
      return false;
    }
  }
  const danmaku = createDanmaku({
    readJson, sendJson, now,
    getAdminOrigin: req => req ? 'http://' + req.headers.host : null,
    muteFile: path.join(runtimeDir, 'danmaku-mutes.json'),
    communityMuteFile: path.join(runtimeDir, 'danmaku-community-mutes.json'),
    historyFile: path.join(runtimeDir, 'danmaku-history.jsonl'),
    wordFile: path.join(runtimeDir, 'danmaku-words.json'),
    settingsFile: path.join(runtimeDir, 'danmaku-settings.json'),
    scheduledFile: path.join(runtimeDir, 'danmaku-scheduled.json'),
  });
  function browserPermission(req, roles, allowBannedSend = false) {
    if (!auth.hasSession(req)) return { status: 401 };
    if (!accounts) return { status: 200 };
    const identity = auth.identity(req);
    if (!identity || identity.needsPasswordChange || (roles && !roles.has(identity.role))) return { status: 403 };
    if (!allowBannedSend && (danmaku.isDeviceMuted(req) || danmaku.isManagementAccountMuted(identity.id))) return { status: 403 };
    return { status: 200, identity };
  }

  function editorialPermission(req, clientKey, allowServiceToken = false) {
    if (!accounts) return auth.authorize(req, clientKey);
    if (allowServiceToken && !auth.hasSession(req)) return auth.authorize(req, clientKey);
    return browserPermission(req, EDITOR_ROLES);
  }

  function forbidAdmin(res, decision, headers) {
    const { status, retryAfter } = decision;
    const error = status === 429 ? '尝试次数过多，请稍后重试' : status === 403 ? '当前账号没有这项权限' : '请先登录后台';
    return sendJson(res, status, { error }, { ...headers, ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) });
  }

  function accountError(res, error, headers) {
    if (res.destroyed) return;
    if (error instanceof ContentError) return sendJson(res, error.status, { error: error.message }, headers);
    console.error('Account request failed:', error.code || error.name);
    return sendJson(res, 503, { error: '账号服务暂时不可用' }, headers);
  }

  async function registerAccount(req, res, clientKey, headers) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' }, { ...headers, Allow: 'POST' });
    if (registrationsInFlight >= MAX_REGISTRATIONS_IN_FLIGHT) {
      return forbidAdmin(res, { status: 429, retryAfter: 3 }, headers);
    }
    const time = now();
    for (const [key, entry] of registrationsByIp) {
      if (entry.until <= time) registrationsByIp.delete(key);
      else break;
    }
    let entry = registrationsByIp.get(clientKey);
    if (!entry) {
      if (registrationsByIp.size >= 4096) return forbidAdmin(res, { status: 429, retryAfter: 60 }, headers);
      entry = { count: 0, until: time + REGISTRATION_WINDOW_MS };
      registrationsByIp.set(clientKey, entry);
    }
    if (entry.count >= REGISTRATION_IP_LIMIT) {
      return forbidAdmin(res, { status: 429, retryAfter: Math.ceil((entry.until - time) / 1000) }, headers);
    }
    entry.count++;
    registrationsInFlight++;
    const deadline = setTimeout(() => req.destroy(), 15_000);
    deadline.unref();
    try {
      const body = await readJson(req, MAX_PROFILE_BODY);
      clearTimeout(deadline);
      if (typeof body?.password !== 'string' || body.password !== body.confirmPassword) {
        throw new ContentError(400, '两次输入的密码不一致');
      }
      const { username, password, nickname, email, avatar } = body;
      danmaku.validateNickname(nickname, { required: true });
      await accounts.register({ username, password, nickname, email, avatar });
      if (!res.destroyed) return sendJson(res, 201, { registered: true }, headers);
    } catch (error) {
      return accountError(res, error, headers);
    } finally {
      clearTimeout(deadline);
      registrationsInFlight--;
    }
  }

  function publicAccount({ id, uid, username, role, nickname, email, avatar, needsPasswordChange }) {
    return { id, uid, username, role, nickname, email, avatar, needsPasswordChange };
  }

  async function handleAccounts(req, res, pathname, targetId, headers, sessionOptions) {
    const identity = auth.identity(req);
    if (!identity) return forbidAdmin(res, { status: 401 }, headers);
    if (Boolean(danmaku.isManagementAccountMuted?.(identity.id) || danmaku.isDeviceMuted?.(req))) {
      return forbidAdmin(res, { status: 403 }, headers);
    }
    try {
      if (pathname === ACCOUNT_PASSWORD) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' }, { ...headers, Allow: 'POST' });
        const body = await readJson(req, 2048);
        if (body?.confirmPassword !== undefined && body.confirmPassword !== body.newPassword) {
          throw new ContentError(400, '两次输入的密码不一致');
        }
        await accounts.changePassword(identity.id, body?.currentPassword, body?.newPassword);
        return auth.replaceSession(req, res, { ...sessionOptions, headers }, identity);
      }
      if (pathname === ACCOUNT_PROFILE) {
        if (req.method === 'GET') return sendJson(res, 200, { account: publicAccount(accounts.getProfile(identity.id)) }, headers);
        if (req.method !== 'PATCH') return sendJson(res, 405, { error: '只支持 GET 或 PATCH' }, { ...headers, Allow: 'GET, PATCH' });
        const body = await readJson(req, MAX_PROFILE_BODY);
        const current = browserPermission(req);
        if (current.status !== 200) return forbidAdmin(res, current, headers);
        if (!body || Array.isArray(body) || typeof body !== 'object' ||
            Object.keys(body).some(key => !['nickname', 'email', 'avatar'].includes(key))) {
          throw new ContentError(400, '只能修改昵称、邮箱或头像');
        }
        if ('nickname' in body) danmaku.validateNickname(body.nickname, { required: true });
        return sendJson(res, 200, { account: publicAccount(await accounts.updateProfile(identity.id, body)) }, headers);
      }
      const permission = browserPermission(req, EDITOR_ROLES);
      if (permission.status !== 200) return forbidAdmin(res, permission, headers);
      if (pathname === ADMIN_ACCOUNTS) {
        if (req.method === 'GET') return sendJson(res, 200, { accounts: (await accounts.list(identity.id)).map(publicAccount) }, headers);
        if (req.method === 'POST') {
          const body = await readJson(req, 2048);
          return sendJson(res, 201, { account: publicAccount(await accounts.create(identity.id, body)) }, headers);
        }
        return sendJson(res, 405, { error: '只支持 GET 或 POST' }, { ...headers, Allow: 'GET, POST' });
      }
      const resetPassword = pathname.endsWith('/reset-password');
      if (resetPassword || req.method === 'DELETE') {
        const owner = browserPermission(req, OWNER_ROLES);
        if (owner.status !== 200) return forbidAdmin(res, owner, headers);
        if (resetPassword) {
          if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' }, { ...headers, Allow: 'POST' });
          const result = await accounts.resetPassword(identity.id, targetId);
          return sendJson(res, 200, { account: publicAccount(result.account), temporaryPassword: result.temporaryPassword }, headers);
        }
        const body = await readJson(req, 1024);
        const current = browserPermission(req, OWNER_ROLES);
        if (current.status !== 200) return forbidAdmin(res, current, headers);
        const { uid } = await accounts.deleteAccount(identity.id, targetId, body?.confirmUsername);
        return sendJson(res, 200, { deleted: true, uid }, headers);
      }
      if (req.method !== 'PATCH') return sendJson(res, 405, { error: '只支持 PATCH 或 DELETE' }, { ...headers, Allow: 'PATCH, DELETE' });
      const body = await readJson(req, 1024);
      return sendJson(res, 200, { account: publicAccount(await accounts.setRole(identity.id, targetId, body?.role)) }, headers);
    } catch (error) {
      return accountError(res, error, headers);
    }
  }

  function adminSponsorPerson(account, accountId) {
    if (!account) return { uid: null, username: '', nickname: '账号已删除', avatar: '' };
    const profile = accounts.getProfile(accountId);
    return {
      uid: account.uid,
      username: account.username,
      nickname: account.nickname,
      avatar: profile?.avatar ? `${ADMIN_SPONSOR_ACCOUNTS}/${accountId}/avatar` : '',
    };
  }

  function sponsorReply(res, snapshot, headers) {
    const sponsors = snapshot.sponsors.map(entry => ({
      ...entry, ...adminSponsorPerson(accounts.get(entry.accountId), entry.accountId),
    }));
    return sendJson(res, 200, { sponsors }, { ...headers, ETag: snapshot.etag });
  }

  async function handleAdminSponsors(req, res, pathname, query, clientKey, headers) {
    const permission = editorialPermission(req, clientKey);
    if (permission.status !== 200) return forbidAdmin(res, permission, headers);
    if (!accounts) return sendJson(res, 503, { error: '鸣谢管理需要启用站点账号' }, headers);
    try {
      if (pathname === ADMIN_SPONSOR_ACCOUNTS) {
        if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' }, { ...headers, Allow: 'GET' });
        const needle = new URLSearchParams(query).get('q')?.trim() || '';
        if (needle.length > 80) throw new ContentError(400, '搜索词不能超过 80 个字符');
        if (!needle) return sendJson(res, 200, { accounts: [] }, headers);
        const users = await accounts.list(permission.identity.id);
        const normalized = needle.normalize('NFKC').toLowerCase();
        const uidQuery = /^(?:uid\s*)?(\d+)$/.exec(normalized)?.[1];
        const exactUid = users.find(account => String(account.uid) === uidQuery);
        const matches = users.filter(account => account !== exactUid && (
          account.username.toLowerCase().includes(normalized) ||
          account.nickname.normalize('NFKC').toLowerCase().includes(normalized)
        ));
        if (exactUid) matches.unshift(exactUid);
        const results = matches.slice(0, 12).map(account => ({ id: account.id, ...adminSponsorPerson(account, account.id) }));
        return sendJson(res, 200, { accounts: results }, headers);
      }
      if (pathname.startsWith(`${ADMIN_SPONSOR_ACCOUNTS}/`)) {
        const match = /^\/api\/admin\/sponsors\/accounts\/([^/]+)\/avatar$/.exec(pathname);
        if (!match || !SPONSOR_UUID.test(match[1])) return sendJson(res, 404, { error: '没有这个头像' }, headers);
        return serveSponsorAvatar(req, res, accounts.getProfile(match[1])?.avatar, headers);
      }
      if (req.method === 'GET') return sponsorReply(res, await sponsorStore.read(), headers);
      if (req.method !== 'PUT') return sendJson(res, 405, { error: '只支持 GET 或 PUT' }, { ...headers, Allow: 'GET, PUT' });
      const body = await readJson(req);
      if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => key !== 'sponsors')) {
        throw new ContentError(400, '鸣谢名单格式无效');
      }
      const current = browserPermission(req, EDITOR_ROLES);
      if (current.status !== 200) return forbidAdmin(res, current, headers);
      return sponsorReply(res, await sponsorStore.write(body.sponsors, req.headers['if-match']), headers);
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof ContentError) return sendJson(res, error.status, { error: error.message }, headers);
      console.error('Sponsor management failed:', error.code || error.name);
      return sendJson(res, 503, { error: '鸣谢管理暂时不可用' }, headers);
    }
  }

  function avatarTag(avatar) {
    return crypto.createHash('sha256').update(avatar).digest('hex').slice(0, 32);
  }

  async function handleAdminDanmaku(req, res, pathname, query, clientKey, headers, cors) {
    if (req.method === 'OPTIONS' && cors) {
      res.writeHead(204, headers);
      return res.end();
    }
    if (pathname === `${ADMIN_DANMAKU}/community-votes`) {
      const { status, identity } = browserPermission(req);
      if (!accounts) return sendJson(res, 403, {
        error: '社区禁言投票需要普通账号登录', code: 'community_vote_login_required',
      }, headers);
      if (status === 401) return sendJson(res, 401, {
        error: '请先登录普通账号，再发起或支持社区禁言投票', code: 'community_vote_login_required',
      }, headers);
      if (status !== 200 || !identity) return forbidAdmin(res, { status: status === 200 ? 403 : status }, headers);
      return danmaku.voteAsMember(req, res, headers, identity.id, identity.role, clientKey).catch(error => accountError(res, error, headers));
    }
    if (pathname === `${ADMIN_DANMAKU}/session` && req.method === 'GET') {
      const { status, identity } = browserPermission(req);
      if (!accounts) return sendJson(res, 200, { authenticated: status === 200 }, headers);
      if (status !== 200) return sendJson(res, 200, { authenticated: false }, headers);
      const profile = accounts.getProfile(identity.id);
      return sendJson(res, 200, {
        authenticated: true,
        nickname: profile?.nickname || '',
        sponsor: await isSponsor(identity.id),
        canModerate: MODERATOR_ROLES.has(identity.role),
        gold: EDITOR_ROLES.has(identity.role),
        ...(MODERATOR_ROLES.has(identity.role) ? { staff: identity.role } : {}),
        ...(profile?.avatar ? { avatarTag: avatarTag(profile.avatar) } : {}),
      }, headers);
    }
    if (accounts && pathname === `${ADMIN_DANMAKU}/status` && req.method === 'GET') {
      const identity = auth.identity(req);
      if (!identity) return forbidAdmin(res, { status: 401 }, headers);
      try {
        return sendJson(res, 200, danmaku.accountMuteStatus(identity.id, req), headers);
      } catch (error) {
        return accountError(res, error, headers);
      }
    }
    if (pathname === `${ADMIN_DANMAKU}/avatar` && req.method === 'GET') {
      const { status, identity } = browserPermission(req);
      if (status !== 200) return forbidAdmin(res, { status }, headers);
      const avatar = accounts?.getProfile(identity?.id)?.avatar;
      if (!avatar) return sendJson(res, 404, { error: '尚未设置头像' }, headers);
      const etag = `"${avatarTag(avatar)}"`;
      const imageHeaders = { ...headers, 'Cache-Control': 'private, no-cache', Vary: cors ? 'Origin, Cookie' : 'Cookie', ETag: etag };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, imageHeaders);
        return res.end();
      }
      const body = Buffer.from(avatar.slice('data:image/png;base64,'.length), 'base64');
      res.writeHead(200, { ...imageHeaders, 'Content-Type': 'image/png', 'Content-Length': body.length });
      return res.end(body);
    }
    const action = pathname === `${ADMIN_DANMAKU}/nonce` && req.method === 'GET'
      ? new URLSearchParams(query).get('action') : null;
    const accountSend = accounts && (action === 'send' ||
      (pathname === `${ADMIN_DANMAKU}/messages` && req.method === 'POST'));
    const globalSettings = pathname === DANMAKU_SETTINGS_PATH || pathname === DANMAKU_SCHEDULED_PATH;
    const roles = accountSend ? undefined : globalSettings ? EDITOR_ROLES : MODERATOR_ROLES;
    const permission = accounts || cors ? browserPermission(req, roles, accountSend) : auth.authorize(req, clientKey);
    if (permission.status !== 200) return forbidAdmin(res, permission, headers);
    const binding = action => `${action}:${auth.authorizedScope(req, clientKey)}`;
    try {
      if (pathname === `${ADMIN_DANMAKU}/nonce` && req.method === 'GET') {
        if (action !== 'send' && action !== 'mute') {
          return sendJson(res, 400, { error: '请选择有效的弹幕操作' }, headers);
        }
        return sendJson(res, 200, adminNonces.issue(binding(action)), headers);
      }
      if (pathname === DANMAKU_SETTINGS_PATH) {
        if (req.method === 'GET') return sendJson(res, 200, danmaku.readSettings(), headers);
        if (req.method === 'PUT') {
          const body = await readJson(req, 1024);
          return sendJson(res, 200, await danmaku.changeSettings(body), headers);
        }
        return sendJson(res, 405, { error: '只支持 GET 或 PUT' }, { ...headers, Allow: 'GET, PUT' });
      }
      if (pathname === DANMAKU_SCHEDULED_PATH) {
        if (req.method === 'GET') return sendJson(res, 200, danmaku.readScheduled(), headers);
        if (req.method === 'PUT') {
          const body = await readJson(req);
          return sendJson(res, 200, await danmaku.writeScheduled(body), headers);
        }
        return sendJson(res, 405, { error: '只支持 GET 或 PUT' }, { ...headers, Allow: 'GET, PUT' });
      }
      if (pathname === `${ADMIN_DANMAKU}/history`) {
        if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' }, { ...headers, Allow: 'GET' });
        const cursor = new URLSearchParams(query).get('cursor') ?? undefined;
        return sendJson(res, 200, await danmaku.listModerationHistory(cursor), headers);
      }
      if (pathname === `${ADMIN_DANMAKU}/messages`) {
        if (req.method === 'GET') return sendJson(res, 200, { messages: danmaku.listMessages() }, headers);
        if (req.method === 'POST') {
          if (!accounts) return await danmaku.sendAdmin(req, res, headers, nonce => adminNonces.consume(binding('send'), nonce));
          return await danmaku.sendMember(req, res, headers, async nonce => {
            if (!adminNonces.consume(binding('send'), nonce)) return null;
            const current = browserPermission(req, undefined, true).identity;
            if (!current) return null;
            const profile = accounts.getProfile(current.id);
            return {
              id: current.id,
              nickname: profile?.nickname || '',
              avatar: profile?.avatar,
              deviceSubject: danmaku.accountDeviceSubject?.(req),
              staff: MODERATOR_ROLES.has(current.role) ? current.role : undefined,
              sponsor: await isSponsor(current.id),
            };
          });
        }
      }
      if (pathname === `${ADMIN_DANMAKU}/words`) {
        if (req.method === 'GET') return sendJson(res, 200, danmaku.listWords(new URLSearchParams(query)), headers);
        if (req.method === 'POST' || req.method === 'DELETE') {
          const body = await readJson(req, 1024);
          const enable = req.method === 'POST';
          return sendJson(res, enable ? 201 : 200, await danmaku.changeWord(body?.term, enable), headers);
        }
      }
      if (pathname === `${ADMIN_DANMAKU}/mutes`) {
        if (req.method === 'GET') return sendJson(res, 200, { mutes: danmaku.listMutes() }, headers);
        if (req.method === 'POST') {
          const body = await readJson(req, 1024);
          if (accounts && browserPermission(req, MODERATOR_ROLES).status !== 200) {
            return forbidAdmin(res, { status: 403 }, headers);
          }
          if (!adminNonces.consume(binding('mute'), body?.nonce)) {
            return sendJson(res, 409, { error: '禁言请求已失效，请重试', code: 'stale_request' }, headers);
          }
          const mute = await danmaku.muteMessage(body?.messageId, body?.duration);
          return sendJson(res, 201, { mute }, headers);
        }
      }
      const id = pathname.slice(`${ADMIN_DANMAKU}/mutes/`.length);
      if (pathname.startsWith(`${ADMIN_DANMAKU}/mutes/`) && DANMAKU_ID.test(id) && req.method === 'DELETE') {
        await danmaku.liftMute(id);
        return sendJson(res, 200, { removed: true }, headers);
      }
      return sendJson(res, 404, { error: '没有这个弹幕管理接口' }, headers);
    } catch (err) {
      if (res.destroyed) return;
      if (err instanceof ContentError) return sendJson(res, err.status, { error: err.message }, headers);
      console.error('Admin danmaku request failed:', err.code || err.name);
      return sendJson(res, 503, { error: '弹幕管理暂时不可用' }, headers);
    }
  }


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
    const accountMatch = /^\/api\/admin\/accounts\/([a-f0-9-]{36})(?:\/reset-password)?$/.exec(pathname);
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
    const contentRoute = /^\/api\/admin\/content(?:\/([a-z]+))?\/?$/.exec(pathname);
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
    async getSponsors() {
      const { sponsors } = await sponsorStore.read();
      return sponsors.flatMap(({ id, accountId, message }) => {
        const profile = accounts?.getProfile(accountId);
        return profile ? [{
          id,
          nickname: profile.nickname || '未设置昵称',
          avatar: profile.avatar ? `${SPONSORS_PATH}/${id}/avatar` : '',
          message,
        }] : [];
      });
    },
    async getSponsorAvatar(id) {
      const { sponsors } = await sponsorStore.read();
      const entry = sponsors.find(sponsor => sponsor.id === id);
      return entry ? accounts?.getProfile(entry.accountId)?.avatar : undefined;
    },
    getContent() {
      const { content, updatedAt, etag } = store.read();
      return { content: projectPublicContent(content), updatedAt, revision: etag };
    },
    getDashboard(force) {
      return dashboard.get(store.read().content, { force });
    },
    traffic,
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
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
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
    if (/^\/(?:admin|api\/admin)(?:\/|$)/.test(pathname)) return handleAdmin(req, res, pathname, url.search.slice(1));
    if (getSponsors && pathname === SPONSORS_PATH) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' }, { Allow: 'GET', Connection: 'close' });
      return Promise.resolve().then(getSponsors).then(sponsors => {
        if (!res.destroyed) return sendJson(res, 200, { sponsors }, { 'Cache-Control': 'no-cache' }, req);
      }, error => {
        console.error('Sponsor list request failed:', error.code || error.name);
        if (!res.destroyed) sendJson(res, 503, { error: '鸣谢名单暂时不可用' });
      });
    }
    if (getSponsorAvatar && pathname.startsWith(`${SPONSORS_PATH}/`)) {
      const match = /^\/api\/sponsors\/([^/]+)\/avatar$/.exec(pathname);
      if (!match || !SPONSOR_UUID.test(match[1])) return sendJson(res, 404, { error: '没有这个头像' });
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: '只支持 GET 或 HEAD' }, { Allow: 'GET, HEAD', Connection: 'close' });
      }
      return getSponsorAvatar(match[1]).then(avatar => {
        if (!res.destroyed) return serveSponsorAvatar(req, res, avatar);
      }, () => {
        if (!res.destroyed) return sendJson(res, 503, { error: '头像暂时不可用' });
      });
    }
    if (feedback && PUBLIC_FEEDBACK_ROUTES.has(pathname)) {
      return Promise.resolve().then(() => feedback(req, res, pathname)).catch(() => {
        if (res.headersSent) res.destroy();
        else if (!res.destroyed) sendJson(res, 503, { error: '反馈或通知暂时不可用' }, { Connection: 'close' });
      });
    }
    if (isPublicDanmakuRoute(pathname)) return servePublicDanmaku(danmaku, req, res, pathname);
    if (pathname === '/api/traffic' && traffic) return traffic(req, res);
    if (pathname === '/api/traffic/events' && events) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' }, { Allow: 'GET', Connection: 'close' });
      return events.open(res, url.searchParams.get('scope') === 'local');
    }
    if (pathname === '/api/traffic/history' && getTrafficHistory) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' }, { Allow: 'GET', Connection: 'close' });
      return Promise.resolve().then(getTrafficHistory).then(payload => {
        if (res.destroyed) return;
        if (!payload) return sendJson(res, 503, { error: '访问趋势暂不可用' });
        return sendJson(res, 200, payload, {}, req);
      }, () => {
        if (!res.destroyed) sendJson(res, 503, { error: '访问趋势暂不可用' });
      });
    }
    if (pathname === RSS_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '只支持 GET 或 HEAD' }, { Allow: 'GET, HEAD', Connection: 'close' });
      try {
        const { timeline } = getDashboard(false);
        return serveNewsFeed(req, res, timeline, publicOrigin);
      } catch (err) {
        console.error('RSS request failed:', err.code || err.name);
        return sendJson(res, 503, { error: '新闻订阅暂时不可用' });
      }
    }
    if (pathname === '/api/content') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' }, { Allow: 'GET', Connection: 'close' });
      const payload = getContent();
      if (!payload) return sendJson(res, 503, { error: '内容正在同步' });
      const headers = { ETag: payload.revision, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
      if (req.headers['if-none-match'] === payload.revision) {
        res.writeHead(304, headers);
        return res.end();
      }
      return sendJson(res, 200, payload, headers, req);
    }
    if (pathname === '/api/dashboard') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' }, { Allow: 'GET', Connection: 'close' });
      try {
        const payload = getDashboard(url.searchParams.get('force') === '1');
        if (!payload) return sendJson(res, 503, { error: '工程档案正在同步' });
        return sendJson(res, 200, payload, { 'Cache-Control': 'no-cache' }, req);
      } catch (err) {
        console.error('Dashboard request failed:', err.code || err.name);
        return sendJson(res, 503, { error: '工程档案暂时不可用' });
      }
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
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
