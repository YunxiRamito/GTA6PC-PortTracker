'use strict';

const { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { isIP } = require('node:net');
const path = require('node:path');
const { ContentError } = require('./_content');
const { cleanDanmakuText, cleanDanmakuNickname } = require('./_danmaku-filter');
const { createWordStore } = require('./_danmaku-words');
const { createMuteStore, parseMuteDuration, UUID, SUBJECT } = require('./_danmaku-mutes');
const { createDanmakuHistory, RETENTION_DAYS, isGroupTag } = require('./_danmaku-history');
const { createCommunityMuteStore } = require('./_danmaku-community-mutes');
const { createDanmakuSettings } = require('./_danmaku-settings');
const { createScheduledDanmaku } = require('./_danmaku-scheduled');
const { createDanmakuNonces } = require('./_danmaku-nonces');

const SEND_PATH = '/api/danmaku';
const AVATAR_PATH = /^\/api\/danmaku\/avatar\/([a-f0-9]{32})\.png$/;
const AVATAR_TAG = /^[a-f0-9]{32}$/;
const AVATAR_PREFIX = 'data:image/png;base64,';
const MAX_AVATAR_BYTES = 72 * 1024;
const MAX_CACHED_AVATARS = 96;
const avatarHash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 32);
const STREAM_PATH = `${SEND_PATH}/events`;
const RECENT_PATH = `${SEND_PATH}/recent`;
const HISTORY_PATH = `${SEND_PATH}/history`;
const CONFIG_PATH = `${SEND_PATH}/config`;
const STATUS_PATH = `${SEND_PATH}/status`;
const LIKE_PATH = `${SEND_PATH}/like`;
const NONCE_PATH = `${SEND_PATH}/nonce`;
const COMMUNITY_VOTES_PATH = `${SEND_PATH}/community-votes`;
const COMMUNITY_COOLDOWN = 5 * 60_000;
const COMMUNITY_WINDOW = 10_000;
const COMMUNITY_MUTE = 3 * 60 * 60_000;
const MAX_COMMUNITY_VOTES = 500;
const COMMUNITY_MEMBER_ROLES = new Set(['owner', 'admin', 'moderator', 'user']);
const NONCE_FORMAT = /^[a-f0-9]{48}$/;
const MAX_BODY = 1024;
const DEVICE_COOKIE = 'tracker_danmaku_device';
const DEVICE_KEY = /^[a-f0-9]{48}$/;
const DANMAKU_COLORS = new Set(['mint', 'sky', 'rose', 'lemon']);
const SPONSOR_COLORS = new Set(['hatsune-green', 'gold']);
const STAFF_COLORS = new Map([
  ['owner', ['owner-red', 'admin-teal', 'moderator-teal', 'hatsune-green', 'gold', 'orange']],
  ['admin', ['admin-teal', 'gold', 'orange']],
  ['moderator', ['moderator-teal', 'orange']],
]);
const POST_WINDOW = 60_000;
const REPEAT_WINDOW = 60_000;
const COOLDOWN_HEADER = 'X-Danmaku-Cooldown';
const PING_INTERVAL = 10_000;
const RELAY_AVAILABILITY_WAIT = 1500;
const REPLAY_WINDOW = 15_000;
const HISTORY_WINDOW = 5 * 60_000;
const MAX_HISTORY = 640;
const MAX_RECENT_BYTES = 512 * 1024;
const MAX_ARCHIVE = 50;
const MAX_ARCHIVE_BYTES = 64 * 1024;
const ARCHIVE_RELAY_TIMEOUT = 3000;
const RECENT_CACHE_TTL = 5000;
const MAX_STREAMS = 400;
const MAX_SENDERS = 4096;
const MAX_OFFLINE_NONCES = 8192;
const MAX_KNOWN_MUTES = 8192;
const LIKE_CLIENT_ID = /^[a-f0-9]{32}$/;
const LIKE_WINDOW = 1000;
const LIKE_WINDOW_LIMIT = 30;
const MAX_LIKES = 1000;
const MAX_PENDING_RELAY_LIKES = 32;
const BUSY = '弹幕发得有点快，稍后再试';
const HISTORY_UNAVAILABLE = '弹幕历史暂时不可用';
const UNAVAILABLE = '弹幕暂时发不出，稍后再试';
const CLOSED = '弹幕当前已关闭';
const BLOCKED = '这条弹幕未通过审核，请换个说法';
const MUTED = '你已被禁言，暂时无法发送弹幕';
const DUPLICATE = '这条弹幕刚发过，请勿重复发送';
const INVALID = '请输入 1 到 60 字的单行弹幕';
const LIKE_INVALID = '点赞请求有误';
const LIKE_MISSING = '这条弹幕已过期或已下架';
const LIKE_BLOCKED = '这条弹幕无法点赞';
const LIKE_BUSY = '点赞太快，稍后再试';
const LIKE_UNAVAILABLE = '点赞暂时不可用';
const UNBAN = '已被管理员解除封禁';
const PERMANENT_BAN = '已被管理员永久封禁';
const BAN_UNITS = { m: '分钟', h: '小时', d: '天' };

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const mediaType = response => response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
const digest = value => createHash('sha256').update(value).digest();
const headerSeconds = value => /^\d{1,2}$/.test(value ?? '') ? Math.min(60, Number(value)) : undefined;
const seconds = ms => Math.max(0, Math.ceil(ms / 1000));

async function readLimitedBytes(response, limit) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readLimitedText(response, limit) {
  const bytes = await readLimitedBytes(response, limit);
  return bytes && new TextDecoder().decode(bytes);
}

function banNotice(duration) {
  if (duration === 'permanent') return PERMANENT_BAN;
  return `已被管理员封禁 ${duration.slice(0, -1)}${BAN_UNITS[duration.at(-1)]}`;
}

function archiveModerationText(action) {
  return `有个用户${action.slice(1).replace(/(\d+)(分钟|小时|天)$/, '$1 $2')}`;
}

function readModerationAction(text) {
  if (text.endsWith(UNBAN)) return UNBAN;
  if (text.endsWith(PERMANENT_BAN)) return PERMANENT_BAN;
  const match = /已被管理员封禁 ([1-9]\d{0,3}) ?(分钟|小时|天)$/.exec(text);
  if (!match) return;
  const unit = Object.keys(BAN_UNITS).find(key => BAN_UNITS[key] === match[2]);
  const duration = `${match[1]}${unit}`;
  if (parseMuteDuration(duration) !== undefined) return banNotice(duration);
}

function verifyModerationText(text, forArchive) {
  if (forArchive) {
    if (!text.startsWith('有个用户')) return false;
    const action = readModerationAction(`已${text.slice(4)}`);
    return Boolean(action && text === archiveModerationText(action));
  }
  const action = readModerationAction(text);
  if (!action || !text.startsWith('弹幕') || !text.endsWith(action)) return false;
  const quote = text.slice(2, -action.length);
  if (!quote) return true;
  if (!quote.startsWith('“') || !quote.endsWith('”')) return false;
  const original = quote.slice(1, -1);
  // Validate the quoted visitor text without imposing its 60-character cap on the notice.
  return cleanDanmakuText(original) === original;
}

const validLikeCount = count => Number.isInteger(count) && count > 0 && count <= MAX_LIKES;

function verifyLike(value) {
  if (typeof value?.id === 'string' && UUID.test(value.id) && validLikeCount(value.count)) {
    return { id: value.id, count: value.count };
  }
}

function appearance(nickname, color, admin, staff, sponsor = false) {
  const staffColors = STAFF_COLORS.get(staff);
  const allowedColor = DANMAKU_COLORS.has(color) || staffColors?.includes(color) ||
    (sponsor && SPONSOR_COLORS.has(color)) ||
    ((admin || staffColors) && color === 'default');
  return {
    ...(nickname ? { nickname } : {}),
    ...(staffColors ? { staff } : {}),
    ...(allowedColor ? { color } : {}),
  };
}

function verifyMessage(value, forArchive = false) {
  if (typeof value?.id !== 'string' || !UUID.test(value.id) || typeof value.text !== 'string' ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return;
  const { id, text, createdAt, kind, admin, nickname, color } = value;
  const staff = value.staff === 'moderator' ? value.staff
    : admin === true ? (value.staff === 'owner' || value.staff === 'admin' ? value.staff : undefined) : undefined;
  if (kind === 'moderation') {
    if (admin !== true && verifyModerationText(text, forArchive)) return { id, text, createdAt, kind };
    return;
  }
  if (kind !== undefined || cleanDanmakuText(text) !== text) return;
  return {
    id, text, createdAt, ...(admin === true ? { admin: true } : {}),
    ...appearance(admin === true && staff === 'moderator' && nickname === '系统' ? nickname : cleanDanmakuNickname(nickname), color, admin === true, staff, value.member === true && value.sponsor === true),
    ...(value.member === true ? { member: true } : {}),
    ...(value.member === true && value.sponsor === true ? { sponsor: true } : {}),
    ...(isGroupTag(value.groupTag) ? { groupTag: value.groupTag } : {}),
    ...(value.member === true && typeof value.avatar === 'string' && AVATAR_TAG.test(value.avatar) ? { avatar: value.avatar } : {}),
    ...(validLikeCount(value.likes) ? { likes: value.likes } : {}),
  };
}

function staleRequest() {
  return { status: 409, error: '弹幕请求已失效，请重试', extra: { code: 'stale_request' } };
}

function nicknameRejected(cooldown) {
  return { status: 400, error: '昵称不符合要求，请换一个', extra: { code: 'nickname' }, cooldown };
}

function closedResult() {
  return { status: 503, error: CLOSED, extra: { code: 'closed' } };
}

function rateLimited(retryAfter, error) {
  return { status: 429, error, retryAfter, extra: { code: 'rate_limit' } };
}

function intervalLimited(retryAfter, minIntervalSeconds) {
  return { status: 429, error: `两次发送至少间隔 ${minIntervalSeconds} 秒`, retryAfter };
}

function intervalWait(previous, time, minIntervalSeconds) {
  if (previous === undefined || minIntervalSeconds === 0) return 0;
  return seconds(previous + minIntervalSeconds * 1000 - time);
}

function verifyMuteStatus(value) {
  if (typeof value?.muted !== 'boolean') return null;
  if (value.expiresAt !== null && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))) return null;
  return { muted: value.muted, expiresAt: value.muted ? value.expiresAt : null,
    ...(value.muted && value.source === 'community' ? { source: 'community' } : {}) };
}

