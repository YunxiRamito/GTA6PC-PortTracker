'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const PUBLIC_FEEDBACK = '/api/feedback';
const PUBLIC_REPLIES = '/api/feedback/replies';
const PUBLIC_READ = '/api/feedback/replies/read';
const PUBLIC_NOTICES = '/api/site-notices';
const ADMIN_FEEDBACK = '/api/admin/feedback';
const ADMIN_NOTICES = '/api/admin/site-notices';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_ID = /^[0-9a-f]{64}$/;
const MAX_TEXT = 1000;
const MAX_POPUP_TITLE = 80;
const MAX_LINK_LABEL = 80;
const MAX_LINK_URL = 2048;
const LINK_ORIGIN = 'http://127.0.0.1';
const MAX_READ_IDS = 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FEEDBACK = 2000;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const SUBMISSION_COOLDOWN_MS = 30_000;
const SUBMISSION_WINDOW_MS = 60 * 60_000;
const MAX_SUBMISSIONS_PER_WINDOW = 5;
const MAX_RATE_IDENTITIES = 10_000;

class FeedbackError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUuid = value => typeof value === 'string' && UUID.test(value);
const canonicalTime = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  try { return new Date(value).toISOString() === value; }
  catch { return false; }
};

function validUnicode(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function cleanText(value, { allowEmpty = false, label = '内容', max = MAX_TEXT } = {}) {
  if (typeof value !== 'string') throw new FeedbackError(400, `${label}必须是文本`);
  const text = value.trim();
  const length = Array.from(text).length;
  if ((!allowEmpty && length === 0) || length > max || text.includes('\0') || !validUnicode(text)) {
    throw new FeedbackError(400, `${label}长度须为${allowEmpty ? '0–' : '1–'}${max} 个字符`);
  }
  return text;
}

function storedText(value, allowEmpty = false) {
  return typeof value === 'string' && value === value.trim() && (allowEmpty || value.length > 0) &&
    !value.includes('\0') && validUnicode(value) && Array.from(value).length <= MAX_TEXT;
}

function cleanPopupTitle(value) {
  const title = cleanText(value, { allowEmpty: true, label: '弹窗标题', max: MAX_POPUP_TITLE });
  if (/[\r\n\u2028\u2029]/.test(title)) throw new FeedbackError(400, '弹窗标题须写在同一行');
  return title;
}

function cleanHeaderLink(value, header) {
  if (value == null) return null;
  if (!header || !isObject(value)) throw new FeedbackError(400, '请为页头公告填写链接地址和显示文字');
  const label = cleanText(value.label, { label: '链接显示文字', max: MAX_LINK_LABEL });
  if (/[\r\n]/.test(label)) throw new FeedbackError(400, '链接显示文字须写在同一行');
  const url = cleanText(value.url, { label: '链接地址', max: MAX_LINK_URL });
  const relative = /^(?:\/(?!\/)|#)/.test(url);
  const https = /^https:\/\/[^/?#]/i.test(url);
  if ((relative || https) && !/[\s\x00-\x1f\x7f\\]/.test(url)) {
    let parsed;
    try { parsed = new URL(url, LINK_ORIGIN); } catch { /* Report invalid URLs below. */ }
    if (parsed && (relative ? parsed.origin === LINK_ORIGIN : parsed.protocol === 'https:' && !parsed.username && !parsed.password)) {
      return { label, url };
    }
  }
  throw new FeedbackError(400, '链接地址须使用 HTTPS、以 / 开头的站内路径或以 # 开头的页内锚点');
}

function blankStore() {
  return { version: 1, feedback: [], notices: { header: '', popup: null } };
}

function normalizeStore(value) {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.feedback) ||
      value.feedback.length > MAX_FEEDBACK || !isObject(value.notices)) throw new Error('Invalid feedback store');

  const ids = new Set();
  const feedback = value.feedback.map(item => {
    if (!isObject(item) || !isUuid(item.id) || ids.has(item.id) ||
        typeof item.ownerHash !== 'string' || !/^[0-9a-f]{64}$/.test(item.ownerHash) ||
        !storedText(item.text) || !canonicalTime(item.createdAt)) throw new Error('Invalid feedback record');
    ids.add(item.id);

    let reply = null;
    if (item.reply !== null) {
      if (!isObject(item.reply) || !isUuid(item.reply.id) || !storedText(item.reply.text) ||
          !canonicalTime(item.reply.repliedAt) || typeof item.reply.read !== 'boolean') throw new Error('Invalid feedback reply');
      reply = { id: item.reply.id, text: item.reply.text, repliedAt: item.reply.repliedAt, read: item.reply.read };
    }
    return { id: item.id, ownerHash: item.ownerHash, text: item.text, createdAt: item.createdAt, reply };
  });

  if (!storedText(value.notices.header, true)) throw new Error('Invalid notice header');
  let popup = null;
  if (value.notices.popup !== null) {
    if (!isObject(value.notices.popup) || !isUuid(value.notices.popup.id) || !storedText(value.notices.popup.text)) {
      throw new Error('Invalid popup notice');
    }
    const title = Object.hasOwn(value.notices.popup, 'title') ? cleanPopupTitle(value.notices.popup.title) : '';
    popup = { id: value.notices.popup.id, text: value.notices.popup.text, ...(title && { title }) };
  }
  const header = value.notices.header;
  const headerLink = cleanHeaderLink(value.notices.headerLink, header);
  return { version: 1, feedback, notices: { header, popup, ...(headerLink && { headerLink }) } };
}

function cloneStore(store) {
  return {
    version: 1,
    feedback: store.feedback.map(item => ({ ...item, reply: item.reply ? { ...item.reply } : null })),
    notices: noticesView(store),
  };
}

function noticesView(store) {
  const { header, popup, headerLink } = store.notices;
  return { header, popup: popup ? { ...popup } : null, ...(headerLink && { headerLink: { ...headerLink } }) };
}

function noticesResponse(store) {
  const payload = noticesView(store);
  const etag = `"${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}"`;
  return { payload, headers: { ETag: etag } };
}

function feedbackView(item) {
  return {
    id: item.id,
    text: item.text,
    createdAt: item.createdAt,
    reply: item.reply ? { id: item.reply.id, text: item.reply.text, repliedAt: item.reply.repliedAt } : null,
  };
}

function queryParams(query) {
  if (query instanceof URLSearchParams) return query;
  if (typeof query === 'string') return new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  if (isObject(query)) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) value.forEach(item => params.append(key, String(item)));
      else if (value !== undefined && value !== null) params.set(key, String(value));
    }
    return params;
  }
  return new URLSearchParams();
}

