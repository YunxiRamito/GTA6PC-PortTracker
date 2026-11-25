'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const { isIP } = require('node:net');
const { ContentError } = require('./_content');
const { cleanDanmakuText, cleanDanmakuNickname } = require('./_danmaku-filter');

const RETENTION = 30 * 86_400_000;
const RETENTION_DAYS = RETENTION / 86_400_000;
const MAX_RECORDS = 50_000;
const MAX_LINE_BYTES = 2048;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const SUBJECT = /^[a-f\d]{64}$/;
const AVATAR = /^[a-f\d]{32}$/;
const COLORS = new Set(['default', 'mint', 'sky', 'rose', 'lemon', 'admin-teal', 'moderator-teal', 'hatsune-green', 'owner-red', 'gold', 'orange']);
const STAFF = new Set(['owner', 'admin', 'moderator']);
const isGroupTag = value => Number.isInteger(value) && value >= 1 && value <= 8;
const MESSAGE_FIELDS = ['kind', 'admin', 'nickname', 'color', 'staff', 'member', 'sponsor', 'avatar', 'likes', 'groupTag'];
const invalid = () => new ContentError(400, '弹幕历史记录或分页参数有误，请刷新后重试');
const unavailable = () => new ContentError(503, '弹幕历史暂时不可用');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));
const validTime = time => Number.isSafeInteger(time) && time >= 0 && time <= 8_640_000_000_000_000;
const validDate = date => typeof date === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(date) &&
  !Number.isNaN(Date.parse(date)) && new Date(date).toISOString() === date;

function normalize(record) {
  const message = record?.message;
  const moderationText = message?.kind === 'moderation' && typeof message.text === 'string' &&
    message.text.length > 0 && message.text.length <= 300 && Buffer.byteLength(message.text) <= 900 &&
    message.text === message.text.normalize('NFC').trim() &&
    !/[\p{Cc}\p{Cs}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(message.text);
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      !message || typeof message !== 'object' || Array.isArray(message) ||
      typeof message.id !== 'string' || !UUID.test(message.id) || typeof message.text !== 'string' ||
      !(moderationText || cleanDanmakuText(message.text) === message.text) ||
      !validDate(message.createdAt) || !validTime(record.receivedAt) ||
      (record.subject !== undefined && (typeof record.subject !== 'string' || !SUBJECT.test(record.subject))) ||
      (record.deviceSubject !== undefined && (typeof record.deviceSubject !== 'string' || !SUBJECT.test(record.deviceSubject))) ||
      (record.ip !== undefined && (typeof record.ip !== 'string' || record.ip.length > 45 || isIP(record.ip) === 0)) ||
      (message.nickname !== undefined && (typeof message.nickname !== 'string' ||
        (cleanDanmakuNickname(message.nickname) !== message.nickname &&
          !(message.nickname === '系统' && message.admin === true && message.staff === 'moderator')))) ||
      (message.color !== undefined && !COLORS.has(message.color)) ||
      (message.staff !== undefined && !STAFF.has(message.staff)) ||
      (message.avatar !== undefined && (typeof message.avatar !== 'string' || !AVATAR.test(message.avatar))) ||
      (message.likes !== undefined && (!Number.isSafeInteger(message.likes) || message.likes < 1 || message.likes > 1000)) ||
      (message.admin !== undefined && message.admin !== true) ||
      (message.member !== undefined && message.member !== true) ||
      (message.sponsor !== undefined && message.sponsor !== true) ||
      (message.sponsor === true && message.member !== true) ||
      (message.groupTag !== undefined && !isGroupTag(message.groupTag)) ||
      (message.kind !== undefined && message.kind !== 'moderation')) throw invalid();

  const cleanMessage = {
    id: message.id, text: message.text, createdAt: message.createdAt,
    ...Object.fromEntries(MESSAGE_FIELDS
      .filter(key => message[key] !== undefined).map(key => [key, message[key]])),
  };
  if (cleanMessage.kind === 'moderation' && (cleanMessage.admin || cleanMessage.member || cleanMessage.staff || cleanMessage.groupTag)) throw invalid();
  return {
    message: cleanMessage, receivedAt: record.receivedAt,
    ...(record.subject === undefined ? {} : { subject: record.subject }),
    ...(record.deviceSubject === undefined ? {} : { deviceSubject: record.deviceSubject }),
    ...(record.ip === undefined ? {} : { ip: record.ip }),
  };
}

