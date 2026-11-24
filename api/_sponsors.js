'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { ContentError } = require('./_content');

const MAX_SPONSORS = 250;
const MAX_MESSAGE_LENGTH = 240;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const VALID_MESSAGE = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]*$/u;

function validMessage(message) {
  return typeof message === 'string' && message.length <= MAX_MESSAGE_LENGTH * 2 &&
    VALID_MESSAGE.test(message) && [...message].length <= MAX_MESSAGE_LENGTH;
}

function revision(sponsors) {
  return `"${createHash('sha256').update(JSON.stringify(sponsors)).digest('hex')}"`;
}

function parseRecord(text) {
  const record = JSON.parse(text);
  if (record?.version !== 1 || !Array.isArray(record.sponsors) || record.sponsors.length > MAX_SPONSORS) {
    throw new Error('Invalid sponsor record');
  }
  const ids = new Set();
  const accounts = new Set();
  return record.sponsors.map(item => {
    if (typeof item?.id !== 'string' || !UUID.test(item.id) || ids.has(item.id) ||
        typeof item?.accountId !== 'string' || !UUID.test(item.accountId) || accounts.has(item.accountId) ||
        !validMessage(item.message)) throw new Error('Invalid sponsor entry');
    ids.add(item.id);
    accounts.add(item.accountId);
    return { id: item.id, accountId: item.accountId, message: item.message };
  });
}

function createSponsors({ filePath, accountExists }) {
  let sponsors;
  let etag;
  let loading;
  let pending = Promise.resolve();

  async function load() {
    try {
      sponsors = parseRecord(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new ContentError(503, '无法读取鸣谢名单');
      sponsors = [];
    }
    etag = revision(sponsors);
  }

  async function snapshot() {
    if (!sponsors) {
      loading ||= load().finally(() => { loading = undefined; });
      await loading;
    }
    return { sponsors: sponsors.map(item => ({ ...item })), etag };
  }

  function write(input, ifMatch) {
    const task = pending.then(async () => {
      const current = await snapshot();
      if (!ifMatch) throw new ContentError(428, '保存前请先读取鸣谢名单版本');
      if (ifMatch !== current.etag) throw new ContentError(412, '鸣谢名单已更新，请先读取最新名单');
      if (!Array.isArray(input)) throw new ContentError(400, '鸣谢名单格式无效');
      if (input.length > MAX_SPONSORS) throw new ContentError(422, `鸣谢名单最多可添加 ${MAX_SPONSORS} 位`);

      const existing = new Map(current.sponsors.map(item => [item.accountId, item]));
      const seen = new Set();
      const next = input.map(item => {
        if (typeof item?.accountId !== 'string' || !UUID.test(item.accountId) ||
            Object.keys(item).some(key => key !== 'accountId' && key !== 'message')) {
          throw new ContentError(400, '鸣谢项目格式无效');
        }
        const { accountId } = item;
        if (seen.has(accountId)) throw new ContentError(422, '同一个账号只能添加一次');
        seen.add(accountId);
        const { message: rawMessage = '' } = item;
        const message = typeof rawMessage === 'string' ? rawMessage.trim() : rawMessage;
        if (!validMessage(message)) throw new ContentError(422, `请输入有效的鸣谢短句，最多 ${MAX_MESSAGE_LENGTH} 字`);
        const previous = existing.get(accountId);
        if (!previous && !accountExists(accountId)) throw new ContentError(422, '所选账号不存在，请重新搜索');
        return { id: previous?.id || randomUUID(), accountId, message };
      });
      const nextEtag = revision(next);
      if (nextEtag === etag) return current;

      const directory = path.dirname(filePath);
      const temp = path.join(directory, `.sponsors-${randomUUID()}.tmp`);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        await fs.writeFile(temp, JSON.stringify({ version: 1, sponsors: next }) + '\n', { flag: 'wx', mode: 0o600 });
        await fs.rename(temp, filePath);
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
      sponsors = next;
      etag = nextEtag;
      return snapshot();
    });
    pending = task.catch(() => {});
    return task;
  }

  return { read: snapshot, write };
}

module.exports = { createSponsors, UUID };