function pageValue(params, key, fallback, min, max) {
  const values = params.getAll(key);
  if (!values.length) return fallback;
  if (values.length !== 1 || !/^(?:0|[1-9]\d*)$/.test(values[0])) throw new FeedbackError(400, '分页参数无效');
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new FeedbackError(400, '分页参数超出范围');
  return value;
}

function createFeedback({ filePath, now = Date.now, readJson, sendJson } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath must be a nonempty string');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof readJson !== 'function') throw new TypeError('readJson must be a function');
  if (typeof sendJson !== 'function') throw new TypeError('sendJson must be a function');

  const file = path.resolve(filePath);
  let store;
  let loadPromise;
  let loadError;
  let pending = Promise.resolve();
  const submissions = new Map();
  let lastRatePrune = -Infinity;

  async function loadStore() {
    let handle;
    try {
      const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
      handle = await fs.open(file, flags);
    } catch (error) {
      if (error.code === 'ENOENT') return blankStore();
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) throw new Error('Invalid feedback store size');
      // Read one byte beyond the observed size so a concurrent append is detected, not read without a bound.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== stat.size) throw new Error('Feedback store changed while reading');
      return normalizeStore(JSON.parse(buffer.toString('utf8', 0, length)));
    } finally {
      await handle.close();
    }
  }

  async function ensureLoaded() {
    if (!loadPromise) {
      loadPromise = loadStore().then(value => { store = value; }).catch(error => { loadError = error; });
    }
    await loadPromise;
    if (loadError) throw new Error('Feedback store unavailable');
    return store;
  }

  async function saveStore(value) {
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error('Feedback store full');
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(serialized);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, file);
      // Directory fsync is available on POSIX but not consistently supported on Windows.
      try {
        const directory = await fs.open(path.dirname(file), 'r');
        try { await directory.sync(); }
        finally { await directory.close(); }
      } catch { /* The data file was fsynced and atomically renamed. */ }
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  function serializeUpdate(mutator) {
    const task = pending.then(async () => {
      const current = await ensureLoaded();
      const next = cloneStore(current);
      const result = mutator(next);
      if (next.feedback.length > MAX_FEEDBACK) throw new FeedbackError(503, '反馈暂存数量已满');
      await saveStore(next);
      store = next;
      return result;
    });
    pending = task.catch(() => {});
    return task;
  }

  async function snapshot() {
    await pending;
    return ensureLoaded();
  }

  function ownerFor(req) {
    const clientId = req?.headers?.['x-feedback-client'];
    if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) throw new FeedbackError(400, '反馈身份无效');
    return createHash('sha256').update('feedback-client\0').update(clientId).digest('hex');
  }

  function isoTime(value) {
    if (!Number.isSafeInteger(value)) throw new Error('Invalid clock value');
    try { return new Date(value).toISOString(); }
    catch { throw new Error('Invalid clock value'); }
  }

  function checkSubmissionRate(ownerHash, time) {
    if (time - lastRatePrune >= 60_000) {
      for (const [key, record] of submissions) {
        record.times = record.times.filter(value => time - value < SUBMISSION_WINDOW_MS);
        if (record.times.length === 0 && time - record.lastAt >= SUBMISSION_WINDOW_MS) submissions.delete(key);
      }
      lastRatePrune = time;
    }

    const record = submissions.get(ownerHash);
    if (record) {
      const cooldown = SUBMISSION_COOLDOWN_MS - (time - record.lastAt);
      if (cooldown > 0) {
        throw new FeedbackError(429, '提交过于频繁，请稍后再试', { 'Retry-After': String(Math.max(1, Math.ceil(cooldown / 1000))) });
      }
      const recent = record.times.filter(value => time - value < SUBMISSION_WINDOW_MS);
      if (recent.length >= MAX_SUBMISSIONS_PER_WINDOW) {
        const retry = recent[0] + SUBMISSION_WINDOW_MS - time;
        throw new FeedbackError(429, '提交次数过多，请稍后再试', { 'Retry-After': String(Math.max(1, Math.ceil(retry / 1000))) });
      }
      record.times = recent;
    } else if (submissions.size >= MAX_RATE_IDENTITIES) {
      // Bound the ephemeral abuse table if clients rotate opaque identities.
      submissions.delete(submissions.keys().next().value);
    }

    const times = record?.times || [];
    times.push(time);
    submissions.delete(ownerHash);
    submissions.set(ownerHash, { times, lastAt: time });
  }

  function send(res, status, payload, headers = {}) {
    return sendJson(res, status, payload, { ...headers, 'Cache-Control': 'no-store' });
  }

  function failure(error) {
    if (error instanceof FeedbackError) return { status: error.status, message: error.message, headers: error.headers };
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
      return { status: error.status, message: typeof error.message === 'string' && error.message ? error.message.slice(0, 200) : '请求无效', headers: {} };
    }
    return { status: 503, message: '反馈服务暂时不可用', headers: {} };
  }

  async function dispatch(res, commonHeaders, action) {
    try {
      const result = await action();
      return send(res, result.status || 200, result.payload, { ...commonHeaders, ...result.headers });
    } catch (error) {
      const result = failure(error);
      return send(res, result.status, { error: result.message }, { ...commonHeaders, ...result.headers });
    }
  }

  function methodNotAllowed(res, headers, allow) {
    return send(res, 405, { error: '请求方法不受支持' }, { ...headers, Allow: allow });
  }

  function handlePublic(req, res, pathname) {
    if (pathname === PUBLIC_FEEDBACK) {
      if (req.method !== 'POST') return methodNotAllowed(res, {}, 'POST');
      return dispatch(res, {}, async () => {
        const body = await readJson(req, MAX_BODY_BYTES);
        const text = cleanText(body?.text, { label: '反馈内容' });
        const ownerHash = ownerFor(req);
        const time = now();
        const createdAt = isoTime(time);
        const feedback = await serializeUpdate(next => {
          if (next.feedback.length >= MAX_FEEDBACK) throw new FeedbackError(503, '反馈暂存数量已满');
          checkSubmissionRate(ownerHash, time);
          const item = { id: randomUUID(), ownerHash, text, createdAt, reply: null };
          next.feedback.push(item);
          return { id: item.id, createdAt: item.createdAt };
        });
        return { status: 201, payload: { feedback } };
      });
    }

    if (pathname === PUBLIC_REPLIES) {
      if (req.method !== 'GET') return methodNotAllowed(res, {}, 'GET');
      return dispatch(res, {}, async () => {
        const ownerHash = ownerFor(req);
        const current = await snapshot();
        const replies = current.feedback
          .filter(item => item.ownerHash === ownerHash && item.reply && !item.reply.read)
          .map(item => ({ id: item.reply.id, text: item.reply.text, repliedAt: item.reply.repliedAt }))
          .sort((a, b) => Date.parse(b.repliedAt) - Date.parse(a.repliedAt));
        return { payload: { replies } };
      });
    }

    if (pathname === PUBLIC_READ) {
      if (req.method !== 'POST') return methodNotAllowed(res, {}, 'POST');
      return dispatch(res, {}, async () => {
        const body = await readJson(req, MAX_BODY_BYTES);
        const ownerHash = ownerFor(req);
        if (!Array.isArray(body?.ids) || body.ids.length > MAX_READ_IDS || !body.ids.every(value => typeof value === 'string' && UUID.test(value))) {
          throw new FeedbackError(400, `ids 必须是最多 ${MAX_READ_IDS} 个有效回复 ID`);
        }
        const ids = new Set(body.ids);
        const marked = await serializeUpdate(next => {
          let count = 0;
          for (const item of next.feedback) {
            if (item.ownerHash === ownerHash && item.reply && !item.reply.read && ids.has(item.reply.id)) {
              item.reply.read = true;
              count += 1;
            }
          }
          return count;
        });
        return { payload: { marked } };
      });
    }

    if (pathname === PUBLIC_NOTICES) {
      if (req.method !== 'GET') return methodNotAllowed(res, {}, 'GET');
      return dispatch(res, {}, async () => ({ payload: noticesView(await snapshot()) }));
    }

    return send(res, 404, { error: '没有这个反馈接口' });
  }

  function handleAdmin(req, res, pathname, query, headers = {}) {
    const commonHeaders = headers ?? {};

    if (pathname === ADMIN_FEEDBACK) {
      if (req.method !== 'GET') return methodNotAllowed(res, commonHeaders, 'GET');
      return dispatch(res, commonHeaders, async () => {
        const params = queryParams(query);
        const offset = pageValue(params, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = pageValue(params, 'limit', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
        const current = await snapshot();
        const feedback = current.feedback.slice().reverse()
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
          .slice(offset, offset + limit).map(feedbackView);
        return { payload: { feedback, offset, total: current.feedback.length } };
      });
    }

    const replyMatch = typeof pathname === 'string' &&
      new RegExp(`^${ADMIN_FEEDBACK}/(${UUID.source.slice(1, -1)})/reply$`).exec(pathname);
    if (replyMatch) {
      if (req.method !== 'PUT') return methodNotAllowed(res, commonHeaders, 'PUT');
      return dispatch(res, commonHeaders, async () => {
        const body = await readJson(req, MAX_BODY_BYTES);
        const text = cleanText(body?.text, { label: '回复内容' });
        const feedback = await serializeUpdate(next => {
          const item = next.feedback.find(record => record.id === replyMatch[1]);
          if (!item) throw new FeedbackError(404, '没有这条反馈');
          item.reply = { id: randomUUID(), text, repliedAt: isoTime(now()), read: false };
          return feedbackView(item);
        });
        return { payload: { feedback } };
      });
    }

    if (pathname === ADMIN_NOTICES) {
      if (req.method === 'GET') return dispatch(res, commonHeaders, async () => noticesResponse(await snapshot()));
      if (req.method !== 'PUT') return methodNotAllowed(res, commonHeaders, 'GET, PUT');
      return dispatch(res, commonHeaders, async () => {
        const body = await readJson(req, MAX_BODY_BYTES);
        const titleOnly = isObject(body) && Object.keys(body).length === 1 && Object.hasOwn(body, 'popupTitle');
        if (!titleOnly && (!isObject(body) || typeof body.header !== 'string' || typeof body.popup !== 'string')) {
          throw new FeedbackError(400, '请提供 header 和 popup 文本');
        }
        const header = titleOnly ? undefined : cleanText(body.header, { allowEmpty: true, label: '公告栏' });
        const popupText = titleOnly ? undefined : cleanText(body.popup, { allowEmpty: true, label: '弹窗公告' });
        const titleInput = Object.hasOwn(body, 'popupTitle') ? cleanPopupTitle(body.popupTitle) : undefined;
        const ifMatch = req.headers?.['if-match'];
        if (titleOnly && ifMatch === undefined) throw new FeedbackError(428, '请先读取公告版本，再保存弹窗标题。');
        if (!titleOnly && titleInput && !popupText) throw new FeedbackError(400, '请填写弹窗正文，或清空弹窗标题');
        const hasLink = Object.hasOwn(body, 'headerLink');
        const proposedLink = cleanHeaderLink(body.headerLink, header);
        return serializeUpdate(next => {
          const current = noticesResponse(next);
          if (ifMatch !== undefined && ifMatch !== current.headers.ETag) {
            throw new FeedbackError(412, '公告已被其他编辑者修改，请重新读取后核对再保存。');
          }
          const previous = next.notices.popup;
          if (titleOnly) {
            if (!previous) throw new FeedbackError(409, '目前没有可补标题的弹窗。');
            const { id, text } = previous;
            next.notices.popup = { id, text, ...(titleInput && { title: titleInput }) };
            return noticesResponse(next);
          }
          const sameText = previous?.text === popupText;
          const title = titleInput ?? (sameText ? previous.title ?? '' : '');
          const popup = popupText ? { id: sameText ? previous.id : randomUUID(), text: popupText, ...(title && { title }) } : null;
          // Keep the old replacement contract for clients that do not send If-Match.
          const headerLink = ifMatch !== undefined && !hasLink && header ? next.notices.headerLink : proposedLink;
          next.notices = { header, popup, ...(headerLink && { headerLink }) };
          return noticesResponse(next);
        });
      });
    }

    return send(res, 404, { error: '没有这个后台反馈接口' }, commonHeaders);
  }

  return { handlePublic, handleAdmin };
}

module.exports = { createFeedback };
