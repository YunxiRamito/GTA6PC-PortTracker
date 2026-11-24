'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const ROUTE = '/api/traffic';
const DEFAULT_FILE = path.join(__dirname, '..', '.runtime', 'traffic.json');
const COOKIE = 'traffic_session';
const MAX_BODY_BYTES = 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;
const HOST = /^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::\d+)?$/i;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function isUuid(value) {
  return typeof value === 'string' && value.length === 36 && UUID_V4.test(value);
}

function sendJson(res, status, data, headers) {
  if (res.destroyed) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function allowsPost(headers, secure) {
  const { host, origin, 'sec-fetch-site': site } = headers;
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  if (typeof host !== 'string' || !HOST.test(host)) return false;
  try {
    // Compare the full serialized origin. Do not trust client-supplied forwarding headers.
    const expected = new URL(`${secure ? 'https' : 'http'}://${host}`).origin;
    return origin === undefined || origin === expected;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const onEnd = () => resolve(Buffer.concat(chunks, bytes));
    function onData(chunk) {
      if (bytes + chunk.length > MAX_BODY_BYTES) {
        // Stop collecting and let the handler send a 413 before closing the connection.
        req.pause();
        req.off('data', onData);
        req.off('end', onEnd);
        resolve(null);
        return;
      }
      bytes += chunk.length;
      chunks.push(chunk);
    }
    req.once('end', onEnd);
    req.once('error', reject);
    req.on('data', onData);
  });
}

function sessionFrom(header) {
  if (typeof header !== 'string') return undefined;
  for (const entry of header.split(';')) {
    const token = entry.trim();
    if (!token.startsWith(`${COOKIE}=`)) continue;
    const id = token.slice(COOKIE.length + 1);
    if (isUuid(id)) return id.toLowerCase();
  }
}

async function storeTotal(file, totalVisits) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify({ totalVisits })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