function publicRecord(record) {
  return { message: { ...record.message }, receivedAt: record.receivedAt };
}

function adminRecord(record) {
  return { ...publicRecord(record), ...(record.subject && { subject: record.subject }),
    ...(record.deviceSubject && { deviceSubject: record.deviceSubject }), ...(record.ip && { ip: record.ip }) };
}

function line(value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length > MAX_LINE_BYTES) throw invalid();
  return bytes;
}

function readHistoryFile(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > maxBytes || stat.size < 1) throw new Error('Invalid history file');
  // O_NONBLOCK prevents a substituted FIFO from blocking startup.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Invalid history file');
    const data = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(fd, data, offset, data.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset !== stat.size) throw new Error('History changed while loading');
    return data.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

function createDanmakuHistory({ filePath, now = Date.now } = {}) {
  if (typeof filePath !== 'string' || !filePath || typeof now !== 'function') throw new TypeError('filePath and now are required');
  const file = path.resolve(filePath);
  let secret = randomBytes(32).toString('hex');
  const records = new Map();
  let size = 0;
  let liveBytes = 0;
  let oldest = Infinity;
  let dirty = false;
  let broken = false;
  let closed = false;
  let pending = Promise.resolve();
  let lastTask = pending;

  function time() {
    const value = now();
    if (!validTime(value)) throw new TypeError('now must return a valid millisecond timestamp');
    return value;
  }

  function check() {
    if (broken || closed) throw unavailable();
  }

  function prune() {
    check();
    const cutoff = time() - RETENTION;
    if (oldest > cutoff) return;
    oldest = Infinity;
    for (const [id, record] of records) {
      if (record.receivedAt <= cutoff) {
        records.delete(id);
        liveBytes -= line({ op: 'add', record }).length;
        dirty = true;
      } else oldest = Math.min(oldest, record.receivedAt);
    }
  }

  try {
    const data = readHistoryFile(file, MAX_FILE_BYTES);
    size = data.length;
    if (data[size - 1] !== 10) throw new Error('Incomplete history log');
    const lines = data.subarray(0, size).toString('utf8').split('\n');
    lines.pop();
    if (lines.some(item => Buffer.byteLength(item + '\n') > MAX_LINE_BYTES || !item)) throw new Error('Oversized history line');
    const header = JSON.parse(lines.shift());
    if (!exactKeys(header, ['version', 'secret']) || header.version !== 1 || typeof header.secret !== 'string' || !SUBJECT.test(header.secret)) {
      throw new Error('Invalid history header');
    }
    secret = header.secret;
    for (const raw of lines) {
      const entry = JSON.parse(raw);
      if (entry?.op === 'add' && exactKeys(entry, ['op', 'record']) && exactKeys(entry.record, ['message', 'receivedAt', 'subject', 'deviceSubject', 'ip']) &&
          exactKeys(entry.record.message, ['id', 'text', 'createdAt', ...MESSAGE_FIELDS])) {
        const record = normalize(entry.record);
        if (records.has(record.message.id) || records.size >= MAX_RECORDS) throw new Error('Invalid history entry');
        records.set(record.message.id, record);
        liveBytes += line({ op: 'add', record }).length;
        oldest = Math.min(oldest, record.receivedAt);
      } else if (entry?.op === 'remove' && exactKeys(entry, ['op', 'ids']) && Array.isArray(entry.ids) &&
          entry.ids.length > 0 && entry.ids.length <= 32 && entry.ids.every(id => typeof id === 'string' && UUID.test(id))) {
        for (const id of entry.ids) {
          const record = records.get(id);
          if (record) liveBytes -= line({ op: 'add', record }).length;
          records.delete(id);
        }
      } else throw new Error('Invalid history entry');
    }
    prune();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      broken = true;
      records.clear();
      console.error('Cannot read danmaku history:', error.code || error.name);
    }
  }

  function enqueue(task) {
    const job = pending.then(() => { check(); return task(); });
    pending = job.catch(() => {});
    lastTask = job;
    return job;
  }

  async function write(bytes) {
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      if (size && !(await fs.promises.lstat(file)).isFile()) throw new Error('History storage changed');
      const handle = await fs.promises.open(file, size ? 'r+' : 'wx', 0o600);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== size || stat.size + bytes.length > MAX_FILE_BYTES) throw new Error('History storage changed');
        await handle.chmod(0o600);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, size + offset);
          if (!bytesWritten) throw new Error('Short history write');
          offset += bytesWritten;
        }
        await handle.sync();
        size += bytes.length;
      } finally {
        await handle.close();
      }
    } catch (error) {
      broken = true;
      console.error('Cannot write danmaku history:', error.code || error.name);
      throw unavailable();
    }
  }

  async function compact() {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const handle = await fs.promises.open(temp, 'wx', 0o600);
      let length = 0;
      try {
        for (const entry of [line({ version: 1, secret }), ...[...records.values()].map(record => line({ op: 'add', record }))]) {
          length += entry.length;
          if (length > MAX_FILE_BYTES) throw new Error('History capacity exceeded');
          await handle.writeFile(entry);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.promises.rename(temp, file);
      size = length;
      dirty = false;
    } catch (error) {
      await fs.promises.unlink(temp).catch(() => {});
      broken = true;
      console.error('Cannot compact danmaku history:', error.code || error.name);
      throw unavailable();
    }
  }

  async function append(entry) {
    const bytes = line(entry);
    if (!size || size > Math.max(1024 * 1024, 2 * liveBytes) ||
        size + bytes.length > MAX_FILE_BYTES) await compact();
    if (size + bytes.length > MAX_FILE_BYTES) throw unavailable();
    await write(bytes);
  }

  function add(input) {
    return enqueue(async () => {
      prune();
      const record = normalize(input);
      const current = time();
      if (record.receivedAt <= current - RETENTION || record.receivedAt > current) throw invalid();
      if (records.has(record.message.id)) throw new ContentError(409, 'Danmaku history entry already exists');
      if (records.size >= MAX_RECORDS) throw unavailable();
      await append({ op: 'add', record });
      records.set(record.message.id, record);
      liveBytes += line({ op: 'add', record }).length;
      oldest = Math.min(oldest, record.receivedAt);
      return publicRecord(record);
    });
  }

  // Internal startup snapshot in journal order; never return source IPs to the replay buffer.
  function recentForReplay({ maxAge = RETENTION, limit, include }) {
    prune();
    if (!Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > RETENTION ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORDS) throw invalid();
    const current = time();
    const cutoff = current - maxAge;
    const recent = [];
    for (const record of records.values()) {
      if (record.receivedAt > cutoff && record.receivedAt <= current &&
          (!include || include(record.message, record.subject, record.deviceSubject))) recent.push(record);
    }
    return recent.slice(-limit).map(record => ({
      ...publicRecord(record), subject: record.subject, deviceSubject: record.deviceSubject,
    }));
  }

  function getRecord(id) {
    prune();
    if (typeof id !== 'string' || !UUID.test(id)) throw invalid();
    return records.get(id);
  }

  function get(id) {
    const record = getRecord(id);
    return record && publicRecord(record);
  }

  // Callers must authorize the admin action before requesting this projection.
  function getForModeration(id) {
    const record = getRecord(id);
    return record && adminRecord(record);
  }

  function flush() {
    return lastTask.then(() => { check(); });
  }

  function findBySubjects(subjects) {
    prune();
    if (!Array.isArray(subjects) || subjects.length > MAX_RECORDS || subjects.some(subject => typeof subject !== 'string' || !SUBJECT.test(subject))) throw invalid();
    const targets = new Set(subjects);
    return [...records.values()].filter(record => targets.has(record.subject) || targets.has(record.deviceSubject)).map(publicRecord);
  }

  function remove(ids) {
    return enqueue(async () => {
      prune();
      if (!Array.isArray(ids) || ids.length > MAX_RECORDS || ids.some(id => typeof id !== 'string' || !UUID.test(id))) throw invalid();
      const found = [...new Set(ids)].filter(id => records.has(id));
      for (let offset = 0; offset < found.length; offset += 32) {
        const batch = found.slice(offset, offset + 32);
        await append({ op: 'remove', ids: batch });
        for (const id of batch) {
          liveBytes -= line({ op: 'add', record: records.get(id) }).length;
          records.delete(id);
        }
      }
      return found;
    });
  }

  function cursorFor(record) {
    const payload = Buffer.from(JSON.stringify([1, record.receivedAt, record.message.id])).toString('base64url');
    const mac = createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  function decodeCursor(cursor) {
    if (typeof cursor !== 'string' || cursor.length > 256 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
    const [payload, signature] = cursor.split('.');
    const expected = createHmac('sha256', secret).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw invalid();
    let parsed;
    try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw invalid(); }
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== 1 || !validTime(parsed[1]) ||
        typeof parsed[2] !== 'string' || !UUID.test(parsed[2]) ||
        Buffer.from(JSON.stringify(parsed)).toString('base64url') !== payload ||
        records.get(parsed[2])?.receivedAt !== parsed[1]) throw invalid();
    return parsed;
  }

  function list({ cursor, limit = 100 } = {}) {
    prune();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid();
    const anchor = cursor === undefined ? null : decodeCursor(cursor);
    const ordered = [...records.values()].sort((a, b) => b.receivedAt - a.receivedAt || b.message.id.localeCompare(a.message.id));
    const start = anchor ? ordered.findIndex(item => item.message.id === anchor[2]) + 1 : 0;
    const page = ordered.slice(start, start + limit);
    const hasMore = start + page.length < ordered.length;
    return { records: page.map(adminRecord), nextCursor: hasMore ? cursorFor(page.at(-1)) : null, hasMore };
  }

  function purgeExpired() {
    return enqueue(async () => {
      prune();
      if (dirty) await compact();
    });
  }

  function close() {
    const job = pending.then(async () => {
      if (closed) return;
      check();
      prune();
      if (dirty) await compact();
      closed = true;
    });
    pending = job.catch(() => {});
    return job;
  }

  return { add, recentForReplay, get, getForModeration, findBySubjects, remove, list, flush, purgeExpired, close };
}

