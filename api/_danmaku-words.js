'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ContentError } = require('./_content');
const { cleanDanmakuText, createDanmakuFilter, defaultDanmakuFilter, listBuiltInDanmakuWords, danmakuWordKey } = require('./_danmaku-filter');

const MAX_CUSTOM = 1000;
const MAX_WORD_FILE = 2 * 1024 * 1024;
const PAGE_SIZE = 30;
const SCOPES = new Set(['all', 'builtin', 'custom', 'disabled']);
let catalog;

function wordEntry(raw) {
  const term = cleanDanmakuText(raw);
  if (!term) return null;
  const key = danmakuWordKey(term);
  const length = [...key].length;
  return length >= 2 && length <= 60 ? { key, term } : null;
}

function builtInCatalog() {
  if (catalog) return catalog;
  catalog = new Map();
  for (const raw of listBuiltInDanmakuWords()) {
    const entry = wordEntry(raw);
    if (entry && !catalog.has(entry.key)) catalog.set(entry.key, entry.term);
  }
  return catalog;
}

function createWordStore({ filePath } = {}) {
  const builtin = builtInCatalog();
  let custom = new Map();
  let disabled = new Set();
  let matches = defaultDanmakuFilter();
  let queue = Promise.resolve();
  let corrupt = false;

  function compile(customWords, disabledWords) {
    const enabled = [];
    // Rebuild from the built-in list so existing matches keep their behavior.
    for (const word of listBuiltInDanmakuWords()) {
      if (!disabledWords.has(danmakuWordKey(word))) enabled.push(word);
    }
    return createDanmakuFilter([...enabled, ...customWords.values()]);
  }

  if (filePath) {
    try {
      if (fs.statSync(filePath).size > MAX_WORD_FILE) throw new Error('Oversized danmaku word data');
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (saved?.version !== 1 || !Array.isArray(saved.custom) || saved.custom.length > MAX_CUSTOM || !Array.isArray(saved.disabled)) {
        throw new Error('Invalid danmaku word data');
      }
      for (const value of saved.custom) {
        const entry = wordEntry(value);
        if (!entry || builtin.has(entry.key) || custom.has(entry.key)) throw new Error('Invalid custom danmaku word');
        custom.set(entry.key, entry.term);
      }
      for (const key of saved.disabled) {
        if (typeof key !== 'string' || wordEntry(key)?.key !== key) throw new Error('Invalid disabled danmaku word');
        disabled.add(key);
      }
      if (custom.size || disabled.size) matches = compile(custom, disabled);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        corrupt = true;
        console.error('Cannot read danmaku word data:', error.code || error.name);
      }
    }
  }

  function checkStorage() {
    if (corrupt) throw new ContentError(503, '弹幕词库暂时不可用');
  }

  function list(params) {
    checkStorage();
    const query = (params.get('query') || '').trim();
    const scope = params.get('scope') || 'all';
    const offset = Number(params.get('offset') || 0);
    if ([...query].length > 60 || !SCOPES.has(scope) || !Number.isSafeInteger(offset) || offset < 0) {
      throw new ContentError(400, '词库查询格式有误');
    }
    const substring = danmakuWordKey(query);
    const items = [];
    let total = 0;
    const include = (key, term, source, enabled) => {
      if (query && !(substring ? key.includes(substring) : term.includes(query))) return;
      if (total >= offset && items.length < PAGE_SIZE) items.push({ term, source, enabled });
      total++;
    };
    if (scope === 'all' || scope === 'custom') {
      for (const [key, term] of custom) include(key, term, 'custom', true);
    }
    if (scope !== 'custom') {
      for (const [key, term] of builtin) {
        const enabled = !disabled.has(key);
        if (scope !== 'disabled' || !enabled) include(key, term, 'builtin', enabled);
      }
    }
    return { items, total, offset, limit: PAGE_SIZE };
  }

  async function persist(nextCustom, nextDisabled) {
    if (!filePath) return;
    const temp = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const state = { version: 1, custom: [...nextCustom.values()], disabled: [...nextDisabled] };
      await fs.promises.writeFile(temp, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.promises.rename(temp, filePath);
    } catch (error) {
      await fs.promises.unlink(temp).catch(() => {});
      console.error('Cannot save danmaku word data:', error.code || error.name);
      throw new ContentError(503, '词库暂时无法保存');
    }
  }

  function change(value, enable) {
    const work = queue.then(async () => {
      checkStorage();
      const entry = wordEntry(value);
      if (!entry) throw new ContentError(400, '请输入 2 到 60 个有效字符');
      const { key, term } = entry;
      const defaultTerm = builtin.get(key);
      const nextCustom = new Map(custom);
      const nextDisabled = new Set(disabled);
      if (enable) {
        if (defaultTerm && !nextDisabled.delete(key)) throw new ContentError(409, '这个词已经在词库中');
        if (!defaultTerm) {
          if (nextCustom.has(key)) throw new ContentError(409, '这个词已经在词库中');
          if (nextCustom.size >= MAX_CUSTOM) throw new ContentError(409, '自定义词已达上限');
          nextCustom.set(key, term);
        }
      } else {
        if (defaultTerm && !nextDisabled.has(key)) nextDisabled.add(key);
        else if (!nextCustom.delete(key)) throw new ContentError(404, '词库中没有这个启用的词');
      }
      const nextFilter = compile(nextCustom, nextDisabled);
      await persist(nextCustom, nextDisabled);
      custom = nextCustom;
      disabled = nextDisabled;
      matches = nextFilter;
      return enable ? { term: defaultTerm || term, source: defaultTerm ? 'builtin' : 'custom', enabled: true } : { removed: true };
    });
    queue = work.catch(() => {});
    return work;
  }

  return {
    list, change,
    matches(text) {
      checkStorage();
      return matches(text);
    },
  };
}

module.exports = { createWordStore };
