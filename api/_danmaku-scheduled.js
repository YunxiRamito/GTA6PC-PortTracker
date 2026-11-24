'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ContentError } = require('./_content');
const { cleanDanmakuText } = require('./_danmaku-filter');

const MINUTE = 60_000;
const MAX_MESSAGES = 20;
const MAX_FILE_BYTES = 8 * 1024;
const DEFAULT_STATE = { enabled: false, intervalMinutes: 5, messages: [], nextIndex: 0 };
const storageError = () => new ContentError(503, '定时弹幕设置暂时不可用');

function validateConfig(input) {
  const { enabled, intervalMinutes, messages } = input ?? {};
  if (typeof enabled !== 'boolean') throw new ContentError(400, '请提供定时弹幕开关');
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    throw new ContentError(400, '发送间隔须为 1 到 1440 分钟的整数');
  }
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES || (enabled && messages.length === 0)) {
    throw new ContentError(400, enabled ? '请填写 1 到 20 条定时弹幕' : '最多可填写 20 条定时弹幕');
  }
  const cleaned = [];
  for (const message of messages) {
    const text = cleanDanmakuText(message);
    if (!text) throw new ContentError(400, '每条定时弹幕须为 1 到 60 字的单行文字');
    cleaned.push(text);
  }
  return { enabled, intervalMinutes, messages: cleaned };
}

function loadState(filePath) {
  if (!filePath) return DEFAULT_STATE;
  try {
    if (fs.statSync(filePath).size > MAX_FILE_BYTES) throw new Error('Oversized scheduled danmaku data');
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (saved?.version !== 1) throw new Error('Unknown scheduled danmaku version');
    const config = validateConfig(saved);
    const { nextIndex } = saved;
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= Math.max(config.messages.length, 1)) {
      throw new Error('Invalid scheduled danmaku cursor');
    }
    return { ...config, nextIndex };
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_STATE;
    console.error('Cannot read scheduled danmaku data:', error.code || error.name);
    return null;
  }
}

async function saveState(filePath, state) {
  if (!filePath) return;
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const file = await fs.promises.open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(`${JSON.stringify({ version: 1, ...state })}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.promises.rename(temporary, filePath);
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {});
    throw error;
  }
}

// One primary process owns the file. Call wake() on realtime availability changes.
// isActive(at) and isBlocked(text) are synchronous. A publisher can return false
// (or reject) to leave the cursor in place, for example if realtime just closed.
function createScheduledDanmaku({
  filePath, now = Date.now, isActive, publish, isBlocked,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let current = loadState(filePath);
  let running = false;
  let timer;
  let ticking = false;
  let pending = Promise.resolve();

  function serialize(work) {
    const task = pending.then(work);
    pending = task.catch(() => {});
    return task;
  }

  function disarm() {
    if (!timer) return;
    clearTimer(timer.handle);
    timer = undefined;
  }

  function arm() {
    if (!running || !current?.enabled || ticking || timer) return;
    // isActive can synchronously report a transition and call wake().
    if (!isActive(now()) || !running || timer) return;
    const slot = {};
    timer = slot;
    slot.handle = setTimer(() => tick(slot), current.intervalMinutes * MINUTE);
    slot.handle?.unref?.();
  }

  function wake() {
    disarm();
    arm();
  }

  function tick(slot) {
    return serialize(async () => {
      if (timer !== slot) return;
      ticking = true;
      try {
        const { messages, nextIndex } = current;
        for (let offset = 0; offset < messages.length; offset++) {
          const index = (nextIndex + offset) % messages.length;
          const text = messages[index];
          if (isBlocked(text)) continue;
          const time = now();
          if (!isActive(time) || timer !== slot) return;
          const message = {
            id: randomUUID(), text, nickname: '系统', staff: 'moderator', color: 'orange',
            createdAt: new Date(time).toISOString(), admin: true,
          };
          if (await publish(message) === false) return;
          const next = (index + 1) % messages.length;
          if (next !== nextIndex) {
            current = { ...current, nextIndex: next };
            // Checkpoint after publishing. A crash in between can repeat an entry.
            await saveState(filePath, current);
          }
          return;
        }
      } catch (error) {
        console.error('Scheduled danmaku tick failed:', error?.code || error?.name || 'Error');
      } finally {
        ticking = false;
        if (timer === slot) timer = undefined;
        arm();
      }
    });
  }

  function start() {
    if (running) return;
    running = true;
    arm();
  }

  function stop() {
    running = false;
    disarm();
  }

  function read() {
    if (!current) throw storageError();
    const { enabled, intervalMinutes, messages } = current;
    return { enabled, intervalMinutes, messages: [...messages] };
  }

  async function write(input) {
    const config = validateConfig(input);
    return serialize(async () => {
      if (!current) throw storageError();
      for (const text of config.messages) {
        if (isBlocked(text)) throw new ContentError(422, '定时弹幕未通过审核，请换个说法');
      }
      const sameMessages = config.messages.length === current.messages.length &&
        config.messages.every((text, index) => text === current.messages[index]);
      const changed = !sameMessages || config.enabled !== current.enabled || config.intervalMinutes !== current.intervalMinutes;
      const next = { ...config, nextIndex: sameMessages ? current.nextIndex : 0 };
      try {
        await saveState(filePath, next);
      } catch (error) {
        console.error('Cannot save scheduled danmaku data:', error.code || error.name);
        throw storageError();
      }
      current = next;
      if (changed) wake();
      return read();
    });
  }

  return { start, stop, wake, read, write };
}

module.exports = { createScheduledDanmaku };
