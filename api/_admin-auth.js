'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE_NAME = 'tracker_admin_session';
const ACCOUNT_LOCAL_COOKIE_NAME = 'tracker_account_session';
const ACCOUNT_HOST_COOKIE_NAME = '__Host-tracker_account_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const HANDOFF_TTL_MS = 45 * 1000;
const MAX_SESSIONS = 4096;
const SESSION_STORE_VERSION = 1;
const MAX_SESSION_FILE_BYTES = 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_HANDOFFS = 4096;
const MAX_RATE_KEYS = 4096;
const MAX_LOGIN_BODY = 2048;
const CLIENT_WINDOW_MS = 15 * 60 * 1000;
const CLIENT_FAILURE_LIMIT = 8;
const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_FAILURE_LIMIT = 120;
const MAX_AUTHENTICATIONS = 8;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HANDOFF_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ACCOUNT_LOOKUP_FAILED = Symbol('account-lookup-failed');

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function isLoopback(req) {
  const address = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function accountCookieContext(req) {
  if (req?.socket?.encrypted === true ||
      (isLoopback(req) && req?.headers?.['x-forwarded-proto'] === 'https')) {
    // Forwarded HTTPS is trusted only from loopback; the server wrapper validates
    // the configured account/console Host and Origin before calling this module.
    return { name: ACCOUNT_HOST_COOKIE_NAME, secure: true };
  }
  if (isLoopback(req)) return { name: ACCOUNT_LOCAL_COOKIE_NAME, secure: false };
  return null;
}

function createAdminAuth({ tokens = [], now = Date.now, accounts, sessionFile } = {}) {
  const configuredTokens = (Array.isArray(tokens) ? tokens : [tokens])
    .filter((token) => typeof token === 'string' && token.length > 0);
  const tokenDigests = configuredTokens.map(digest);
  const accountStore = accounts == null ? null : accounts;
  if (accountStore && (typeof accountStore.authenticate !== 'function' || typeof accountStore.get !== 'function')) {
    throw new TypeError('accounts must provide authenticate(username, password) and get(id)');
  }

  const persistentSessionFile = accountStore && typeof sessionFile === 'string' && sessionFile
    ? path.resolve(sessionFile) : null;
  const sessions = new Map();
  const handoffs = new Map();
  const failures = new Map();
  let globalFailures = { startedAt: 0, count: 0 };
  let inFlightAuthentications = 0;

  function timestamp() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  function cookieContext(req, fallbackSecure = false) {
    return accountStore ? accountCookieContext(req) : { name: COOKIE_NAME, secure: Boolean(fallbackSecure) };
  }

  function sessionCookie(req) {
    const expectedName = cookieContext(req)?.name;
    if (!expectedName) return '';
    const raw = req?.headers?.cookie;
    if (typeof raw !== 'string' || raw.length > 8192) return '';
    for (const part of raw.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0 || part.slice(0, separator).trim() !== expectedName) continue;
      const value = part.slice(separator + 1).trim();
      return SESSION_ID_PATTERN.test(value) ? value : '';
    }
    return '';
  }

  function sessionKey(id) {
    return digest(id).toString('hex');
  }

  function normalizeAccount(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const { id, username, role, credentialVersion } = value;
    const validVersion = typeof credentialVersion === 'string' ||
      (typeof credentialVersion === 'number' && Number.isFinite(credentialVersion));
    if (typeof id !== 'string' || !id || Buffer.byteLength(id, 'utf8') > 256 ||
        typeof username !== 'string' || !username || Buffer.byteLength(username, 'utf8') > 256 ||
        typeof role !== 'string' || !role || Buffer.byteLength(role, 'utf8') > 64 || !validVersion) {
      return null;
    }
    return {
      id,
      username,
      role,
      credentialVersion,
      needsPasswordChange: value.needsPasswordChange === true,
    };
  }

  // credentialVersion stays server-side; browser/API identity only exposes the safe projection.
  function projectAccount(account) {
    return {
      id: account.id,
      username: account.username,
      role: account.role,
      needsPasswordChange: account.needsPasswordChange,
    };
  }

  function readLatestAccount(id) {
    try {
      const value = accountStore.get(id);
      // get() is intentionally synchronous so identity() and hasSession() can fail closed
      // on every request without changing their existing synchronous call contract.
      if (value && typeof value.then === 'function') return ACCOUNT_LOOKUP_FAILED;
      if (value == null) return null;
      const account = normalizeAccount(value);
      return account && account.id === id ? account : null;
    } catch {
      return ACCOUNT_LOOKUP_FAILED;
    }
  }

  function persistSessions() {
    if (!persistentSessionFile) return;
    const directory = path.dirname(persistentSessionFile);
    const temporary = path.join(directory, `.account-sessions-${crypto.randomUUID()}.tmp`);
    const data = Buffer.from(`${JSON.stringify({
      version: SESSION_STORE_VERSION,
      sessions: [...sessions].map(([key, session]) => ({ key, ...session })),
    })}\n`);
    if (data.length > MAX_SESSION_FILE_BYTES) throw new Error('Account session storage is full');
    let descriptor;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        const existing = fs.lstatSync(persistentSessionFile);
        if (!existing.isFile() || existing.isSymbolicLink() ||
            (process.platform !== 'win32' && (existing.mode & 0o077) !== 0)) {
          throw new Error('Account session storage permissions are invalid');
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, data);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, persistentSessionFile);
      if (process.platform !== 'win32') {
        try {
          const directoryHandle = fs.openSync(directory, 'r');
          try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
        } catch { /* Some filesystems do not support directory fsync. */ }
      }
    } catch (error) {
      throw new Error('Could not persist account login sessions', { cause: error });
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  function loadSessions() {
    if (!persistentSessionFile) return;
    let raw;
    try {
      const stat = fs.lstatSync(persistentSessionFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_SESSION_FILE_BYTES ||
          (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
        throw new Error('Account session storage permissions or size are invalid');
      }
      raw = fs.readFileSync(persistentSessionFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error('Could not load account login sessions', { cause: error });
    }
    let changed = false;
    try {
      const saved = JSON.parse(raw);
      if (saved?.version !== SESSION_STORE_VERSION || !Array.isArray(saved.sessions) || saved.sessions.length > MAX_SESSIONS) {
        throw new Error('Unknown account session store version');
      }
      const at = timestamp();
      for (const row of saved.sessions) {
        const { key, expiresAt, accountId, credentialVersion } = row ?? {};
        if (typeof key !== 'string' || !HASH_PATTERN.test(key) || !Number.isSafeInteger(expiresAt) ||
            !Number.isSafeInteger(credentialVersion) || typeof accountId !== 'string' || !accountId ||
            Buffer.byteLength(accountId, 'utf8') > 256 || sessions.has(key)) {
          throw new Error('Invalid persisted account session');
        }
        if (expiresAt <= at) { changed = true; continue; }
        const account = readLatestAccount(accountId);
        if (account === ACCOUNT_LOOKUP_FAILED) throw new Error('Account store is unavailable');
        if (!account || account.credentialVersion !== credentialVersion) { changed = true; continue; }
        sessions.set(key, { expiresAt, accountId, credentialVersion });
      }
      if (changed) persistSessions();
    } catch (error) {
      sessions.clear();
      throw new Error('Could not validate account login sessions', { cause: error });
    }
  }

  loadSessions();

  function liveSession(req, at = timestamp()) {
    const id = sessionCookie(req);
    if (!id) return null;
    const key = sessionKey(id);
    const session = sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= at) {
      sessions.delete(key);
      return null;
    }
    if (accountStore) {
      const current = readLatestAccount(session.accountId);
      if (current === ACCOUNT_LOOKUP_FAILED) return null;
      if (!current || current.credentialVersion !== session.credentialVersion) {
        sessions.delete(key);
        return null;
      }
      return { id, key, session, account: current };
    }
    return { id, key, session, account: null };
  }

  function rateKey(clientKey) {
    const value = typeof clientKey === 'string' ? clientKey.slice(0, 256) : '';
    return digest(value || 'unknown-client').toString('hex');
  }

  function pruneFailures(at) {
    for (const [key, entry] of failures) {
      if (entry.startedAt + CLIENT_WINDOW_MS <= at) failures.delete(key);
    }
    while (failures.size > MAX_RATE_KEYS) failures.delete(failures.keys().next().value);
    if (globalFailures.startedAt + GLOBAL_WINDOW_MS <= at) globalFailures = { startedAt: at, count: 0 };
  }

  function retryAfterFor(clientKey, at = timestamp()) {
    pruneFailures(at);
    const key = rateKey(clientKey);
    const client = failures.get(key);
    const waits = [];
    if (client && client.count >= CLIENT_FAILURE_LIMIT) {
      waits.push(client.startedAt + CLIENT_WINDOW_MS - at);
    }
    if (globalFailures.count >= GLOBAL_FAILURE_LIMIT) {
      waits.push(globalFailures.startedAt + GLOBAL_WINDOW_MS - at);
    }
    if (!waits.length) return 0;
    return Math.max(1, Math.ceil(Math.max(...waits) / 1000));
  }

  function recordFailure(clientKey, at = timestamp()) {
    const alreadyLimited = retryAfterFor(clientKey, at);
    if (alreadyLimited) return { status: 429, retryAfter: alreadyLimited };

    const key = rateKey(clientKey);
    let client = failures.get(key);
    if (!client || client.startedAt + CLIENT_WINDOW_MS <= at) {
      client = { startedAt: at, count: 0 };
    }
    client.count += 1;
    failures.delete(key);
    failures.set(key, client);

    if (globalFailures.startedAt + GLOBAL_WINDOW_MS <= at) globalFailures = { startedAt: at, count: 0 };
    globalFailures.count += 1;

    while (failures.size > MAX_RATE_KEYS) failures.delete(failures.keys().next().value);
    return { status: 401 };
  }

  function clearClientFailures(clientKey) {
    failures.delete(rateKey(clientKey));
  }

  function matchesToken(value) {
    const candidate = digest(value);
    let matched = 0;
    for (const expected of tokenDigests) matched |= Number(crypto.timingSafeEqual(expected, candidate));
    return matched === 1;
  }

  function bearerValue(req) {
    const authorization = req?.headers?.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return '';
    return authorization.slice(7);
  }

  function identity(req) {
    if (!accountStore) return null;
    const live = liveSession(req);
    return live?.account ? projectAccount(live.account) : null;
  }

  function hasSession(req) {
    if (accountStore) return identity(req) !== null;
    if (!configuredTokens.length && isLoopback(req)) return true;
    return liveSession(req) !== null;
  }

  function authorize(req, clientKey) {
    if (hasSession(req)) return { status: 200 };

    const retryAfter = retryAfterFor(clientKey);
    if (retryAfter) return { status: 429, retryAfter };

    const bearer = bearerValue(req);
    if (configuredTokens.length && matchesToken(bearer)) {
      clearClientFailures(clientKey);
      return { status: 200 };
    }

    return recordFailure(clientKey);
  }

  function authorizedScope(req, clientKey) {
    const live = liveSession(req);
    if (live) return `session:${live.key}`;
    if (configuredTokens.length) return `token:${sessionKey(bearerValue(req))}:${clientKey}`;
    return `local:${clientKey}`;
  }

  function cookieHeader(id, secure, expiresAt, name = COOKIE_NAME) {
    const maxAge = Math.max(0, Math.floor((expiresAt - timestamp()) / 1000));
    return `${name}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Expires=${new Date(expiresAt).toUTCString()}${secure ? '; Secure' : ''}`;
  }

  function expiredCookie(secure, name = COOKIE_NAME) {
    return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`;
  }

  function reply(sendJson, res, status, payload, headers, extraHeaders = {}) {
    return sendJson(res, status, payload, { ...(headers || {}), ...extraHeaders });
  }

  function isOrigin(value) {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {
      const parsed = new URL(value);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === value;
    } catch {
      return false;
    }
  }

  function validateJsonRequest(req, headers, sendJson, res) {
    const contentType = req.headers?.['content-type'] || '';
    const contentEncoding = req.headers?.['content-encoding'] || '';
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(contentType) ||
        (contentEncoding && contentEncoding.toLowerCase() !== 'identity')) {
      return reply(sendJson, res, 415, { error: '请使用未压缩的 application/json。' }, headers);
    }

    const lengthHeader = req.headers?.['content-length'];
    if (lengthHeader !== undefined) {
      const length = Number(lengthHeader);
      if (!Number.isSafeInteger(length) || length < 0) {
        return reply(sendJson, res, 400, { error: '请求格式不正确。' }, headers);
      }
      if (length > MAX_LOGIN_BODY) {
        return reply(sendJson, res, 413, { error: '请求内容过大。' }, headers);
      }
    }
    return null;
  }

  async function parseJson(req, res, { headers, sendJson, readJson }) {
    try {
      return { body: await readJson(req) };
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 400;
      return { response: reply(sendJson, res, status, { error: '请求格式不正确。' }, headers) };
    }
  }

  function pruneSessions(at) {
    for (const [key, session] of sessions) {
      if (session.expiresAt <= at) sessions.delete(key);
    }
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  function issueSession(account, at = timestamp()) {
    pruneSessions(at);
    const id = crypto.randomBytes(32).toString('base64url');
    const expiresAt = at + SESSION_TTL_MS;
    const session = {
      expiresAt,
      ...(account ? { accountId: account.id, credentialVersion: account.credentialVersion } : {}),
    };
    const key = sessionKey(id);
    sessions.set(key, session);
    if (accountStore && account) {
      try { persistSessions(); }
      catch (error) { sessions.delete(key); throw error; }
    }
    return { id, expiresAt };
  }

  function createHandoff(account, at = timestamp()) {
    for (const [key, handoff] of handoffs) {
      if (handoff.expiresAt <= at) handoffs.delete(key);
    }
    while (handoffs.size >= MAX_HANDOFFS) handoffs.delete(handoffs.keys().next().value);
    const code = crypto.randomBytes(32).toString('base64url');
    handoffs.set(sessionKey(code), {
      accountId: account.id,
      credentialVersion: account.credentialVersion,
      expiresAt: at + HANDOFF_TTL_MS,
    });
    return code;
  }

  function loginFailure(sendJson, res, clientKey, headers) {
    const result = recordFailure(clientKey);
    if (result.status === 429) {
      return reply(sendJson, res, 429, { error: '尝试次数过多，请稍后重试。' }, headers, {
        'Retry-After': String(result.retryAfter),
      });
    }
    return reply(sendJson, res, 401, { error: '登录失败，请检查管理密码后重试。' }, headers);
  }

  async function handleSession(req, res, {
    clientKey,
    secure = false,
    headers = {},
    sendJson,
    readJson,
    // The server wrapper must set this only for a validated account-host login request.
    handoff = false,
    consoleOrigin,
    isAccountBlocked = () => false,
  } = {}) {
    if (req.method === 'GET' && accountStore) {
      const account = identity(req);
      if (account && isAccountBlocked(account.id)) {
        return reply(sendJson, res, 403, { authenticated: false, error: '账号已被管理员封禁' }, headers);
      }
      const context = cookieContext(req);
      const extra = context && !account && sessionCookie(req)
        ? { 'Set-Cookie': expiredCookie(context.secure, context.name) }
        : {};
      return reply(sendJson, res, 200, { authenticated: Boolean(account), ...(account ? { account } : {}) }, headers, extra);
    }

    if (req.method === 'DELETE') {
      const context = cookieContext(req, secure);
      if (!context) return reply(sendJson, res, 403, { error: '不允许从这个地址退出。' }, headers);
      const id = sessionCookie(req);
      const key = id ? sessionKey(id) : '';
      const revoked = key ? sessions.get(key) : null;
      if (revoked && accountStore) {
        sessions.delete(key);
        try { persistSessions(); }
        catch (error) { sessions.set(key, revoked); throw error; }
      } else if (revoked) {
        sessions.delete(key);
      }
      return reply(sendJson, res, 200, { authenticated: false }, headers, {
        'Set-Cookie': expiredCookie(context.secure, context.name),
      });
    }

    if (req.method !== 'POST') {
      return reply(sendJson, res, 405, { error: '仅支持登录或退出。' }, headers, { Allow: accountStore ? 'GET, POST, DELETE' : 'POST, DELETE' });
    }

    if (handoff && !accountStore) return reply(sendJson, res, 404, { error: '没有这个登录入口。' }, headers);
    if (handoff && !isOrigin(consoleOrigin)) return reply(sendJson, res, 400, { error: '登录交接目标无效。' }, headers);
    if (accountStore && !cookieContext(req)) {
      return reply(sendJson, res, 403, { error: '账号登录需要 HTTPS 或本机回环连接。' }, headers);
    }

    if (!accountStore && !configuredTokens.length) {
      return isLoopback(req)
        ? reply(sendJson, res, 200, { authenticated: true }, headers)
        : reply(sendJson, res, 401, { error: '登录失败，请检查管理密码后重试。' }, headers);
    }

    const retryAfter = retryAfterFor(clientKey);
    if (retryAfter) {
      return reply(sendJson, res, 429, { error: '尝试次数过多，请稍后重试。' }, headers, { 'Retry-After': String(retryAfter) });
    }

    const invalidRequest = validateJsonRequest(req, headers, sendJson, res);
    if (invalidRequest) return invalidRequest;

    const parsed = await parseJson(req, res, { headers, sendJson, readJson });
    if (parsed.response) return parsed.response;
    const body = parsed.body;

    if (accountStore) {
      const username = body && typeof body === 'object' && !Array.isArray(body) && typeof body.username === 'string'
        ? body.username
        : '';
      const password = body && typeof body === 'object' && !Array.isArray(body) && typeof body.password === 'string'
        ? body.password
        : '';
      if (!username || Buffer.byteLength(username, 'utf8') > 256 || !password || Buffer.byteLength(password, 'utf8') > 1024) {
        return loginFailure(sendJson, res, clientKey, headers);
      }
      if (inFlightAuthentications >= MAX_AUTHENTICATIONS) {
        return reply(sendJson, res, 429, { error: '尝试次数过多，请稍后重试。' }, headers, { 'Retry-After': '1' });
      }

      let authenticated;
      inFlightAuthentications += 1;
      try {
        authenticated = normalizeAccount(await accountStore.authenticate(username, password));
      } catch {
        authenticated = null;
      } finally {
        inFlightAuthentications -= 1;
      }

      if (!authenticated) return loginFailure(sendJson, res, clientKey, headers);
      const current = readLatestAccount(authenticated.id);
      if (current && current !== ACCOUNT_LOOKUP_FAILED && isAccountBlocked(current.id)) {
        return reply(sendJson, res, 403, { error: '账号已被管理员封禁，无法登录。' }, headers);
      }
      if (current === ACCOUNT_LOOKUP_FAILED || !current || current.credentialVersion !== authenticated.credentialVersion) {
        return loginFailure(sendJson, res, clientKey, headers);
      }

      clearClientFailures(clientKey);
      if (handoff) {
        return reply(sendJson, res, 200, {
          authenticated: true,
          loginCode: createHandoff(current),
          consoleOrigin,
        }, headers);
      }

      const issued = issueSession(current);
      const context = cookieContext(req);
      return reply(sendJson, res, 200, { authenticated: true, account: projectAccount(current) }, headers, {
        'Set-Cookie': cookieHeader(issued.id, context.secure, issued.expiresAt, context.name),
      });
    }

    const password = body && typeof body === 'object' && !Array.isArray(body) && typeof body.password === 'string'
      ? body.password
      : '';
    if (!password || Buffer.byteLength(password, 'utf8') > 1024 || !matchesToken(password)) {
      return loginFailure(sendJson, res, clientKey, headers);
    }

    clearClientFailures(clientKey);
    const issued = issueSession(null);
    return reply(sendJson, res, 200, { authenticated: true }, headers, {
      'Set-Cookie': cookieHeader(issued.id, Boolean(secure), issued.expiresAt),
    });
  }

  async function handleExchange(req, res, {
    clientKey,
    secure = false,
    headers = {},
    sendJson,
    readJson,
    isAccountBlocked = () => false,
  } = {}) {
    if (!accountStore) return reply(sendJson, res, 404, { error: '没有这个登录入口。' }, headers);
    const context = cookieContext(req);
    if (!context) return reply(sendJson, res, 403, { error: '账号登录需要 HTTPS 或本机回环连接。' }, headers);
    if (req.method !== 'POST') {
      return reply(sendJson, res, 405, { error: '仅支持 POST。' }, headers, { Allow: 'POST' });
    }

    const retryAfter = retryAfterFor(clientKey);
    if (retryAfter) {
      return reply(sendJson, res, 429, { error: '尝试次数过多，请稍后重试。' }, headers, { 'Retry-After': String(retryAfter) });
    }

    const invalidRequest = validateJsonRequest(req, headers, sendJson, res);
    if (invalidRequest) return invalidRequest;
    const parsed = await parseJson(req, res, { headers, sendJson, readJson });
    if (parsed.response) return parsed.response;

    const code = parsed.body && typeof parsed.body === 'object' && !Array.isArray(parsed.body) && typeof parsed.body.code === 'string'
      ? parsed.body.code
      : '';
    const at = timestamp();
    let handoff = null;
    if (HANDOFF_CODE_PATTERN.test(code)) {
      const key = sessionKey(code);
      handoff = handoffs.get(key) || null;
      // Consume before validating account state so every presented valid code is one-shot.
      if (handoff) handoffs.delete(key);
    }

    if (!handoff || handoff.expiresAt <= at) return loginFailure(sendJson, res, clientKey, headers);
    const account = readLatestAccount(handoff.accountId);
    if (account && account !== ACCOUNT_LOOKUP_FAILED && isAccountBlocked(account.id)) return reply(sendJson, res, 403, { error: '账号已被管理员封禁，无法登录。' }, headers);
    if (account === ACCOUNT_LOOKUP_FAILED || !account || account.credentialVersion !== handoff.credentialVersion) {
      return loginFailure(sendJson, res, clientKey, headers);
    }

    clearClientFailures(clientKey);
    const issued = issueSession(account, at);
    return reply(sendJson, res, 200, { authenticated: true, account: projectAccount(account) }, headers, {
      'Set-Cookie': cookieHeader(issued.id, context.secure, issued.expiresAt, context.name),
    });
  }

  // Call after an authenticated password change to rotate a now-stale session.
  function replaceSession(req, res, { secure = false, headers = {}, sendJson } = {}, account) {
    if (!accountStore) return reply(sendJson, res, 404, { error: '没有这个登录入口。' }, headers);
    const context = cookieContext(req);
    if (!context) return reply(sendJson, res, 403, { error: '账号登录需要 HTTPS 或本机回环连接。' }, headers);
    const accountId = account && typeof account.id === 'string' ? account.id : '';
    const current = accountId ? readLatestAccount(accountId) : null;
    if (!current || current === ACCOUNT_LOOKUP_FAILED) {
      return reply(sendJson, res, 401, { error: '登录状态已失效，请重新登录。' }, headers, {
        'Set-Cookie': expiredCookie(context.secure, context.name),
      });
    }
    const oldId = sessionCookie(req);
    if (oldId) sessions.delete(sessionKey(oldId));
    const issued = issueSession(current);
    return reply(sendJson, res, 200, { authenticated: true, account: projectAccount(current) }, headers, {
      'Set-Cookie': cookieHeader(issued.id, context.secure, issued.expiresAt, context.name),
    });
  }

  return {
    enabled: configuredTokens.length > 0 || Boolean(accountStore),
    hasSession,
    identity,
    authorize,
    authorizedScope,
    handleSession,
    handleExchange,
    replaceSession,
  };
}

module.exports = { createAdminAuth };