function verifyCommunityVote(value) {
  if (typeof value?.messageId !== 'string' || !UUID.test(value.messageId) ||
      !Number.isInteger(value.threshold) || value.threshold < 2 || value.threshold > 20 ||
      !Number.isInteger(value.votes) || value.votes < 0 || value.votes > value.threshold ||
      typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) ||
      !['pending', 'passed', 'failed'].includes(value.status)) return null;
  const { messageId, votes, threshold, expiresAt, status } = value;
  return { messageId, votes, threshold, expiresAt, status };
}

function createRelay({ origin, fetchUpstream, relayKey, publish, removeMessages, notify, onAvailability, onLike, onCommunityVote, now, offlineEnabled }) {
  let controller;
  let retryTimer;
  let lastId;
  let backoff = 1000;
  let recentCache;
  let recentCacheAt = 0;
  let recentRequest;
  let historyRevision = 0;
  let upstreamActive;
  let lastPrimaryActive;
  let handshakeRejected = false;
  let outageDetected = false;
  let availabilityReady;
  let pendingLikes = 0;
  const statusRequests = new Map();

  function invalidateRecent() {
    historyRevision++;
    recentCache = undefined;
    recentRequest = undefined;
  }

  function isOffline() {
    return offlineEnabled && outageDetected && upstreamActive === undefined && lastPrimaryActive !== false && !handshakeRejected;
  }

  function isActive() {
    return upstreamActive === true || isOffline();
  }

  function updateAvailability(active, rejected = handshakeRejected, outage = active === undefined) {
    if (active === upstreamActive && rejected === handshakeRejected && outage === outageDetected) return;
    const wasActive = isActive();
    upstreamActive = active;
    handshakeRejected = rejected;
    outageDetected = outage;
    if (typeof active === 'boolean') lastPrimaryActive = active;
    invalidateRecent();
    if (wasActive !== isActive()) onAvailability(isActive());
  }

  function privateHeaders(subject, quota, deviceSubject, accountSubject, memberRole, clientIP) {
    if (!relayKey) return {};
    return {
      Authorization: `Bearer ${relayKey}`,
      ...(subject ? { 'X-Danmaku-Subject': subject } : {}),
      ...(quota && quota !== subject ? { 'X-Danmaku-Quota': quota } : {}),
      ...(deviceSubject ? { 'X-Danmaku-Device-Subject': deviceSubject } : {}),
      ...(accountSubject ? { 'X-Danmaku-Account-Subject': accountSubject } : {}),
      ...(memberRole ? { 'X-Danmaku-Member-Role': memberRole } : {}),
      ...(clientIP && isIP(clientIP) ? { 'X-Danmaku-Client-IP': clientIP } : {}),
    };
  }

  async function connect() {
    const attempt = controller = new AbortController();
    let ready;
    availabilityReady = new Promise(resolve => { ready = resolve; });
    // An unconfirmed first connection has a short bounded grace period.
    const initialWait = setTimeout(() => {
      if (offlineEnabled && controller === attempt && upstreamActive === undefined) {
        updateAvailability(undefined);
        attempt.abort();
      }
      ready();
    }, RELAY_AVAILABILITY_WAIT);
    initialWait.unref();
    function finishInitialWait() {
      clearTimeout(initialWait);
      ready();
    }
    let deadline;
    const refreshDeadline = ms => {
      clearTimeout(deadline);
      deadline = setTimeout(() => attempt.abort(), ms);
      deadline.unref();
    };
    refreshDeadline(6000);
    try {
      const headers = { Accept: 'text/event-stream', ...privateHeaders() };
      if (lastId) headers['Last-Event-ID'] = lastId;
      const response = await fetchUpstream(`${origin}${STREAM_PATH}`, {
        headers, redirect: offlineEnabled ? 'manual' : 'error', signal: attempt.signal,
      });
      if (response.status !== 200 || mediaType(response) !== 'text/event-stream' || !response.body) {
        if (offlineEnabled && controller === attempt && response.status < 500) updateAvailability(undefined, true);
        return;
      }
      refreshDeadline(2.5 * PING_INTERVAL);
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let pending = '';
      try {
        while (!attempt.signal.aborted) {
          const { done, value } = await reader.read();
          if (done || value.byteLength > 64 * 1024 || attempt.signal.aborted) break;
          refreshDeadline(2.5 * PING_INTERVAL);
          backoff = 1000;
          pending += decoder.decode(value, { stream: true });
          // The fixed upstream writes LF-delimited, single-line JSON frames.
          let boundary;
          while ((boundary = pending.indexOf('\n\n')) !== -1) {
            if (boundary > 4096) return;
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const lines = frame.split('\n');
            const data = lines.find(line => line.startsWith('data: '));
            if (!data) continue;
            let value;
            try { value = JSON.parse(data.slice(6)); } catch { continue; }
            if (lines.includes('event: availability')) {
              if (typeof value?.active === 'boolean') {
                updateAvailability(value.active, false);
                finishInitialWait();
              }
            } else if (lines.includes('event: moderation')) {
              const status = verifyMuteStatus(value);
              if (relayKey && status && typeof value.subject === 'string' && SUBJECT.test(value.subject)) notify(value.subject, status);
            } else if (lines.includes('event: remove')) {
              if (Array.isArray(value?.ids) && value.ids.length <= MAX_HISTORY) {
                invalidateRecent();
                removeMessages(value.ids.filter(id => typeof id === 'string' && UUID.test(id)));
              }
            } else if (lines.includes('event: community-vote')) {
              const vote = verifyCommunityVote(value);
              if (vote) onCommunityVote(vote);
            } else if (lines.includes('event: like')) {
              const like = verifyLike(value);
              if (like && upstreamActive === true) onLike(like);
            } else if (upstreamActive === true) {
              const message = verifyMessage(value);
              if (message) {
                lastId = message.id;
                if (message.kind === 'moderation') invalidateRecent();
                publish(message);
              }
            }
          }
          if (pending.length > 4096) return;
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
    } catch {
      // The mirror reconnects when the main site's stream becomes available again.
    } finally {
      clearTimeout(deadline);
      finishInitialWait();
      attempt.abort();
      if (controller === attempt) {
        controller = undefined;
        updateAvailability(undefined);
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void connect();
        }, backoff);
        retryTimer.unref();
        backoff = Math.min(15_000, backoff * 2);
      }
    }
  }

  function waitForAvailability() {
    if (!controller && !retryTimer) void connect();
    if (upstreamActive === undefined && !isOffline()) return availabilityReady;
  }

  function stop() {
    const active = controller;
    controller = undefined;
    active?.abort();
    clearTimeout(retryTimer);
    retryTimer = undefined;
    lastId = undefined;
    updateAvailability(undefined, false, false);
    backoff = 1000;
  }

  function markUnreachable(bridge) {
    if (!offlineEnabled || bridge !== controller) return;
    updateAvailability(undefined);
    bridge?.abort();
  }

  async function issueNonce(subject, quota, deviceSubject) {
    const bridge = controller;
    const unavailable = () => {
      // This read can detect an HTTP outage before the SSE heartbeat expires.
      markUnreachable(bridge);
      return null;
    };
    let response;
    try {
      response = await fetchUpstream(`${origin}${NONCE_PATH}`, {
        headers: { Accept: 'application/json', ...privateHeaders(subject, quota, deviceSubject) },
        redirect: offlineEnabled ? 'manual' : 'error', cache: 'no-store', signal: AbortSignal.timeout(3500),
      });
    } catch { return unavailable(); }
    if (response.status >= 500) return unavailable();
    if (response.status === 403 && offlineEnabled) {
      const result = await readSendError(response).catch(() => null);
      const status = result?.code === 'muted' && verifyMuteStatus({ ...result, muted: true });
      if (status) {
        notify(deviceSubject ?? subject, status);
        return { status: 403, error: MUTED, extra: { code: 'muted', expiresAt: status.expiresAt, ...(status.source && { source: status.source }) } };
      }
      return { status: 403, error: UNAVAILABLE };
    }
    try {
      if (response.status === 429) return { status: 429, error: BUSY, retryAfter: 5 };
      if (response.status !== 200 || mediaType(response) !== 'application/json') return { status: 503, error: UNAVAILABLE };
      const raw = await readLimitedText(response, 1024);
      const value = raw && JSON.parse(raw);
      if (typeof value?.nonce === 'string' && NONCE_FORMAT.test(value.nonce) && value.expiresIn === 30) {
        return { nonce: value.nonce, expiresIn: value.expiresIn };
      }
    } catch { /* Invalid upstream responses do not authorize local sends. */ }
    return { status: 503, error: UNAVAILABLE };
  }

  async function readSendError(response) {
    const reply = mediaType(response) === 'application/json' ? await readLimitedText(response, 2048) : null;
    return reply ? JSON.parse(reply) : null;
  }

  async function send({ text, nonce, nickname, groupTag }, subject, quota, deviceSubject, clientIP) {
    // The primary consumes the nonce and runs the authoritative nickname checks.
    const bridge = controller;
    const body = {
      text, nonce, groupTag,
      nickname: nickname === undefined || typeof nickname === 'string' ? nickname : null,
    };
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...privateHeaders(subject, quota, deviceSubject, undefined, undefined, clientIP) };
    const attempt = new AbortController();
    const timeout = setTimeout(() => attempt.abort(), 5000);
    timeout.unref();
    try {
      let response;
      try {
        response = await fetchUpstream(`${origin}${SEND_PATH}`, {
          method: 'POST', headers, body: JSON.stringify(body), signal: attempt.signal,
          redirect: offlineEnabled ? 'manual' : 'error',
        });
      } catch {
        // This may already have committed upstream. Switch only subsequent requests.
        markUnreachable(bridge);
        return { status: 503, error: UNAVAILABLE };
      }
      const cooldown = headerSeconds(response.headers.get(COOLDOWN_HEADER));
      if (response.status === 422) return { status: 422, error: BLOCKED, cooldown };
      if (response.status === 409) return staleRequest();
      if (response.status === 400) {
        const result = await readSendError(response).catch(() => null);
        return result?.code === 'nickname' ? nicknameRejected(cooldown) : { status: 400, error: INVALID };
      }
      if (response.status === 403 || response.status === 429 || response.status === 503) {
        const result = await readSendError(response).catch(() => null);
        if (response.status === 503 && result?.code === 'closed') {
          if (offlineEnabled && bridge === controller) updateAvailability(false);
          return closedResult();
        }
        if (response.status === 403 && result?.code === 'muted') {
          const status = verifyMuteStatus({ ...result, muted: true });
          if (status) return { status: 403, error: MUTED, extra: { code: 'muted', expiresAt: status.expiresAt, ...(status.source && { source: status.source }) } };
        }
        if (response.status === 403 && offlineEnabled) return { status: 403, error: UNAVAILABLE };
        if (response.status === 429) {
          const retryAfter = headerSeconds(response.headers.get('Retry-After')) || 5;
          const error = typeof result?.error === 'string' ? result.error : BUSY;
          if (result?.code === 'rate_limit') return rateLimited(retryAfter, error);
          if (result?.code === 'duplicate') return { status: 429, error: DUPLICATE, retryAfter, extra: { code: 'duplicate' } };
          return { status: 429, error, retryAfter };
        }
      }
      if (response.status >= 500) markUnreachable(bridge);
      if (response.status === 201 && mediaType(response) === 'application/json') {
        const message = verifyMessage(await response.json());
        if (message && !message.admin && message.kind !== 'moderation') return { status: 201, message, cooldown };
      }
    } catch { /* The mirror only publishes messages accepted by the main site. */ }
    finally {
      clearTimeout(timeout);
      attempt.abort();
    }
    return { status: 503, error: UNAVAILABLE };
  }

  async function like(id, clientId, sender) {
    if (pendingLikes >= MAX_PENDING_RELAY_LIKES) return { status: 429, error: LIKE_BUSY, retryAfter: 1 };
    pendingLikes++;
    try {
      const response = await fetchUpstream(`${origin}${LIKE_PATH}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...privateHeaders(sender.subject, sender.quota, sender.deviceSubject) },
        body: JSON.stringify({ id, clientId }), signal: AbortSignal.timeout(3500), redirect: 'error',
      });
      if (mediaType(response) === 'application/json') {
        const body = await readLimitedText(response, 2048);
        const value = body ? JSON.parse(body) : null;
        if (response.status === 200) {
          const like = verifyLike(value);
          if (like?.id === id) return { like };
        }
        if (response.status === 503 && value?.code === 'closed') return closedResult();
        if (response.status === 404) return { status: 404, error: LIKE_MISSING };
        if (response.status === 403) return { status: 403, error: LIKE_BLOCKED };
        if (response.status === 429) return { status: 429, error: LIKE_BUSY, retryAfter: headerSeconds(response.headers.get('Retry-After')) || 1 };
      }
    } catch { /* The primary remains authoritative if the relay request fails. */ }
    finally { pendingLikes--; }
    return { status: 503, error: LIKE_UNAVAILABLE };
  }

  async function loadMessages(pathname, maxBytes, timeoutMs, maxMessages = Infinity) {
    const attempt = new AbortController();
    const timeout = setTimeout(() => attempt.abort(), timeoutMs);
    timeout.unref();
    try {
      const response = await fetchUpstream(`${origin}${pathname}`, {
        headers: { Accept: 'application/json' }, signal: attempt.signal, redirect: 'error',
        ...(pathname === HISTORY_PATH && { cache: 'no-store' }),
      });
      if (response.status !== 200 || mediaType(response) !== 'application/json') return null;
      const body = await readLimitedText(response, maxBytes);
      if (body === null || attempt.signal.aborted) return null;
      const payload = JSON.parse(body);
      if (!Array.isArray(payload?.messages) || payload.messages.length > maxMessages) return null;
      const messages = new Map();
      for (const item of payload.messages) {
        const message = verifyMessage(item, pathname === HISTORY_PATH);
        if (message) messages.set(message.id, message);
      }
      return [...messages.values()];
    } catch { return null; }
    finally {
      clearTimeout(timeout);
      attempt.abort();
    }
  }

  function recent() {
    const time = now();
    if (recentCache && time >= recentCacheAt && time - recentCacheAt < RECENT_CACHE_TTL) return recentCache;
    if (recentRequest) return recentRequest;
    const revision = historyRevision;
    // Every coalesced caller must use the same revision check after a state change.
    const request = loadMessages(RECENT_PATH, MAX_RECENT_BYTES, 5000).then(messages => {
      if (revision !== historyRevision) return null;
      if (messages) {
        recentCache = messages;
        recentCacheAt = now();
      }
      return messages;
    }).finally(() => {
      if (recentRequest === request) recentRequest = undefined;
    });
    recentRequest = request;
    return request;
  }

  async function history() {
    const revision = historyRevision;
    const messages = await loadMessages(HISTORY_PATH, MAX_ARCHIVE_BYTES, ARCHIVE_RELAY_TIMEOUT, MAX_ARCHIVE);
    // Never serve an in-flight snapshot that crossed a withdrawal or availability change.
    return revision === historyRevision ? messages : [];
  }

  async function fetchStatus(subject) {
    const signal = AbortSignal.timeout(3500);
    try {
      const response = await fetchUpstream(`${origin}${STATUS_PATH}`, {
        headers: { Accept: 'application/json', ...privateHeaders(subject) }, signal, redirect: 'error',
      });
      if (response.status !== 200 || mediaType(response) !== 'application/json') return null;
      const body = await readLimitedText(response, 2048);
      return body ? verifyMuteStatus(JSON.parse(body)) : null;
    } catch { return null; }
  }

  function status(subject) {
    if (!relayKey) return { muted: false, expiresAt: null };
    if (statusRequests.has(subject)) return statusRequests.get(subject);
    if (statusRequests.size >= 32) return null;
    const request = fetchStatus(subject).finally(() => statusRequests.delete(subject));
    statusRequests.set(subject, request);
    return request;
  }

  async function communityVote(method, sender, id, action) {
    const url = new URL(COMMUNITY_VOTES_PATH, origin);
    if (method === 'GET' && id) url.searchParams.set('messageId', id);
    const signal = AbortSignal.timeout(5000);
    try {
      const response = await fetchUpstream(url.href, {
        method, headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...privateHeaders(sender.subject, sender.quota, sender.deviceSubject, sender.accountSubject, sender.memberRole) },
        ...(method === 'POST' ? { body: JSON.stringify({ messageId: id, ...(action ? { action } : {}) }) } : {}), signal, redirect: 'error',
      });
      const text = await readLimitedText(response, 4096);
      return { status: response.status, body: text ? JSON.parse(text) : { error: UNAVAILABLE }, retryAfter: response.headers.get('Retry-After') };
    } catch { return { status: 503, body: { error: UNAVAILABLE } }; }
  }

  return {
    waitForAvailability, isActive, isOffline, isPrimaryActive: () => upstreamActive === true,
    isClosed: () => lastPrimaryActive === false, stop, send, like, recent, history, status, issueNonce, communityVote,
  };
}

function anonymousMirrorMessage(message) {
  const { id, text, createdAt, groupTag } = message;
  return { id, text, createdAt, anonymous: true, ...(isGroupTag(groupTag) ? { groupTag } : {}) };
}

function submissionGroupTag(body) {
  const tag = body?.groupTag;
  if (tag !== undefined && !isGroupTag(tag)) throw new ContentError(400, '群标签须为 1 到 8 的整数');
  return tag;
}

function createDanmaku({
  publicOrigin, getAdminOrigin, getAccountOrigin, muteFile, communityMuteFile, historyFile, wordFile, settingsFile, scheduledFile, upstreamOrigin, fallbackDir,
  fetchUpstream = fetch, relayKey = '', deviceCookieDomain = '', readJson, sendJson, now = Date.now,
}) {
  const fallbackHistory = upstreamOrigin && fallbackDir
    ? createDanmakuHistory({ filePath: path.join(fallbackDir, 'mirror-danmaku-history.jsonl'), now }) : null;
  const offlineArchive = new Map();
  const offlineNonces = new Set();
  const knownMutes = new Map();
  const nonces = !upstreamOrigin || fallbackHistory ? createDanmakuNonces({ now }) : null;
  const words = !upstreamOrigin || fallbackHistory ? createWordStore({ filePath: upstreamOrigin ? undefined : wordFile }) : null;
  const mutes = !upstreamOrigin || fallbackHistory ? createMuteStore({
    filePath: fallbackHistory ? path.join(fallbackDir, 'mirror-danmaku-mutes.json') : muteFile, now,
  }) : null;
  const fallbackSettings = fallbackHistory ? createDanmakuSettings({ now }) : null;
  const communityMutes = upstreamOrigin ? null : createCommunityMuteStore({ filePath: communityMuteFile, now });
  const moderationHistory = !upstreamOrigin && historyFile ? createDanmakuHistory({ filePath: historyFile, now }) : null;
  const senderSecret = relayKey || mutes?.secret;
  const authorizedRelay = !upstreamOrigin && relayKey ? digest(`Bearer ${relayKey}`) : null;
  const origin = publicOrigin ? new URL(publicOrigin) : null;
  const clients = new Map();
  const eventReplay = new Map();
  const history = new Map();
  const archive = upstreamOrigin ? null : new Map();
  const removed = new Map();
  const lastAttempt = new Map();
  const lastRepeat = new Map();
  const recentSubmissions = new Map();
  const accepted = [];
  const remoteLikes = upstreamOrigin ? new Map() : null;
  const avatars = new Map();
  const pendingAvatars = new Map();
  const communityVotes = new Map();
  const communityCooldowns = new Map();
  const relayedVotes = upstreamOrigin ? new Map() : null;

  let likeWindowStart = -Infinity;
  let likesThisWindow = 0;
  let heartbeat;
  let scheduled;
  let historyCleanup;
  let historyClose;
  let offlineWrites = Promise.resolve();
  const settings = upstreamOrigin ? null : createDanmakuSettings({ filePath: settingsFile, now, onAvailability: broadcastAvailability });
  const relay = upstreamOrigin ? createRelay({
    origin: upstreamOrigin, fetchUpstream, relayKey, publish, removeMessages, notify,
    onAvailability: broadcastAvailability, onLike: receiveLike, onCommunityVote: broadcastCommunityVote, now,
    offlineEnabled: Boolean(fallbackHistory),
  }) : null;
  if (settings && scheduledFile) {
    scheduled = createScheduledDanmaku({ filePath: scheduledFile, now, isActive, publish, isBlocked: text => words.matches(text) });
  }

  const replayJournal = moderationHistory ?? fallbackHistory;
  if (replayJournal) {
    try {
      const records = replayJournal.recentForReplay(fallbackHistory
        ? { limit: MAX_ARCHIVE }
        : { maxAge: HISTORY_WINDOW, limit: MAX_HISTORY });
      // The journal also holds moderation notices, including ones created while the feed was closed.
      const visible = records.filter(({ message, subject, deviceSubject }) =>
        message.kind !== 'moderation' &&
        !(subject && sendMuteStatus(subject).muted) &&
        !(deviceSubject && deviceSubject !== subject && sendMuteStatus(deviceSubject).muted));
      // Seed the snapshot directly so startup does not append to the journal or emit SSE events.
      for (const record of visible) {
        const { message } = record;
        if (fallbackHistory) offlineArchive.set(message.id, anonymousMirrorMessage(message));
        else history.set(message.id, record);
      }
    } catch (error) {
      console.error('Cannot restore recent danmaku:', error.code || error.name);
    }
  }

  function isActive(at) {
    return relay ? relay.isActive() : settings.isActive(at);
  }

  function write(res, frame) {
    if (res.destroyed || res.writableEnded || res.writableLength > 8192) {
      res.destroy();
      return;
    }
    res.write(frame);
  }

  function pruneEventReplay(time) {
    for (const [id, { receivedAt }] of eventReplay) {
      if (time - receivedAt < REPLAY_WINDOW) break;
      eventReplay.delete(id);
    }
  }

  function pruneHistory(time) {
    for (const [id, { receivedAt }] of history) {
      if (time - receivedAt >= HISTORY_WINDOW) history.delete(id);
    }
    while (history.size > MAX_HISTORY) history.delete(history.keys().next().value);
    for (const [id, removedAt] of removed) {
      if (time - removedAt >= HISTORY_WINDOW || removed.size > MAX_HISTORY) removed.delete(id);
      else break;
    }
  }

  function cacheAvatar(tag, bytes) {
    avatars.delete(tag);
    avatars.set(tag, bytes);
    if (avatars.size > MAX_CACHED_AVATARS) avatars.delete(avatars.keys().next().value);
  }

  function noteRelayAvatar(message) {
    if (relay && message.avatar && !avatars.has(message.avatar)) cacheAvatar(message.avatar, null);
  }

  function addPublicAvatar(avatar) {
    if (typeof avatar !== 'string' || !avatar.startsWith(AVATAR_PREFIX)) return;
    const bytes = Buffer.from(avatar.slice(AVATAR_PREFIX.length), 'base64');
    if (!bytes.length || bytes.length > MAX_AVATAR_BYTES) return;
    const tag = avatarHash(bytes);
    cacheAvatar(tag, avatars.get(tag) || bytes);
    return tag;
  }

  async function serveAvatar(req, res, pathname, tag) {
    if (!avatars.has(tag)) return reject(res, 404, '头像已过期');
    let bytes = avatars.get(tag);
    if (relay && !bytes) {
      let request = pendingAvatars.get(tag);
      if (!request && pendingAvatars.size < 8) {
        request = (async () => {
          try {
            const response = await fetchUpstream(new URL(pathname, upstreamOrigin), {
              headers: { Accept: 'image/png' }, redirect: 'error', signal: AbortSignal.timeout(4000),
            });
            if (!response.ok || mediaType(response) !== 'image/png') {
              await response.body?.cancel().catch(() => {});
              return null;
            }
            const image = await readLimitedBytes(response, MAX_AVATAR_BYTES);
            if (!image || avatarHash(image) !== tag) return null;
            cacheAvatar(tag, image);
            return image;
          } catch { return null; }
        })().finally(() => pendingAvatars.delete(tag));
        pendingAvatars.set(tag, request);
      }
      bytes = await request;
    }
    if (res.destroyed) return;
    if (!bytes) return reject(res, 404, '头像暂时不可用');
    const etag = `"${tag}"`;
    const headers = { ETag: etag, 'Cache-Control': 'public, max-age=300', 'Cross-Origin-Resource-Policy': 'same-origin' };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'X-Content-Type-Options': 'nosniff' });
    return res.end(bytes);
  }

  function publish(message, subject, time = now(), archiveText, deviceSubject, clientIP) {
    const active = isActive(time);
    if (!active && message.kind !== 'moderation') return false;
    pruneEventReplay(time);
    pruneHistory(time);
    if (removed.has(message.id) || eventReplay.has(message.id) || history.has(message.id)) return false;
    noteRelayAvatar(message);
    const record = { message, receivedAt: time, subject, deviceSubject };
    if (moderationHistory) {
      void moderationHistory.add({ ...record, ip: clientIP }).catch(error => {
        console.error('Cannot persist danmaku history:', error.code || error.name);
      });
    }
    history.set(message.id, record);
    if (archive && (message.kind !== 'moderation' || archiveText)) {
      const archived = archiveText ? { ...record, message: { ...message, text: archiveText } } : record;
      archive.set(message.id, archived);
      if (archive.size > MAX_ARCHIVE) archive.delete(archive.keys().next().value);
    }
    pruneHistory(time);
    // Keep moderation history even while the public feed is closed.
    if (!active) return true;
    const frame = messageFrame(message);
    eventReplay.set(message.id, { frame, receivedAt: time });
    while (eventReplay.size > MAX_HISTORY) eventReplay.delete(eventReplay.keys().next().value);
    for (const res of clients.keys()) write(res, frame);
    return true;
  }

  function messageFrame(message) {
    return `id: ${message.id}\ndata: ${JSON.stringify(message)}\n\n`;
  }

  function withLikes(message) {
    if (message.kind === 'moderation') return message;
    const count = relay ? remoteLikes.get(message.id) : history.get(message.id)?.likers?.size;
    return count > (message.likes ?? 0) ? { ...message, likes: count } : message;
  }

  function broadcastLike(like) {
    const frame = event('like', like);
    for (const res of clients.keys()) write(res, frame);
  }

  function receiveLike(like) {
    if (removed.has(like.id) || like.count <= (remoteLikes.get(like.id) ?? 0)) return;
    remoteLikes.delete(like.id);
    remoteLikes.set(like.id, like.count);
    if (remoteLikes.size > MAX_HISTORY) remoteLikes.delete(remoteLikes.keys().next().value);
    broadcastLike(like);
  }

  function event(name, data) {
    return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function broadcastCommunityVote(vote) {
    if (relayedVotes) {
      if (vote.status === 'pending' && Date.parse(vote.expiresAt) > now()) relayedVotes.set(vote.messageId, vote);
      else relayedVotes.delete(vote.messageId);
      if (relayedVotes.size > MAX_COMMUNITY_VOTES) relayedVotes.delete(relayedVotes.keys().next().value);
    }
    const frame = event('community-vote', vote);
    for (const res of clients.keys()) write(res, frame);
  }

  function broadcastAvailability(active) {
    const frame = event('availability', { active });
    for (const res of clients.keys()) write(res, frame);
    scheduled?.wake();
  }

  function rememberMute(subject, status) {
    if (!fallbackHistory || !subject || !status) return;
    knownMutes.delete(subject);
    if (!status.muted) return;
    knownMutes.set(subject, status);
    if (knownMutes.size > MAX_KNOWN_MUTES) knownMutes.delete(knownMutes.keys().next().value);
  }

  function knownMute(subject) {
    const status = knownMutes.get(subject);
    if (status && (status.expiresAt === null || Date.parse(status.expiresAt) > now())) return status;
    if (status) knownMutes.delete(subject);
    return { muted: false, expiresAt: null };
  }

  async function visitorStatus(subject) {
    if (!relay || relay.isOffline()) return sendMuteStatus(subject);
    const localMute = fallbackHistory && mutes.get(subject);
    if (localMute) return { muted: true, expiresAt: localMute.expiresAt };
    const before = knownMutes.get(subject);
    const status = await relay.status(subject);
    // A moderation event received during the read is newer than the cached value.
    if (knownMutes.get(subject) !== before) return knownMute(subject);
    if (relayKey) rememberMute(subject, status);
    const cached = knownMute(subject);
    return status ?? (cached.muted || relay.isOffline() ? cached : null);
  }

  function notify(subject, status) {
    rememberMute(subject, status);
    broadcastMute(subject, fallbackHistory ? sendMuteStatus(subject) : status);
  }

  function broadcastMute(subject, status) {
    const browserFrame = event('mute', status);
    const relayFrame = event('moderation', { ...status, subject });
    for (const [res, client] of clients) {
      if (client.bridged) write(res, relayFrame);
      else if (client.subject === subject) write(res, browserFrame);
    }
  }

  function removeMessages(ids) {
    if (moderationHistory && ids.length) {
      void moderationHistory.remove(ids).catch(error => {
        console.error('Cannot update danmaku history:', error.code || error.name);
      });
    }
    for (const id of ids) {
      history.delete(id);
      archive?.delete(id);
      offlineArchive.delete(id);
      eventReplay.delete(id);
      remoteLikes?.delete(id);
      removed.set(id, now());
    }
    // Leave each frame small enough for the mirror's streaming parser.
    for (let index = 0; index < ids.length; index += 50) {
      const frame = event('remove', { ids: ids.slice(index, index + 50) });
      for (const res of clients.keys()) write(res, frame);
    }
  }

  function checkOrigin(req, requestOrigin = origin?.origin) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    if (!req.headers.origin) return true;
    if (requestOrigin) return req.headers.origin === requestOrigin;
    return /^https?:\/\//.test(req.headers.origin) && req.headers.origin === `http://${req.headers.host}`;
  }

  function clientKey(req) {
    const peer = req.socket.remoteAddress;
    // Only a loopback reverse proxy for our configured HTTPS host can set this header.
    const forwarded = req.headers['x-real-ip'];
    if (origin?.protocol === 'https:' && req.headers.host?.toLowerCase() === origin.host && LOOPBACK.has(peer) &&
        req.headers['x-forwarded-proto'] === 'https' && typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
    return peer;
  }

  function isRelay(req) {
    return authorizedRelay && typeof req.headers.authorization === 'string' &&
      timingSafeEqual(authorizedRelay, digest(req.headers.authorization));
  }

  function readDeviceCookie(req, name) {
    const cookie = req.headers.cookie;
    if (typeof cookie !== 'string' || cookie.length > 8192) return null;
    for (const part of cookie.split(';')) {
      const entry = part.trim();
      if (!entry.startsWith(`${name}=`)) continue;
      const key = entry.slice(name.length + 1);
      if (DEVICE_KEY.test(key)) return key;
    }
    return null;
  }

  function browserDevices(req) {
    const shared = readDeviceCookie(req, DEVICE_COOKIE);
    const host = readDeviceCookie(req, `__Host-${DEVICE_COOKIE}`);
    return [...new Set((deviceCookieDomain ? [shared, host] : [host, shared]).filter(Boolean))];
  }

  function browserDevice(req) {
    return browserDevices(req)[0];
  }

  function issueBrowserDevice(req, listenerOrigin = origin) {
    const legacyDevice = origin?.protocol === 'https:' ? readDeviceCookie(req, `__Host-${DEVICE_COOKIE}`) : null;
    const sharedDevice = deviceCookieDomain ? readDeviceCookie(req, DEVICE_COOKIE) : null;
    if (deviceCookieDomain && !sharedDevice && listenerOrigin?.protocol === 'https:' &&
        (listenerOrigin.hostname === deviceCookieDomain || listenerOrigin.hostname.endsWith(`.${deviceCookieDomain}`))) {
      const device = legacyDevice || randomBytes(24).toString('hex');
      return {
        'Set-Cookie': `${DEVICE_COOKIE}=${device}; Domain=${deviceCookieDomain}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000; Secure`,
        'Cache-Control': 'private, no-store',
      };
    }
    if (browserDevice(req)) return {};
    const secure = listenerOrigin?.protocol === 'https:' ? '; Secure' : '';
    const device = randomBytes(24).toString('hex');
    return {
      'Set-Cookie': `${secure ? `__Host-${DEVICE_COOKIE}` : DEVICE_COOKIE}=${device}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000${secure}`,
      'Cache-Control': 'private, no-store',
    };
  }

  function distinctSubject(kind, id) {
    return createHmac('sha256', senderSecret).update(`danmaku-${kind}\0${id}`).digest('hex');
  }

  function identify(req, pathname, browserListener) {
    if (!browserListener && isRelay(req)) {
      const subject = req.headers['x-danmaku-subject'];
      const quotaHeader = req.headers['x-danmaku-quota'];
      const deviceSubject = req.headers['x-danmaku-device-subject'];
      const accountSubject = req.headers['x-danmaku-account-subject'];
      const memberRole = req.headers['x-danmaku-member-role'];
      const forwardedIP = req.headers['x-danmaku-client-ip'];
      // The mirror's shared SSE bridge has no visitor identity; relay POSTs must carry one.
      if (subject === undefined && quotaHeader === undefined && deviceSubject === undefined &&
          (pathname === STREAM_PATH || pathname === RECENT_PATH || pathname === HISTORY_PATH)) {
        return {};
      }
      const quota = quotaHeader ?? subject;
      if (typeof subject !== 'string' || !SUBJECT.test(subject) || typeof quota !== 'string' || !SUBJECT.test(quota) ||
          (deviceSubject !== undefined && (typeof deviceSubject !== 'string' || !SUBJECT.test(deviceSubject))) ||
          (accountSubject !== undefined && (typeof accountSubject !== 'string' || !SUBJECT.test(accountSubject))) ||
          (forwardedIP !== undefined && (typeof forwardedIP !== 'string' || !isIP(forwardedIP))) ||
          (memberRole !== undefined && (typeof memberRole !== 'string' || !COMMUNITY_MEMBER_ROLES.has(memberRole))) ||
          (memberRole !== undefined && accountSubject === undefined)) {
        throw new ContentError(400, '弹幕转发身份有误');
      }
      return { subject, quota, deviceSubject, accountSubject, memberRole, clientIP: normalizeClientIP(forwardedIP) };
    }
    const address = browserListener?.clientAddress ?? clientKey(req);
    const quota = senderFromAddress(address);
    const deviceSubjects = senderSecret ? browserDevices(req).map(device => distinctSubject('device', device)) : [];
    const deviceSubject = deviceSubjects.find(subject => {
      if (!relay) return mutes?.get(subject);
      if (fallbackHistory && mutes.get(subject)) return true;
      const status = knownMute(subject);
      return status.muted && status.source !== 'community';
    }) || deviceSubjects[0];
    // Raw API clients without a browser cookie retain the original fallback identity.
    return { subject: deviceSubject || quota, quota, deviceSubject, clientIP: normalizeClientIP(address) };
  }

  function normalizeClientIP(address) {
    if (typeof address !== 'string' || address.length > 45 || address.includes('%') || !isIP(address)) return undefined;
    return address.toLowerCase().startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  }

  function senderFromAddress(address = 'unknown') {
    const canonical = address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7)
      : isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname : address;
    return senderSecret ? createHmac('sha256', senderSecret).update(`danmaku-sender\0${canonical}`).digest('hex') : canonical;
  }

  function muteStatus(subject) {
    const record = mutes.get(subject);
    return { muted: Boolean(record), expiresAt: record?.expiresAt ?? null };
  }

  function communityMuteStatus(subject) {
    const record = communityMutes?.get(subject);
    return record ? { muted: true, expiresAt: record.expiresAt, source: 'community' } : { muted: false, expiresAt: null };
  }

  function sendMuteStatus(subject) {
    if (relay) {
      const localMute = fallbackHistory && mutes.get(subject);
      return localMute ? { muted: true, expiresAt: localMute.expiresAt } : knownMute(subject);
    }
    const management = muteStatus(subject);
    return management.muted ? management : communityMuteStatus(subject);
  }

  function trackAttempt(subject, time) {
    // Retain attempts for the maximum configurable interval so increases take effect immediately.
    for (const [key, previous] of lastAttempt) {
      if (time - previous < POST_WINDOW) break;
      lastAttempt.delete(key);
    }

    if (!lastAttempt.delete(subject) && lastAttempt.size >= MAX_SENDERS) {
      return { status: 429, error: BUSY, retryAfter: 5 };
    }
    lastAttempt.set(subject, time);
  }

  function reject(res, status, error, headers = {}, extra = {}) {
    if (!res.destroyed) sendJson(res, status, { error, ...extra }, { Connection: 'close', ...headers });
  }

  function open(req, res, sender = identify(req), browserListener) {
    if (clients.size >= MAX_STREAMS) return reject(res, 503, UNAVAILABLE, { 'Retry-After': '15' });
    const bridged = !browserListener && Boolean(isRelay(req));
    const subject = bridged ? undefined : sender.deviceSubject || sender.subject;
    const initialMute = !bridged && mutes ? sendMuteStatus(subject) : null;
    const active = isActive();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 5000\n\n');
    write(res, event('availability', { active }));
    const lastId = req.headers['last-event-id'];
    pruneEventReplay(now());
    if (active && eventReplay.has(lastId)) {
      let pastLastId = false;
      for (const [id, { frame }] of eventReplay) {
        if (pastLastId) {
          const message = history.get(id)?.message;
          const current = message && withLikes(message);
          write(res, current ? messageFrame(current) : frame);
        }
        if (id === lastId) pastLastId = true;
      }
    }
    if (initialMute?.muted) write(res, event('mute', initialMute));
    if (active) {
      const time = now();
      if (relayedVotes && relay.isPrimaryActive()) {
        for (const [id, vote] of [...relayedVotes].slice(-24)) {
          if (Date.parse(vote.expiresAt) > time) write(res, event('community-vote', vote));
          else relayedVotes.delete(id);
        }
      } else {
        pruneCommunityState(time);
        for (const vote of [...communityVotes.values()].slice(-24)) {
          if (vote.status === 'pending' && vote.expiresAt > time) write(res, event('community-vote', communityVoteState(vote)));
        }
      }
    }
    clients.set(res, { subject, bridged });
    res.once('close', () => {
      clients.delete(res);
      if (!clients.size) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    });
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        for (const client of clients.keys()) write(client, ': keepalive\n\n');
      }, PING_INTERVAL);
      heartbeat.unref();
    }
  }

  async function sendRecent(req, res) {
    const upstreamMessages = relay?.isPrimaryActive() ? await relay.recent() : null;
    if (res.destroyed) return;
    const time = now();
    if (!isActive(time)) return sendJson(res, 200, { messages: [], partial: false }, {}, req);
    pruneHistory(time);
    const source = relay ? [...(upstreamMessages ?? []), ...offlineArchive.values()] : [...history.values()].map(record => record.message);
    const cutoff = time - HISTORY_WINDOW;
    const messages = source.filter(message => {
      const createdAt = Date.parse(message.createdAt);
      return !removed.has(message.id) && createdAt >= cutoff && createdAt <= time + 30_000;
    }).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map(withLikes);
    if (relay) messages.forEach(noteRelayAvatar);
    sendJson(res, 200, { messages, partial: Boolean(relay && upstreamMessages === null) }, { 'Cache-Control': 'no-store' }, req);
  }

  function pruneOfflineArchive(time) {
    const cutoff = time - RETENTION_DAYS * 86_400_000;
    for (const [id, message] of offlineArchive) {
      if (Date.parse(message.createdAt) <= cutoff) offlineArchive.delete(id);
    }
  }

  async function sendHistory(req, res) {
    const upstreamMessages = relay?.isPrimaryActive() ? await relay.history() : null;
    if (res.destroyed) return;
    if (!isActive()) return sendJson(res, 200, { messages: [] }, {}, req);
    if (relay && upstreamMessages === null && !relay.isOffline()) return reject(res, 503, HISTORY_UNAVAILABLE);
    pruneOfflineArchive(now());
    const source = relay ? [...(upstreamMessages ?? []), ...offlineArchive.values()] : [...archive.values()].reverse().map(record => record.message);
    const messages = source.filter(message => !removed.has(message.id))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, MAX_ARCHIVE);
    if (relay) messages.forEach(noteRelayAvatar);
    sendJson(res, 200, { messages }, {}, req);
  }

  async function readBody(req) {
    const deadline = setTimeout(() => req.destroy(), 5000);
    deadline.unref();
    try { return await readJson(req, MAX_BODY); }
    finally { clearTimeout(deadline); }
  }

  function submissionText(body) {
    const text = cleanDanmakuText(body?.text);
    if (!text) throw new ContentError(400, INVALID);
    return text;
  }

  function countLike(id, clientId) {
    const time = now();
    if (!isActive(time)) return closedResult();
    pruneHistory(time);
    const record = history.get(id) ?? archive.get(id);
    if (!record) return { status: 404, error: LIKE_MISSING };
    if (record.message.kind === 'moderation') return { status: 403, error: LIKE_BLOCKED };
    const likers = record.likers ??= new Set();
    if (likers.has(clientId)) return { like: { id, count: likers.size } };
    if (time < likeWindowStart || time - likeWindowStart >= LIKE_WINDOW) {
      likeWindowStart = time;
      likesThisWindow = 0;
    }
    if (likesThisWindow >= LIKE_WINDOW_LIMIT || likers.size >= MAX_LIKES) {
      return { status: 429, error: LIKE_BUSY, retryAfter: 1 };
    }
    likesThisWindow++;
    likers.add(clientId);
    const like = { id, count: likers.size };
    record.message = { ...record.message, likes: like.count };
    broadcastLike(like);
    return { like };
  }

  function pruneCommunityState(time) {
    for (const [id, vote] of communityVotes) {
      if (vote.committing) continue;
      if (vote.status === 'pending' && vote.expiresAt <= time) failCommunityVote(vote);
      if (vote.expiresAt + COMMUNITY_COOLDOWN <= time) communityVotes.delete(id);
    }
    for (const [key, at] of communityCooldowns) if (at + COMMUNITY_COOLDOWN <= time) communityCooldowns.delete(key);
  }

  function communityVoteState(vote) {
    return { messageId: vote.messageId, votes: vote.count, threshold: vote.threshold, expiresAt: new Date(vote.expiresAt).toISOString(), status: vote.status };
  }

  function failCommunityVote(vote) {
    clearTimeout(vote.timer);
    vote.status = 'failed';
    broadcastCommunityVote(communityVoteState(vote));
  }

  async function handleCommunityVote(req, res, sender, headers = {}) {
    const replyHeaders = { ...headers, 'Cache-Control': 'no-store' };
    if (req.method !== 'GET' && req.method !== 'POST') return reject(res, 405, '只支持 GET 或 POST', { ...headers, Allow: 'GET, POST' });
    const reading = req.method === 'GET';
    const body = reading ? null : await readBody(req);
    const messageId = reading ? new URL(req.url, 'http://localhost').searchParams.get('messageId') : body?.messageId;
    const requestedAction = reading ? undefined : body?.action;
    if (res.destroyed) return;
    if ((messageId !== null || !reading) && (typeof messageId !== 'string' || !UUID.test(messageId))) {
      return reject(res, 400, '弹幕编号有误', replyHeaders);
    }
    if (!reading && requestedAction !== undefined && requestedAction !== 'start' && requestedAction !== 'support') {
      return reject(res, 400, '投票操作有误', replyHeaders, { code: 'community_vote_action_invalid' });
    }
    const mayStart = Boolean(sender.accountSubject && sender.memberRole === 'user');
    if (!reading && requestedAction === 'start' && !mayStart) {
      return reject(res, sender.accountSubject ? 403 : 401,
        sender.accountSubject ? '只有普通登录用户可以发起社区禁言投票' : '请先登录普通账号，再发起社区禁言投票', replyHeaders,
        { code: sender.accountSubject ? 'community_vote_start_forbidden' : 'community_vote_login_required' });
    }
    if (relay) {
      const result = await relay.communityVote(req.method, sender, messageId, requestedAction);
      return sendJson(res, result.status, result.body, { ...replyHeaders, ...(result.retryAfter ? { 'Retry-After': result.retryAfter } : {}) }, req);
    }
    const time = now();
    pruneCommunityState(time);
    const { deviceSubject, accountSubject } = sender;
    const voterKeys = [...new Set([accountSubject, deviceSubject, !accountSubject && !deviceSubject ? sender.subject : null].filter(Boolean))];
    let vote = communityVotes.get(messageId);
    const remaining = () => Math.max(0, ...voterKeys.map(key => seconds((communityCooldowns.get(key) ?? -Infinity) + COMMUNITY_COOLDOWN - now())));
    const respond = () => sendJson(res, 200, { vote: vote ? communityVoteState(vote) : null, remainingCooldownSeconds: remaining() }, replyHeaders, req);
    if (reading) return respond();
    if (!isActive(time)) return sendResult(res, closedResult(), headers);
    const voteIsPending = vote?.status === 'pending' && vote.expiresAt > time;
    const voteCanBeSupported = voteIsPending && !vote.committing;
    const action = requestedAction ?? (voteCanBeSupported ? 'support' : 'start');
    if (action === 'start' && !mayStart) {
      return reject(res, sender.accountSubject ? 403 : 401,
        sender.accountSubject ? '只有普通登录用户可以发起社区禁言投票' : '请先登录普通账号，再发起社区禁言投票', replyHeaders,
        { code: sender.accountSubject ? 'community_vote_start_forbidden' : 'community_vote_login_required' });
    }
    if (!voterKeys.length) return reject(res, 403, '请启用浏览器设备标识后再参与社区投票', replyHeaders);
    const managementMute = voterKeys.map(muteStatus).find(status => status.muted);
    if (managementMute) return reject(res, 403, MUTED, replyHeaders, { code: 'muted', expiresAt: managementMute.expiresAt });
    if (action === 'support' && !vote) {
      return reject(res, 404, '这条弹幕没有正在进行的社区禁言投票', replyHeaders, { code: 'community_vote_not_found' });
    }
    if (action === 'support' && !voteCanBeSupported) {
      return reject(res, 409, '这条社区禁言投票已经结束', replyHeaders, {
        code: 'community_vote_closed', vote: communityVoteState(vote), remainingCooldownSeconds: remaining(),
      });
    }
    if (action === 'start' && voteIsPending) {
      return reject(res, 409, vote.committing ? '这条社区禁言投票正在处理' : '这条弹幕已有进行中的投票，请选择支持', replyHeaders, {
        code: vote.committing ? 'community_vote_processing' : 'community_vote_exists',
        vote: communityVoteState(vote), remainingCooldownSeconds: remaining(),
      });
    }
    let target;
    if (action === 'start') {
      pruneHistory(time);
      target = history.get(messageId) ?? archive.get(messageId);
      if (!target || target.message.admin || target.message.staff || target.message.kind === 'moderation' || !target.subject ||
          (!target.message.member && !target.deviceSubject)) return reject(res, 404, '这条弹幕无法发起社区禁言投票', replyHeaders, { code: 'community_vote_target_unavailable' });
    }
    if (voterKeys.some(key => key === (vote || target).subject || key === (vote || target).deviceSubject)) {
      return reject(res, 403, '不能对自己的弹幕投票', replyHeaders, { code: 'community_vote_self_vote' });
    }
    if (action === 'start') {
      const remainingCooldownSeconds = remaining();
      if (remainingCooldownSeconds > 0) return reject(res, 429, '发起社区禁言投票太频繁', { ...replyHeaders, 'Retry-After': String(remainingCooldownSeconds) }, { code: 'community_vote_cooldown', remainingCooldownSeconds });
      if (communityVotes.size >= MAX_COMMUNITY_VOTES || communityCooldowns.size + voterKeys.length > MAX_SENDERS) {
        return reject(res, 503, '社区投票暂时繁忙，请稍后再试', { ...replyHeaders, 'Retry-After': '5' });
      }
      const threshold = settings?.read()?.communityVoteThreshold ?? 6;
      vote = { messageId, subject: target.subject, deviceSubject: target.deviceSubject, voters: new Set(), count: 0, threshold, expiresAt: time + COMMUNITY_WINDOW, status: 'pending' };
      communityVotes.set(messageId, vote);
      for (const key of voterKeys) communityCooldowns.set(key, time);
      vote.timer = setTimeout(() => {
        if (vote.status === 'pending' && !vote.committing) failCommunityVote(vote);
      }, COMMUNITY_WINDOW).unref();
    }
    if (voterKeys.some(key => vote.voters.has(key))) return reject(res, 409, '这个账号或设备已投过票', replyHeaders, { code: 'duplicate_vote', vote: communityVoteState(vote), remainingCooldownSeconds: remaining() });
    for (const key of voterKeys) vote.voters.add(key);
    if (++vote.count >= vote.threshold) {
      vote.committing = true;
      clearTimeout(vote.timer);
      const targets = [...new Set([vote.subject, vote.deviceSubject].filter(Boolean))];
      const expiresAt = new Date(time + COMMUNITY_MUTE).toISOString();
      try {
        if (!relayKey) await mutes.ensurePersisted();
        await communityMutes.setMany(targets, expiresAt);
      } catch (error) {
        failCommunityVote(vote);
        throw error;
      } finally {
        delete vote.committing;
      }
      vote.status = 'passed';
      broadcastCommunityVote(communityVoteState(vote));
      removeMessages([messageId]);
      for (const subject of targets) notify(subject, sendMuteStatus(subject));
    } else {
      broadcastCommunityVote(communityVoteState(vote));
    }
    return respond();
  }

  async function handleLike(req, res, sender = identify(req)) {
    if (!isActive()) return sendResult(res, closedResult());
    const { id, clientId } = await readBody(req) ?? {};
    if (!isActive()) return sendResult(res, closedResult());
    if (typeof id !== 'string' || !UUID.test(id) || typeof clientId !== 'string' || !LIKE_CLIENT_ID.test(clientId)) {
      return reject(res, 400, LIKE_INVALID);
    }
    if (relay?.isOffline() || offlineArchive.has(id)) return sendResult(res, { status: 503, error: LIKE_UNAVAILABLE });
    const result = relay ? await relay.like(id, clientId, sender) : countLike(id, clientId);
    if (res.destroyed) return;
    if (relay && !isActive()) return sendResult(res, closedResult());
    if (result.like) return sendJson(res, 200, result.like);
    return sendResult(res, result);
  }

  function quotaWait(subject, time, perMinute) {
    const recent = recentSubmissions.get(subject);
    if (!recent || recent.length < perMinute) return 0;
    // After a quota decrease, enough old submissions must expire to free a slot.
    return seconds(recent[recent.length - perMinute] + POST_WINDOW - time);
  }

  function limitPosting(subject, time, { perMinute, minIntervalSeconds }, previousAttempt) {
    const wait = quotaWait(subject, time, perMinute);
    const interval = Math.max(
      intervalWait(previousAttempt, time, minIntervalSeconds),
      intervalWait(recentSubmissions.get(subject)?.at(-1), time, minIntervalSeconds),
    );
    if (wait) return rateLimited(Math.max(wait, interval), `每分钟最多发送 ${perMinute} 条弹幕`);
    if (interval) return intervalLimited(interval, minIntervalSeconds);
  }

  function recordSubmission(subject, time, { perMinute, minIntervalSeconds }) {
    // The global send limit also bounds this rolling window. Expire unused senders.
    for (const [key, recent] of recentSubmissions) {
      while (recent.length && time - recent[0] >= POST_WINDOW) recent.shift();
      if (!recent.length) recentSubmissions.delete(key);
    }
    const recent = recentSubmissions.get(subject) || [];
    recent.push(time);
    recentSubmissions.set(subject, recent);
    return Math.max(minIntervalSeconds, quotaWait(subject, time, perMinute));
  }

  function makeMessage(text, time, { nickname, color, admin = false, staff, member, sponsor, avatar, groupTag }) {
    return {
      id: randomUUID(), text, createdAt: new Date(time).toISOString(),
      ...(admin ? { admin: true } : {}), ...appearance(nickname, color, admin, staff, member && sponsor),
      ...(member ? { member: true } : {}), ...(member && sponsor ? { sponsor: true } : {}), ...(avatar ? { avatar } : {}),
      ...(isGroupTag(groupTag) ? { groupTag } : {}),
    };
  }

  function publishText(text, time, subject, options) {
    const message = makeMessage(text, time, options);
    publish(message, subject, time, undefined, options.deviceSubject, options.ip);
    return message;
  }

  function publishModeration(original, action) {
    const time = now();
    const text = original ? `弹幕“${original}”${action}` : `弹幕${action}`;
    const message = { id: randomUUID(), text, createdAt: new Date(time).toISOString(), kind: 'moderation' };
    publish(message, undefined, time, archiveModerationText(action));
  }

  function accept(text, quota, rawNickname, time, rateLimit, groupTag) {
    const limit = limitPosting(quota, time, rateLimit);
    if (limit) return limit;
    const nickname = cleanDanmakuNickname(rawNickname);
    if (nickname === null) return nicknameRejected();
    const simplified = text.normalize('NFKC').toLowerCase().replace(/[\p{White_Space}\p{P}\p{Cf}]+/gu, '');
    const repeatKey = `${quota}:${simplified || text}`;
    for (const [key, at] of lastRepeat) {
      if (time - at < REPEAT_WINDOW) break;
      lastRepeat.delete(key);
    }
    if (lastRepeat.has(repeatKey)) {
      const retryAfter = Math.max(1, Math.ceil((REPEAT_WINDOW - (time - lastRepeat.get(repeatKey))) / 1000));
      return { status: 429, error: DUPLICATE, retryAfter, extra: { code: 'duplicate' } };
    }
    while (accepted.length && time - accepted[0] >= 10_000) accepted.shift();
    if (accepted.length >= 20) return { status: 429, error: BUSY, retryAfter: 5 };
    const blocked = words.matches(text);
    const blockedNickname = nickname && words.matches(nickname);
    accepted.push(time);
    lastRepeat.set(repeatKey, time);
    const cooldown = recordSubmission(quota, time, rateLimit);
    if (blockedNickname) return nicknameRejected(cooldown);
    if (blocked) return { status: 422, error: BLOCKED, cooldown };
    return { status: 201, message: makeMessage(text, time, { nickname, groupTag }), cooldown };
  }

  function validateNickname(raw, { required = false } = {}) {
    const nickname = cleanDanmakuNickname(raw);
    if (nickname === null || (required && !nickname)) {
      throw new ContentError(400, '昵称须为 1–6 个汉字或 1–12 个英文字符');
    }
    if (nickname && words.matches(nickname)) throw new ContentError(400, '这个昵称不能使用，请换一个');
    return nickname;
  }

  function enqueueOfflineWrite(work) {
    const result = offlineWrites.then(work);
    offlineWrites = result.catch(() => {});
    return result;
  }

  async function sendVisitor(res, body, { subject, quota, deviceSubject, clientIP }) {
    if (res.destroyed) return;
    if (fallbackHistory && !relay.isOffline()) return sendResult(res, staleRequest());
    const time = now();
    if (!isActive(time)) return sendResult(res, closedResult());
    const mute = sendMuteStatus(subject);
    if (mute.muted) return reject(res, 403, MUTED, {}, { code: 'muted', expiresAt: mute.expiresAt, ...(mute.source && { source: mute.source }) });
    const rateLimit = (settings ?? fallbackSettings).rateLimit();
    const limit = limitPosting(quota, time, rateLimit, lastAttempt.get(quota)) ?? trackAttempt(quota, time);
    if (limit) return sendResult(res, limit);
    const result = accept(submissionText(body), quota, fallbackHistory ? undefined : body.nickname, time, rateLimit, body.groupTag);
    if (fallbackHistory && result.status === 422) result.extra = { ...result.extra, anonymous: true };
    if (result.message) {
      if (fallbackHistory) {
        // Commit locally before acknowledging the send. This journal is never uploaded.
        if (!relayKey && deviceSubject) await mutes.ensurePersisted();
        await fallbackHistory.add({ message: result.message, receivedAt: time, deviceSubject });
        result.message = anonymousMirrorMessage(result.message);
        offlineArchive.set(result.message.id, result.message);
        if (offlineArchive.size > MAX_ARCHIVE) offlineArchive.delete(offlineArchive.keys().next().value);
      }
      publish(result.message, subject, time, undefined, deviceSubject, clientIP);
    }
    return sendResult(res, result);
  }

  function sendResult(res, result, headers = {}) {
    if (res.destroyed) return;
    const responseHeaders = { ...headers };
    if (result.cooldown !== undefined) responseHeaders[COOLDOWN_HEADER] = String(result.cooldown);
    if (result.retryAfter) responseHeaders['Retry-After'] = String(result.retryAfter);
    if (result.message) return sendJson(res, 201, result.message, responseHeaders);
    return reject(res, result.status, result.error, responseHeaders, result.extra);
  }

  async function handle(req, res, pathname, browserListener) {
    const method = pathname === SEND_PATH || pathname === LIKE_PATH ? 'POST' : pathname === COMMUNITY_VOTES_PATH ? req.method : 'GET';
    if (req.method !== method) return reject(res, 405, `只支持 ${method}`, { Allow: method });
    if (!checkOrigin(req, browserListener?.origin)) return reject(res, 403, '请从本站使用弹幕');
    try {
      const avatar = AVATAR_PATH.exec(pathname);
      if (avatar) return await serveAvatar(req, res, pathname, avatar[1]);
      if (fallbackHistory && pathname !== COMMUNITY_VOTES_PATH) {
        await relay.waitForAvailability();
        if (res.destroyed) return;
      }
      const sender = identify(req, pathname, browserListener);
      if (pathname === COMMUNITY_VOTES_PATH) return await handleCommunityVote(req, res, sender);
      const protectedRoute = [SEND_PATH, LIKE_PATH, STREAM_PATH, RECENT_PATH, HISTORY_PATH, NONCE_PATH].includes(pathname);
      if (protectedRoute && sender.deviceSubject) {
        const status = relay ? await visitorStatus(sender.deviceSubject) : muteStatus(sender.deviceSubject);
        if (res.destroyed) return;
        if (status?.muted && status.source !== 'community') return reject(res, 403, MUTED, {}, { code: 'muted', expiresAt: status.expiresAt });
      }
      if (relay && !fallbackHistory && pathname !== STATUS_PATH && pathname !== NONCE_PATH) {
        // Keep one bridge after the first danmaku request, including when no browsers are watching.
        await relay.waitForAvailability();
        if (res.destroyed) return;
      }
      if (pathname === LIKE_PATH) return await handleLike(req, res, sender);
      if (pathname === STREAM_PATH) return open(req, res, sender, browserListener);
      if (pathname === RECENT_PATH) return await sendRecent(req, res);
      if (pathname === HISTORY_PATH) return await sendHistory(req, res);
      if (pathname === CONFIG_PATH) {
        const adminOrigin = browserListener ? browserListener.adminOrigin : (getAdminOrigin?.(req) || null);
        const accountOrigin = adminOrigin && getAccountOrigin?.();
        return sendJson(res, 200, { adminOrigin, active: isActive(), ...(accountOrigin ? { accountOrigin } : {}) });
      }
      const { subject, quota, deviceSubject } = sender;
      if (pathname === STATUS_PATH) {
        const status = await visitorStatus(subject);
        if (res.destroyed) return;
        return status ? sendJson(res, 200, status) : reject(res, 503, UNAVAILABLE);
      }
      const binding = `visitor:${subject}`;
      if (pathname === NONCE_PATH) {
        if (fallbackHistory && relay.isClosed()) return sendResult(res, closedResult());
        let token;
        if (relay && !relay.isOffline()) token = await relay.issueNonce(subject, quota, deviceSubject);
        if (!relay || (!token && relay.isOffline())) {
          token = nonces.issue(binding);
          if (fallbackHistory) {
            offlineNonces.add(token.nonce);
            if (offlineNonces.size > MAX_OFFLINE_NONCES) offlineNonces.delete(offlineNonces.values().next().value);
          }
        }
        if (res.destroyed) return;
        if (token?.status) return sendResult(res, token);
        return token ? sendJson(res, 200, token) : reject(res, 503, UNAVAILABLE);
      }
      const body = await readBody(req);
      if (res.destroyed) return;
      const nonce = body?.nonce;
      if (typeof nonce !== 'string' || !NONCE_FORMAT.test(nonce)) return sendResult(res, staleRequest());
      submissionGroupTag(body);
      if (relay && !relay.isOffline()) {
        if (offlineNonces.has(nonce)) {
          nonces.consume(binding, nonce);
          return sendResult(res, staleRequest());
        }
        if (fallbackHistory && !relay.isPrimaryActive()) {
          return sendResult(res, relay.isClosed() ? closedResult() : { status: 503, error: UNAVAILABLE });
        }
        const result = await relay.send(body, subject, quota, deviceSubject, sender.clientIP);
        if (result.extra?.code === 'muted') rememberMute(subject, { ...result.extra, muted: true });
        if (result.message && relay.isPrimaryActive()) publish(result.message);
        return sendResult(res, result);
      }
      // Consume before rate and mute checks. An upstream nonce cannot authorize a local send.
      if (!nonces.consume(binding, nonce)) return sendResult(res, staleRequest());
      if (fallbackHistory) return await enqueueOfflineWrite(() => sendVisitor(res, body, sender));
      return await sendVisitor(res, body, sender);
    } catch (error) {
      if (error instanceof ContentError) return reject(res, error.status, error.message);
      throw error;
    }
  }

  async function sendMember(req, res, headers, authenticateNonce) {
    const body = await readBody(req);
    if (res.destroyed) return;
    const member = await authenticateNonce(body?.nonce);
    if (!member) return sendResult(res, staleRequest(), headers);
    const admin = member.staff === 'owner' || member.staff === 'admin';
    const subject = admin ? undefined : distinctSubject('account', member.id);
    return publishSignedIn(res, body, headers, { nickname: member.nickname, avatar: member.avatar, staff: member.staff, admin, subject, deviceSubject: member.deviceSubject, member: true, sponsor: member.sponsor === true });
  }

  async function sendAdmin(req, res, headers, consumeNonce) {
    const body = await readBody(req);
    if (res.destroyed) return;
    if (!consumeNonce(body?.nonce)) return sendResult(res, staleRequest(), headers);
    return publishSignedIn(res, body, headers, { nickname: body.nickname, admin: true });
  }

  function publishSignedIn(res, body, headers, { nickname: rawNickname, avatar, staff, admin, subject, deviceSubject, member, sponsor = false }) {
    const time = now();
    if (!isActive(time)) return sendResult(res, closedResult(), headers);
    if (subject) {
      const mute = sendMuteStatus(subject);
      if (mute.muted) return reject(res, 403, MUTED, headers, { code: 'muted', expiresAt: mute.expiresAt, ...(mute.source && { source: mute.source }) });
    }
    const text = submissionText(body);
    const groupTag = submissionGroupTag(body);
    const nickname = cleanDanmakuNickname(rawNickname);
    if (nickname === null || (nickname && words.matches(nickname))) return sendResult(res, nicknameRejected(), headers);
    if (words.matches(text)) return sendResult(res, { status: 422, error: BLOCKED }, headers);
    const staffColors = STAFF_COLORS.get(staff);
    const requestedColor = body.color;
    const unlocked = DANMAKU_COLORS.has(requestedColor) || requestedColor === 'default' ||
      (staffColors && (staff === 'owner' ? staffColors.includes(requestedColor) : requestedColor === staffColors[0])) ||
      (sponsor && SPONSOR_COLORS.has(requestedColor));
    const color = unlocked ? requestedColor : staffColors?.[0] ?? (sponsor ? 'gold' : undefined);
    const deviceMute = deviceSubject ? sendMuteStatus(deviceSubject) : null;
    if (deviceMute?.muted) return reject(res, 403, MUTED, headers, { code: 'muted', expiresAt: deviceMute.expiresAt, ...(deviceMute.source && { source: deviceMute.source }) });
    const message = publishText(text, time, subject, { nickname, color, admin, staff, member, sponsor: member && sponsor, avatar: addPublicAvatar(avatar), deviceSubject, groupTag });
    return sendResult(res, { status: 201, message }, headers);
  }

  function requireOfflineModeration() {
    if (!fallbackHistory || !relay.isOffline()) throw new ContentError(503, '镜像离线弹幕管理未启用');
  }

  async function awaitOfflineModeration() {
    if (fallbackHistory) await relay.waitForAvailability();
    requireOfflineModeration();
  }

  async function listOfflineMessages() {
    await awaitOfflineModeration();
    return fallbackHistory.list({ limit: 30 }).records.map(({ message: { id, text, createdAt } }) => ({ id, text, createdAt }));
  }

  async function removeOfflineMessage(messageId) {
    await awaitOfflineModeration();
    if (typeof messageId !== 'string' || !UUID.test(messageId)) throw new ContentError(400, '弹幕编号有误');
    return enqueueOfflineWrite(async () => {
      requireOfflineModeration();
      if (!fallbackHistory.getForModeration(messageId)) throw new ContentError(404, '未找到这条镜像离线弹幕');
      await fallbackHistory.remove([messageId]);
      removeMessages([messageId]);
      return { messageId };
    });
  }

  async function muteOfflineMessage(messageId, duration = '30m') {
    await awaitOfflineModeration();
    if (typeof messageId !== 'string' || !UUID.test(messageId)) throw new ContentError(400, '弹幕编号有误');
    const length = parseMuteDuration(duration);
    if (!Number.isFinite(length) || length <= 0 || length > 86_400_000) {
      throw new ContentError(400, '请选择不超过 24 小时的禁言时长');
    }
    return enqueueOfflineWrite(async () => {
      requireOfflineModeration();
      const record = fallbackHistory.getForModeration(messageId);
      if (!record) throw new ContentError(404, '未找到这条镜像离线弹幕');
      const { deviceSubject, message } = record;
      if (!deviceSubject) throw new ContentError(409, '访客尚无设备标识，无法单独禁言');
      const mute = mutes.get(deviceSubject) ?? await mutes.mute(deviceSubject, duration, message);
      broadcastMute(deviceSubject, { muted: true, expiresAt: mute.expiresAt });
      await fallbackHistory.remove([messageId]);
      removeMessages([messageId]);
      return { messageId, expiresAt: mute.expiresAt };
    });
  }

  async function muteMessage(messageId, duration) {
    pruneHistory(now());
    if (typeof messageId !== 'string' || !UUID.test(messageId)) throw new ContentError(404, '这条弹幕已过期或已下架');
    let target = history.get(messageId) ?? archive.get(messageId);
    if (!target && moderationHistory) {
      await moderationHistory.flush();
      target = moderationHistory.getForModeration(messageId);
    }
    if (!target) throw new ContentError(404, '这条弹幕已过期或已下架');
    if (target.message.admin || target.message.kind === 'moderation' || !target.subject) throw new ContentError(403, '这条弹幕无法封禁');
    if (!target.message.member && !target.deviceSubject) throw new ContentError(403, '访客尚无设备标识，无法单独封禁；请先让其打开网站');
    const subjects = [...new Set([target.subject, target.deviceSubject].filter(Boolean))];
    const mute = await mutes.muteMany(subjects, duration, target.message);
    const blockedSubjects = new Set(subjects);
    const ids = new Set([messageId]);
    for (const records of [history, archive]) {
      for (const [id, entry] of records) if (blockedSubjects.has(entry.subject) || (entry.deviceSubject && blockedSubjects.has(entry.deviceSubject))) ids.add(id);
    }
    removeMessages([...ids]);
    for (const subject of subjects) notify(subject, { muted: true, expiresAt: mute.expiresAt });
    publishModeration(mute.message?.text, banNotice(mute.duration));
    return mute;
  }

  async function liftMute(id) {
    const original = mutes.list().find(mute => mute.id === id)?.message?.text;
    const subjects = await mutes.lift(id);
    for (const subject of subjects) notify(subject, sendMuteStatus(subject));
    publishModeration(original, UNBAN);
  }

  function start() {
    settings?.start();
    scheduled?.start();
    const journal = moderationHistory ?? fallbackHistory;
    if (journal && !historyCleanup) {
      const prune = () => {
        void journal.purgeExpired().catch(error => {
          console.error('Cannot purge danmaku history:', error.code || error.name);
        });
      };
      prune();
      historyCleanup = setInterval(prune, 60 * 60_000).unref();
    }
  }

  function close() {
    scheduled?.stop();
    settings?.stop();
    clearInterval(heartbeat);
    for (const vote of communityVotes.values()) clearTimeout(vote.timer);
    clearInterval(historyCleanup);
    historyCleanup = undefined;
    const closeHistory = fallbackHistory ? () => offlineWrites.then(() => fallbackHistory.close()) : () => moderationHistory?.close();
    historyClose ??= closeHistory()?.catch(error => {
      console.error('Cannot flush danmaku history:', error.code || error.name);
    });
    relay?.stop();
    for (const res of clients.keys()) res.destroy();
    return historyClose;
  }

  function listMessages() {
    pruneHistory(now());
    return [...history.values()].slice(-100).reverse().map(({ message }) => withLikes(message));
  }

  async function listModerationHistory(cursor) {
    if (!moderationHistory) throw new ContentError(503, '弹幕历史暂时不可用');
    await moderationHistory.flush();
    const page = moderationHistory.list({ cursor, limit: 100 });
    return {
      messages: page.records.map(({ message, ip }) => ({
        ...withLikes(message),
        ...(!message.member && !message.admin && message.kind !== 'moderation' && ip ? { ip } : {}),
      })),
      nextCursor: page.nextCursor, hasMore: page.hasMore, retentionDays: RETENTION_DAYS,
    };
  }

  return {
    handle, start, close, sendAdmin, sendMember, validateNickname, muteMessage, liftMute, listMessages, listModerationHistory, issueBrowserDevice,
    listOfflineMessages, muteOfflineMessage, removeOfflineMessage,
    accountDeviceSubject(req) { const device = browserDevice(req); return device && senderSecret ? distinctSubject('device', device) : undefined; },
    isDeviceMuted(req) { return browserDevices(req).some(device => mutes?.get(distinctSubject('device', device))); },
    async voteAsMember(req, res, headers, accountId, role, clientAddress) {
      try {
        const { subject, quota, deviceSubject } = identify(req, undefined, { clientAddress });
        const accountSubject = distinctSubject('account', accountId);
        return await handleCommunityVote(req, res, { subject, quota, deviceSubject, accountSubject, memberRole: role }, headers);
      } catch (error) {
        if (error instanceof ContentError) return reject(res, error.status, error.message, headers);
        throw error;
      }
    },
    accountMuteStatus(id, req) {
      const subjects = [distinctSubject('account', id), ...(req ? browserDevices(req).map(device => distinctSubject('device', device)) : [])];
      for (const subject of subjects) {
        const manager = muteStatus(subject);
        if (manager.muted) return manager;
      }
      for (const subject of subjects) {
        const community = communityMuteStatus(subject);
        if (community.muted) return community;
      }
      return { muted: false, expiresAt: null };
    },
    isManagementAccountMuted: id => Boolean(mutes?.get(distinctSubject('account', id))),
    readScheduled: scheduled?.read,
    writeScheduled: scheduled?.write,
    readSettings: settings?.read,
    changeSettings: settings?.write,
    listMutes: relay ? undefined : mutes?.list,
    listWords: relay ? undefined : words?.list,
    changeWord: relay ? undefined : words?.change,
  };
}

module.exports = { SEND_PATH, STREAM_PATH, RECENT_PATH, HISTORY_PATH, CONFIG_PATH, STATUS_PATH, LIKE_PATH, NONCE_PATH, COMMUNITY_VOTES_PATH, AVATAR_PATH, createDanmaku };
