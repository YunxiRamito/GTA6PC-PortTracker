'use strict';

const { randomBytes } = require('node:crypto');
const { ContentError } = require('./_content');

const MAX_OUTSTANDING = 8192;
const MAX_PER_BINDING = 16;
const NONCE = /^[0-9a-f]{48}$/;

function validBinding(binding) {
  return typeof binding === 'string' && /\S/.test(binding);
}

function createDanmakuNonces({ now = Date.now, ttlMs = 30_000 } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be positive and finite');

  const expiresIn = Math.ceil(ttlMs / 1000);
  const outstanding = new Map();
  const counts = new Map();
  let first = null;
  let last = null;
  let lastTime = -Infinity;

  function remove(entry) {
    const { nonce, binding, prev, next } = entry;
    if (prev) prev.next = next;
    else first = next;
    if (next) next.prev = prev;
    else last = prev;

    outstanding.delete(nonce);
    const remaining = counts.get(binding) - 1;
    if (remaining) counts.set(binding, remaining);
    else counts.delete(binding);
  }

  function prune() {
    const time = now();
    if (!Number.isFinite(time)) throw new TypeError('now must return a finite timestamp');
    // A fixed TTL and nondecreasing time keep the list ordered by expiry.
    lastTime = Math.max(lastTime, time);
    while (first && first.expiresAt <= lastTime) remove(first);
    return lastTime;
  }

  function issue(binding) {
    if (!validBinding(binding)) throw new ContentError(400, '弹幕请求身份有误');
    const time = prune();
    const count = counts.get(binding) ?? 0;
    if (outstanding.size >= MAX_OUTSTANDING || count >= MAX_PER_BINDING) {
      throw new ContentError(429, '待使用的弹幕凭证太多，请稍后再试');
    }

    let nonce;
    do {
      nonce = randomBytes(24).toString('hex');
    } while (outstanding.has(nonce));

    const entry = { nonce, binding, expiresAt: time + ttlMs, prev: last, next: null };
    if (last) last.next = entry;
    else first = entry;
    last = entry;
    outstanding.set(nonce, entry);
    counts.set(binding, count + 1);
    return { nonce, expiresIn };
  }

  function consume(binding, nonce) {
    if (!validBinding(binding) || typeof nonce !== 'string' || nonce.length !== 48 || !NONCE.test(nonce)) return false;
    prune();
    const entry = outstanding.get(nonce);
    if (!entry || entry.binding !== binding) return false;
    remove(entry);
    return true;
  }

  return { issue, consume };
}

module.exports = { createDanmakuNonces };
