'use strict';

const { randomUUID } = require('node:crypto');
const { closeSync, constants, fstatSync, openSync, readSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const WINDOW_SECONDS = 21_600;
const WINDOW_MS = WINDOW_SECONDS * 1000;
const DEFAULT_INTERVAL_MS = 120_000;
// Include both ends of the window at the default cadence. Keep this cap for shorter intervals, too.
const MAX_POINTS = WINDOW_MS / DEFAULT_INTERVAL_MS + 1;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TIMER_MS = 2_147_483_647;

const isCount = value => Number.isSafeInteger(value) && value >= 0;
const withinWindow = (time, asOf) => time >= asOf - WINDOW_MS && time <= asOf;

function loadPoints(file, asOf) {
  try {
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return [];

      // Bound the read even if the file grows after fstat.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const bytes = readSync(fd, buffer, length, buffer.length - length, null);
        if (bytes === 0) break;
        length += bytes;
      }
      if (length !== stat.size) return [];

      const data = JSON.parse(buffer.toString('utf8', 0, length));
      if (!Array.isArray(data?.points)) return [];
      const byTime = new Map();
      for (const point of data.points) {
        if (!point) continue;
        const { time, online, totalVisits } = point;
        if (isCount(time) && withinWindow(time, asOf) && isCount(online) && isCount(totalVisits)) {
          byTime.set(time, { time, online, totalVisits });
        }
      }
      return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-MAX_POINTS);
    } finally {
      closeSync(fd);
    }
  } catch {
    return []; // Missing or invalid state is a cold start.
  }
}

async function savePoints(file, points) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify({ points })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

function createTrafficHistory({ filePath, getSnapshot, now = Date.now, intervalMs = DEFAULT_INTERVAL_MS }) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('filePath must be a nonempty string');
  if (typeof getSnapshot !== 'function') throw new TypeError('getSnapshot must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > MAX_TIMER_MS) {
    throw new RangeError('intervalMs must be a positive integer supported by Node timers');
  }

  const file = path.resolve(filePath);
  let points = loadPoints(file, now());
  let running = false;
  let timer;
  let pending;

  function sample() {
    if (pending) return pending;
    let delay = intervalMs;
    const startedAt = performance.now();
    pending = Promise.resolve().then(async () => {
      const time = now();
      if (!isCount(time)) return;
      const last = points.at(-1);
      if (last && time - last.time < intervalMs) {
        delay = Math.min(intervalMs, intervalMs - (time - last.time));
        return;
      }

      const { online, totalVisits } = (await getSnapshot()) ?? {};
      if (!isCount(online) || !isCount(totalVisits)) return;
      points = points.filter(point => withinWindow(point.time, time));
      points.push({ time, online, totalVisits });
      if (points.length > MAX_POINTS) points.shift();
      await savePoints(file, points);
    }).catch(() => {
      // Failed snapshots leave a gap. Failed writes leave the sample in memory for the next save.
    }).finally(() => {
      pending = undefined;
      if (!running || timer) return;
      // Count time spent sampling and writing toward the next interval.
      const remaining = Math.max(1, Math.ceil(delay - (performance.now() - startedAt)));
      timer = setTimeout(() => {
        timer = undefined;
        void sample();
      }, remaining);
      timer.unref();
    });
    return pending;
  }

  function start() {
    if (running) return pending;
    running = true;
    return sample();
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    timer = undefined;
    return pending; // Allow shutdown to wait for an active sample and its write.
  }

  function read() {
    const asOf = now();
    return {
      windowSeconds: WINDOW_SECONDS,
      sampleSeconds: intervalMs / 1000,
      asOf,
      points: points.filter(point => withinWindow(point.time, asOf)).map(point => ({ ...point })),
    };
  }

  return { start, stop, sample, read };
}

module.exports = { createTrafficHistory };
