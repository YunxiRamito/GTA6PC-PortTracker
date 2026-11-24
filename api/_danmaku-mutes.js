'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ContentError } = require('./_content');
const { cleanDanmakuText } = require('./_danmaku-filter');

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
const SUBJECT = /^[\da-f]{64}$/;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const DURATIONS = Object.freeze({ '10m': 600_000, '24h': DAY, '3d': 3 * DAY, '7d': 7 * DAY, '30d': 30 * DAY, '180d': 180 * DAY, permanent: null });
const MAX_RECORDS = 3000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const isDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const publicRecord = ({ id, duration, createdAt, expiresAt, message }) => ({ id, duration, createdAt, expiresAt, message });

function parseMuteDuration(value) {
  if (typeof value !== 'string') return undefined;
  if (Object.hasOwn(DURATIONS, value)) return DURATIONS[value];
  if (value === '30m') return 30 * 60_000;
  const match = /^([1-9]\d{0,3})([hd])$/.exec(value);
  if (!match || match[0] !== value) return undefined;
  const amount = Number(match[1]);
  if (match[2] === 'h') return amount <= 4320 ? amount * HOUR : undefined;
  return amount <= 180 ? amount * DAY : undefined;
}

function persistedMute(record) {
  if (Object.hasOwn(DURATIONS, record.duration)) return record;
  const length = parseMuteDuration(record.duration);
  return { ...record, duration: length < DAY ? '10m' : '24h', customDuration: record.duration };
}

function createMuteStore({ filePath, now = Date.now } = {}) {
  let secret = randomBytes(32).toString('hex');
  let records = new Map();
  let broken = false;
  let persisted = false;
  let pending = Promise.resolve();

  if (filePath) {
    try {
      if (fs.statSync(filePath).size > MAX_FILE_BYTES) throw new Error('Oversized danmaku mute data');
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (saved?.version !== 1 || !SUBJECT.test(saved.secret) || !Array.isArray(saved.mutes) || saved.mutes.length > MAX_RECORDS) {
        throw new Error('Invalid danmaku mute data');
      }
      for (const record of saved.mutes) {
        const { id, subject, duration, createdAt, expiresAt, message } = record;
        const hasCustom = Object.hasOwn(record, 'customDuration');
        const canonical = hasCustom ? record.customDuration : duration;
        const length = parseMuteDuration(canonical);
        if (!UUID.test(id) || !SUBJECT.test(subject) || length === undefined || !isDate(createdAt) ||
            (length === null ? expiresAt !== null : !isDate(expiresAt)) ||
            (hasCustom && (length === null || !Object.hasOwn(DURATIONS, duration) ||
              duration !== (length < DAY ? '10m' : '24h') || Date.parse(expiresAt) - Date.parse(createdAt) !== length)) ||
            !UUID.test(message?.id) || !isDate(message?.createdAt) || typeof message?.text !== 'string' ||
            cleanDanmakuText(message.text) !== message.text || records.has(subject)) {
          throw new Error('Invalid danmaku mute record');
        }
        records.set(subject, { id, subject, duration: canonical, createdAt, expiresAt, message: { id: message.id, text: message.text, createdAt: message.createdAt } });
      }
      secret = saved.secret;
      persisted = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        broken = true;
        console.error('Cannot read danmaku moderation data:', error.code || error.name);
      }
    }
  }

  function checkStorage() {
    if (broken) throw new ContentError(503, '弹幕管理暂时不可用');
  }

  const active = (record, time) => record && (record.expiresAt === null || Date.parse(record.expiresAt) > time);

  function get(subject) {
    checkStorage();
    const record = records.get(subject);
    return active(record, now()) ? record : undefined;
  }

  function list() {
    checkStorage();
    const time = now();
    const unique = new Map();
    for (const record of records.values()) if (active(record, time)) unique.set(record.id, record);
    return [...unique.values()].reverse().map(publicRecord);
  }

  async function save(next) {
    if (filePath) {
      const temp = `${filePath}.${randomUUID()}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(temp, JSON.stringify({ version: 1, secret, mutes: [...next.values()].map(persistedMute) }) + '\n', { flag: 'wx', mode: 0o600 });
        await fs.promises.rename(temp, filePath);
        persisted = true;
      } catch (error) {
        await fs.promises.unlink(temp).catch(() => {});
        console.error('Cannot save danmaku moderation data:', error.code || error.name);
        throw new ContentError(503, '禁言记录暂时无法保存');
      }
    }
    records = next;
  }

  function change(update) {
    const task = pending.then(async () => {
      checkStorage();
      const time = now();
      const next = new Map([...records].filter(([, record]) => active(record, time)));
      const result = update(next, time);
      await save(next);
      return result;
    });
    pending = task.catch(() => {});
    return task;
  }

  function mute(subject, duration, message) {
    return muteMany([subject], duration, message);
  }

  function muteMany(subjects, duration, message) {
    return change((next, time) => {
      const length = parseMuteDuration(duration);
      if (length === undefined) throw new ContentError(400, '请选择有效的禁言时长');
      const targets = [...new Set(subjects)];
      if (!targets.length || targets.some(subject => !SUBJECT.test(subject))) throw new ContentError(400, '封禁对象无效');
      if (targets.some(subject => next.has(subject))) throw new ContentError(409, '这位访客已经被禁言');
      if (next.size + targets.length > MAX_RECORDS) throw new ContentError(503, '禁言记录已满，请先清理已有记录');
      const record = {
        id: randomUUID(), duration, createdAt: new Date(time).toISOString(),
        expiresAt: length === null ? null : new Date(time + length).toISOString(),
        message: { id: message.id, text: message.text, createdAt: message.createdAt },
      };
      for (const subject of targets) next.set(subject, { ...record, subject });
      return publicRecord(record);
    });
  }

  function lift(id) {
    return change(next => {
      const subjects = [];
      for (const [subject, record] of next) {
        if (record.id !== id) continue;
        next.delete(subject);
        subjects.push(subject);
      }
      if (!subjects.length) throw new ContentError(404, '这条禁言已经结束');
      return subjects;
    });
  }

  function ensurePersisted() {
    if (!filePath || persisted) return Promise.resolve();
    const task = pending.then(() => {
      checkStorage();
      if (!persisted) return save(records);
    });
    pending = task.catch(() => {});
    return task;
  }

  return { secret, get, list, mute, muteMany, lift, ensurePersisted };
}

module.exports = { createMuteStore, parseMuteDuration, UUID, SUBJECT };
