'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ContentError } = require('./_content');
const { UUID } = require('./_danmaku-mutes');

const RANK_TAGS = Object.freeze(['owner', 'admin', 'moderator', 'sponsor']);
const MAX_GRANTS = 1024;
const MAX_FILE_BYTES = 256 * 1024;
const unavailable = () => new ContentError(503, '标签管理暂时不可用');
const validTag = tag => RANK_TAGS.includes(tag);

function builtinRankTags(role, sponsor) {
  return RANK_TAGS.filter(tag => role === 'owner' || tag === role || (tag === 'sponsor' && sponsor));
}

function allowedRankTags(role, sponsor, grants) {
  const builtin = builtinRankTags(role, sponsor);
  return RANK_TAGS.filter(tag => builtin.includes(tag) || grants.includes(tag));
}

function createRankGrants({ filePath, accountExists }) {
  let grants;
  let loading;
  let pending = Promise.resolve();

  async function load() {
    const next = new Map();
    try {
      const info = await fs.lstat(filePath);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw unavailable();
      const record = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (record?.version !== 1 || !Array.isArray(record.grants) || record.grants.length > MAX_GRANTS) throw unavailable();
      for (const entry of record.grants) {
        if (typeof entry?.accountId !== 'string' || !UUID.test(entry.accountId) || next.has(entry.accountId) ||
            !Array.isArray(entry.tags) || !entry.tags.length || entry.tags.length > RANK_TAGS.length ||
            new Set(entry.tags).size !== entry.tags.length || !entry.tags.every(validTag)) throw unavailable();
        next.set(entry.accountId, Object.freeze(RANK_TAGS.filter(tag => entry.tags.includes(tag))));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw unavailable();
    }
    grants = next;
  }

  async function current() {
    if (!grants) {
      loading ??= load().finally(() => { loading = undefined; });
      await loading;
    }
    return grants;
  }

  async function read() {
    return new Map(await current());
  }

  async function get(accountId) {
    return (await current()).get(accountId) ?? [];
  }

  function set({ accountId, tag, enabled }, canWrite) {
    const operation = pending.then(async () => {
      const before = await current();
      const assertWritable = () => {
        if (!canWrite()) throw new ContentError(403, '只有站长可以管理标签');
        if (!accountExists(accountId)) throw new ContentError(404, '找不到该账号');
      };
      assertWritable();
      const existing = before.get(accountId) ?? [];
      if (existing.includes(tag) === enabled) return existing;
      const tags = Object.freeze(RANK_TAGS.filter(value => value === tag ? enabled : existing.includes(value)));
      const next = new Map([...before].filter(([id]) => accountExists(id)));
      if (tags.length) next.set(accountId, tags);
      else next.delete(accountId);
      if (next.size > MAX_GRANTS) throw new ContentError(422, '获授标签的账号数量已达上限');
      const output = JSON.stringify({ version: 1, grants: [...next].map(([id, values]) => ({ accountId: id, tags: values })) }) + '\n';
      const dir = path.dirname(filePath);
      const temp = path.join(dir, `.rank-grants-${randomUUID()}.tmp`);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        const handle = await fs.open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(output);
          await handle.sync();
        } finally {
          await handle.close();
        }
        assertWritable();
        await fs.rename(temp, filePath);
        grants = next;
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
      return tags;
    });
    pending = operation.catch(() => {});
    return operation;
  }

  return { read, get, set };
}

module.exports = { createRankGrants, builtinRankTags, allowedRankTags, validTag };
