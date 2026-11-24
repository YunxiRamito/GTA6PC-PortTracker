'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ContentError } = require('./_content');
const { SUBJECT } = require('./_danmaku-mutes');

const MAX_RECORDS = 5_000;
const MAX_FILE_BYTES = 1024 * 1024;
const storageError = () => new ContentError(503, '社区禁言记录暂时不可用');

function createCommunityMuteStore({ filePath, now = Date.now } = {}) {
  let records = new Map();
  let broken = false;
  let pending = Promise.resolve();

  if (filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid community mute store size');
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (saved?.version !== 1 || !Array.isArray(saved.mutes) || saved.mutes.length > MAX_RECORDS) {
        throw new Error('Invalid community mute data');
      }
      const loaded = new Map();
      for (const record of saved.mutes) {
        if (!SUBJECT.test(record?.subject) || typeof record.expiresAt !== 'string' ||
            !Number.isFinite(Date.parse(record.expiresAt)) || loaded.has(record.subject)) {
          throw new Error('Invalid community mute record');
        }
        if (Date.parse(record.expiresAt) > now()) loaded.set(record.subject, { expiresAt: record.expiresAt });
      }
      records = loaded;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        broken = true;
        console.error('Cannot read community moderation data:', error.code || error.name);
      }
    }
  }

  function checkStorage() {
    if (broken) throw storageError();
  }

  function get(subject) {
    checkStorage();
    const record = records.get(subject);
    if (record && Date.parse(record.expiresAt) <= now()) {
      records.delete(subject);
      return undefined;
    }
    return record;
  }

  async function save(next) {
    if (filePath) {
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const file = await fs.promises.open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(`${JSON.stringify({ version: 1, mutes: [...next].map(([subject, value]) => ({ subject, ...value })) })}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
        await fs.promises.rename(temporary, filePath);
      } catch (error) {
        await fs.promises.unlink(temporary).catch(() => {});
        console.error('Cannot save community moderation data:', error.code || error.name);
        throw storageError();
      }
    }
    records = next;
  }

  function setMany(subjects, expiresAt) {
    const task = pending.then(async () => {
      checkStorage();
      const time = now();
      if (!Array.isArray(subjects) || !subjects.length || subjects.some(subject => !SUBJECT.test(subject)) ||
          typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= time) {
        throw new ContentError(400, '社区禁言对象或期限无效');
      }
      const next = new Map([...records].filter(([, record]) => Date.parse(record.expiresAt) > time));
      const targets = [...new Set(subjects)];
      if (next.size + targets.filter(subject => !next.has(subject)).length > MAX_RECORDS) {
        throw storageError();
      }
      for (const subject of targets) next.set(subject, { expiresAt });
      await save(next);
      return [...targets];
    });
    pending = task.catch(() => {});
    return task;
  }

  return { get, setMany };
}

module.exports = { createCommunityMuteStore };
