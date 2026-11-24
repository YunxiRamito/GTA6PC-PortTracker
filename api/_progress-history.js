'use strict';
// Progress history: records leader score per Beijing calendar day, one entry per day (last write wins).
// Keeps at most 120 days. Atomic write, safe recovery on corruption.

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const MAX_DAYS = 120;
const MAX_FILE_BYTES = 64 * 1024;
const BEIJING_TZ = 'Asia/Shanghai';
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160];

function todayBeijing(now) {
  // Returns 'YYYY-MM-DD' in Beijing time
  const d = new Date(now);
  return d.toLocaleDateString('sv-SE', { timeZone: BEIJING_TZ });
}

function isValidEntry(e) {
  if (!e || typeof e !== 'object') return false;
  if (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return false;
  if (typeof e.leader !== 'number' || !Number.isFinite(e.leader)) return false;
  if (typeof e.leaderId !== 'string') return false;
  if (typeof e.top3avg !== 'number' || !Number.isFinite(e.top3avg)) return false;
  if (typeof e.furthest !== 'string') return false;
  if (typeof e.ranked !== 'number' || !Number.isInteger(e.ranked)) return false;
  return true;
}

function loadHistory(filePath) {
  try {
    const stat = fsSync.statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return [];
    const raw = fsSync.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(isValidEntry);
  } catch {
    return [];
  }
}

async function saveHistory(filePath, entries) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.progress-history-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify(entries) + '\n', { flag: 'wx', mode: 0o600 });
    // A transient Windows file lock can block replacement. Retry the same temporary file.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temp, filePath);
        return;
      } catch (err) {
        if ((err.code !== 'EBUSY' && err.code !== 'EPERM') || attempt === RENAME_RETRY_DELAYS_MS.length) {
          throw err;
        }
        await delay(RENAME_RETRY_DELAYS_MS[attempt]);
      }
    }
  } catch (err) {
    await fs.unlink(temp).catch(() => {});
    throw err;
  }
}

function createProgressHistory({ filePath, now = Date.now } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath required');
  const file = path.resolve(filePath);
  let entries = loadHistory(file);
  let writeTail = Promise.resolve();

  function read() {
    return entries.map(e => ({ ...e }));
  }

  async function record(entry) {
    // entry: { leader, leaderId, top3avg, furthest, ranked }
    if (!entry || typeof entry.leader !== 'number') return;
    const date = todayBeijing(now());
    const newEntry = {
      date,
      leader: Math.round(entry.leader * 10) / 10,
      leaderId: String(entry.leaderId || ''),
      top3avg: Math.round((entry.top3avg || 0) * 10) / 10,
      furthest: String(entry.furthest || ''),
      ranked: typeof entry.ranked === 'number' ? entry.ranked : 0,
    };
    // Replace same-day entry (last write wins), then trim to 120 days
    const idx = entries.findIndex(e => e.date === date);
    if (idx >= 0) {
      entries[idx] = newEntry;
    } else {
      entries.push(newEntry);
      // Sort by date ascending
      entries.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
      if (entries.length > MAX_DAYS) entries = entries.slice(-MAX_DAYS);
    }
    // Capture this call's snapshot before later calls update the in-memory history.
    const snapshot = entries.slice();
    const write = writeTail.then(() => saveHistory(file, snapshot));
    writeTail = write.catch(() => {}); // A failed save must not block the next one.
    await write;
  }

  return { read, record };
}

module.exports = { createProgressHistory, todayBeijing };