function createTrafficHandler({
  filePath = DEFAULT_FILE, now = Date.now, windowMs = 90_000,
  publicOrigin = '' || '',
  mergeSnapshot = local => local,
  peerFresh, defaultLocalRead = false,
} = {}) {
  const upstream = publicOrigin ? new URL(publicOrigin) : null;
  if (upstream && (upstream.protocol !== 'https:' || upstream.origin !== publicOrigin)) {
    throw new Error('TRACKER_PUBLIC_ORIGIN must be an HTTPS origin with no path');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new RangeError('windowMs must be a positive integer');
  }

  const file = path.resolve(filePath);
  const windowSeconds = windowMs / 1000;
  const browsers = new Map(); // Session cookie -> expiry
  const pages = new Map(); // Page UUID -> in-memory visit and retry state
  const listeners = new Set();
  let savedTotal;
  let queue = Promise.resolve();

  async function loadTotal() {
    if (savedTotal !== undefined) return savedTotal;
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Object.keys(data).length !== 1 ||
        !Object.hasOwn(data, 'totalVisits') || !Number.isSafeInteger(data.totalVisits) || data.totalVisits < 0) {
      throw new Error('Invalid traffic storage');
    }
    savedTotal = data.totalVisits;
    return savedTotal;
  }

  function snapshot(totalVisits, time) {
    let online = 0;
    for (const expiresAt of browsers.values()) if (expiresAt > time) online++;
    return { online, totalVisits, windowSeconds };
  }

  function enqueue(task) {
    const work = queue.then(task);
    queue = work.then(() => {}, () => {});
    return work;
  }

  function readSnapshot({ local = false } = {}) {
    return enqueue(async () => {
      const current = snapshot(await loadTotal(), now());
      return local ? current : mergeSnapshot(current);
    });
  }

  function describe(local) {
    if (local || !peerFresh) return { scope: 'local' };
    return { scope: 'combined', peerFresh: peerFresh() };
  }

  async function trafficHandler(req, res) {
    const fail = (status, error, headers) => sendJson(res, status, { error }, headers);
    const [route, query] = (req.url || '').split('?', 2);
    if (route !== ROUTE) return fail(404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'POST') {
      return fail(405, 'Method not allowed', { Allow: 'GET, POST' });
    }

    const scope = new URLSearchParams(query).get('scope');
    const local = req.method === 'GET' && (scope === 'local' || (defaultLocalRead && scope !== 'combined'));
    let update;
    // A local reverse proxy may terminate TLS, but forwarding headers are
    // trusted only for the exact HTTPS origin configured by the operator.
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const secure = req.socket?.encrypted === true || Boolean(upstream && loopback &&
      req.headers.host?.toLowerCase() === upstream.host && req.headers['x-forwarded-proto'] === 'https');
    if (req.method === 'POST') {
      const close = { Connection: 'close' };
      if (!allowsPost(req.headers, secure)) return fail(403, 'Origin not allowed', close);
      const encoding = req.headers['content-encoding'];
      if (!JSON_TYPE.test(req.headers['content-type'] || '') ||
          (encoding !== undefined && encoding.toLowerCase() !== 'identity')) {
        return fail(415, 'Expected an uncompressed JSON body', close);
      }
      if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
        return fail(413, 'Request body too large', close);
      }

      let data;
      try {
        const body = await readBody(req);
        if (body === null) return fail(413, 'Request body too large', close);
        data = JSON.parse(utf8.decode(body));
      } catch {
        return fail(400, 'Invalid JSON body', close);
      }
      if (!data || typeof data !== 'object' || Object.keys(data).length !== 2 ||
          !Object.hasOwn(data, 'pageId') || !Object.hasOwn(data, 'visit') ||
          !isUuid(data.pageId) || typeof data.visit !== 'boolean') {
        return fail(400, 'Expected a page UUID v4 and a boolean visit');
      }
      update = { pageId: data.pageId.toLowerCase(), visit: data.visit, cookie: sessionFrom(req.headers.cookie) };
    }

    // Serialize from the first read through the disk commit and in-memory update.
    const work = update ? enqueue(async () => {
      let total = await loadTotal();
      const time = now();
      for (const [id, expiresAt] of browsers) if (expiresAt <= time) browsers.delete(id);
      for (const [id, page] of pages) if (page.expiresAt <= time) pages.delete(id);

      const page = pages.get(update.pageId);
      // A retry may arrive before the browser received the first Set-Cookie.
      const sessionId = update.cookie || page?.sessionId || randomUUID();
      const counted = page?.counted || update.visit;
      if (update.visit && !page?.counted) {
        const next = total + 1;
        if (!Number.isSafeInteger(next)) throw new Error('Traffic counter overflow');
        await storeTotal(file, next);
        total = savedTotal = next;
      }

      // Heartbeats extend the sliding retry window as well as browser presence.
      const expiresAt = time + windowMs;
      pages.set(update.pageId, { sessionId, counted, expiresAt });
      browsers.set(sessionId, expiresAt);
      const headers = update.cookie ? undefined : {
        'Set-Cookie': `${COOKIE}=${sessionId}; Path=${ROUTE}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
      };
      return { data: mergeSnapshot(snapshot(total, time)), headers };
    }) : readSnapshot({ local }).then(data => ({ data }));

    let result;
    try {
      result = await work;
    } catch {
      return fail(503, 'Traffic counter unavailable');
    }
    const { scope: countScope, peerFresh: synced } = describe(local);
    sendJson(res, 200, result.data, {
      ...result.headers,
      'X-Traffic-Scope': countScope,
      ...(countScope === 'combined' ? { 'X-Traffic-Peer-State': synced ? 'live' : 'stale' } : {}),
    });
    if (update) for (const listener of listeners) listener();
  }

  trafficHandler.readSnapshot = readSnapshot;
  trafficHandler.combineSnapshot = mergeSnapshot;
  trafficHandler.describe = describe;
  trafficHandler.subscribe = listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return trafficHandler;
}

module.exports = { createTrafficHandler };
