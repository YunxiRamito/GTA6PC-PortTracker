'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ContentError } = require('./_content');

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const BEIJING_OFFSET = 8 * HOUR;
const CLOCK_CHECK = 60_000;
const MAX_FILE_BYTES = 1024;
const DEFAULT_RATE_LIMIT = { perMinute: 2, minIntervalSeconds: 5 };
const DEFAULT_SETTINGS = {
  enabled: true, schedule: { enabled: false, closeAt: '23:00', openAt: '07:00' }, rateLimit: DEFAULT_RATE_LIMIT,
};
const validTime = value => typeof value === 'string' && value.length === 5 && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const storageError = () => new ContentError(503, '弹幕设置暂时不可用');

function validateSettings(input) {
  const { enabled, schedule, rateLimit, communityVoteThreshold } = input ?? {};
  if (typeof enabled !== 'boolean' || typeof schedule?.enabled !== 'boolean' ||
      !validTime(schedule.closeAt) || !validTime(schedule.openAt)) {
    throw new ContentError(400, '请提供有效的开关和北京时间（HH:MM）');
  }
  if (schedule.enabled && schedule.closeAt === schedule.openAt) {
    throw new ContentError(400, '关闭和恢复时间不能相同');
  }
  if (rateLimit !== undefined && (!Number.isInteger(rateLimit?.perMinute) || rateLimit.perMinute < 1 || rateLimit.perMinute > 60 ||
      !Number.isInteger(rateLimit.minIntervalSeconds) || rateLimit.minIntervalSeconds < 0 || rateLimit.minIntervalSeconds > 60)) {
    throw new ContentError(400, '每分钟限额须为 1–60 条，最短发送间隔须为 0–60 秒（均为整数）');
  }
  if (communityVoteThreshold !== undefined && (!Number.isInteger(communityVoteThreshold) || communityVoteThreshold < 2 || communityVoteThreshold > 20)) {
    throw new ContentError(400, '社区禁言投票门槛须为 2–20 人');
  }
  return {
    enabled, ...(communityVoteThreshold !== undefined && { communityVoteThreshold }), schedule: { enabled: schedule.enabled, closeAt: schedule.closeAt, openAt: schedule.openAt },
    ...(rateLimit && { rateLimit: { perMinute: rateLimit.perMinute, minIntervalSeconds: rateLimit.minIntervalSeconds } }),
  };
}

function readSettings(filePath) {
  if (!filePath) return DEFAULT_SETTINGS;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid danmaku settings file');
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (saved?.version !== 1) throw new Error('Unknown danmaku settings version');
    return { rateLimit: DEFAULT_RATE_LIMIT, ...validateSettings(saved) };
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_SETTINGS;
    console.error('Cannot read danmaku settings:', error.code || error.name);
    return null;
  }
}

async function saveSettings(filePath, settings) {
  if (!filePath) return;
  const temporary = filePath + '.' + randomUUID() + '.tmp';
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(temporary, JSON.stringify({ version: 1, ...settings }) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, filePath);
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {});
    console.error('Cannot save danmaku settings:', error.code || error.name);
    throw storageError();
  }
}

function timeOfDay(value) {
  return Number(value.slice(0, 2)) * HOUR + Number(value.slice(3)) * 60_000;
}

function scheduledAvailability(settings, at) {
  if (!settings?.enabled) return { active: false };
  if (!settings.schedule.enabled) return { active: true };
  const clock = ((at + BEIJING_OFFSET) % DAY + DAY) % DAY;
  const close = timeOfDay(settings.schedule.closeAt);
  const open = timeOfDay(settings.schedule.openAt);
  const closed = close < open ? clock >= close && clock < open : clock >= close || clock < open;
  const next = closed ? open : close;
  return { active: !closed, nextIn: (next - clock + DAY) % DAY };
}

function createDanmakuSettings({ filePath, now, onAvailability }) {
  let current = readSettings(filePath);
  let reported;
  let timer;
  let running = false;
  let pending = Promise.resolve();

  function report(active) {
    if (reported !== active) {
      reported = active;
      onAvailability(active);
    }
    return active;
  }

  function isActive(at = now()) {
    return report(scheduledAvailability(current, at).active);
  }

  function scheduleNext() {
    clearTimeout(timer);
    const { active, nextIn } = scheduledAvailability(current, now());
    if (running && nextIn !== undefined) {
      // Recheck the wall clock periodically in case it jumps while the server is idle.
      timer = setTimeout(scheduleNext, Math.min(nextIn, CLOCK_CHECK));
      timer.unref();
    }
    return report(active);
  }

  function start() {
    running = true;
    scheduleNext();
  }

  function stop() {
    running = false;
    clearTimeout(timer);
  }

  function snapshot(active) {
    return { enabled: current.enabled, schedule: { ...current.schedule }, rateLimit: { ...current.rateLimit }, ...(current.communityVoteThreshold !== undefined && { communityVoteThreshold: current.communityVoteThreshold }), active };
  }

  function read() {
    if (!current) throw storageError();
    return snapshot(isActive());
  }

  function write(input) {
    const update = validateSettings(input);
    const task = pending.then(async () => {
      if (!current) throw storageError();
      const next = { ...update, ...(input.communityVoteThreshold !== undefined || current.communityVoteThreshold !== undefined ? { communityVoteThreshold: input.communityVoteThreshold ?? current.communityVoteThreshold } : {}), rateLimit: update.rateLimit ?? current.rateLimit };
      await saveSettings(filePath, next);
      current = next;
      return snapshot(scheduleNext());
    });
    pending = task.catch(() => {});
    return task;
  }

  return { start, stop, isActive, read, write, rateLimit: () => current.rateLimit };
}

module.exports = { createDanmakuSettings };