// The mirror stores only the validated public drawer response, apart from its local moderation journal.
function createPublicHistorySnapshot({ filePath, maxMessages, maxBytes, projectMessage }) {
  let snapshot = { version: 1, closed: false, messages: [] };
  let saved;
  let pending = Promise.resolve();
  const encode = value => JSON.stringify(value) + '\n';

  try {
    const data = readHistoryFile(filePath, maxBytes).toString('utf8');
    const value = JSON.parse(data);
    if (value?.version !== 1 || typeof value.closed !== 'boolean' || !Array.isArray(value.messages) ||
        value.messages.length > maxMessages || (value.closed && value.messages.length)) {
      throw new Error('Invalid public history snapshot');
    }
    const messages = value.messages.map(projectMessage);
    if (messages.some(message => !message)) throw new Error('Invalid public history message');
    snapshot = { version: 1, closed: value.closed, messages };
    saved = data;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      snapshot = null;
      console.error('Cannot read mirror public danmaku history:', error.code || error.name);
    }
  }

  let requested = saved;
  function write({ closed, messages }) {
    const next = { version: 1, closed, messages };
    const bytes = encode(next);
    snapshot = next;
    requested = bytes;
    pending = pending.then(async () => {
      if (bytes !== requested || bytes === saved) return;
      const temp = `${filePath}.${randomUUID()}.tmp`;
      try {
        if (Buffer.byteLength(bytes) > maxBytes) throw new Error('Oversized public history snapshot');
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const handle = await fs.promises.open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.promises.rename(temp, filePath);
        saved = bytes;
      } catch (error) {
        await fs.promises.unlink(temp).catch(() => {});
        // An older snapshot may contain a withdrawal or predate a closure.
        await fs.promises.unlink(filePath).catch(() => {});
        saved = undefined;
        console.error('Cannot save mirror public danmaku history:', error.code || error.name);
      }
    });
    return pending;
  }

  return { read: () => snapshot, write, flush: () => pending };
}

module.exports = { createDanmakuHistory, createPublicHistorySnapshot, RETENTION_DAYS, isGroupTag };
