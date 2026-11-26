(() => {
  'use strict';

  const t = (key, fallback, params) => window.SiteI18n?.t(key, fallback, params) ??
    (params ? fallback.replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token) : fallback);

  const board = document.getElementById('trafficBoard');
  const onlineCount = document.getElementById('onlineCount');
  const compactCount = document.getElementById('onlineCompactCount');
  const summary = board?.querySelector('summary');
  const totalVisitCount = document.getElementById('totalVisitCount');
  if (!board || !onlineCount || !compactCount || !totalVisitCount) return;

  const heartbeatMs = 30_000;
  const timeoutMs = 10_000;
  const formatNumber = new Intl.NumberFormat(window.SiteI18n?.locale || document.documentElement.lang || undefined);
  const status = document.createElement('span');
  status.className = 'traffic-status';
  board.querySelector('.traffic-head')?.append(status);
  const statusLabels = {
    loading: t('widgets.traffic.loading', '连接中'),
    offline: t('widgets.traffic.offline', '离线'),
    stale: t('widgets.traffic.stale', '未能更新'),
    unavailable: t('widgets.traffic.unavailable', '暂不可用'),
  };

  function setState(state, title, detail) {
    board.dataset.state = state;
    board.title = title;
    const label = statusLabels[state] || detail || '';
    if (status.textContent !== label) status.textContent = label;
    status.hidden = !label;
  }

  function createPageId() {
    const crypto = window.crypto;
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    if (typeof crypto?.getRandomValues !== 'function') return null;

    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  let pageId;
  try {
    pageId = createPageId();
  } catch { /* No insecure ID fallback. */ }
  if (!pageId) {
    setState('unavailable', t('widgets.traffic.unsupported', '此浏览器无法获取访问统计。'));
    return;
  }

  let visitPending = true;
  let inFlight = false;
  let refreshQueued = false;
  let heartbeat;
  let stream;
  let streamRetry;
  let streamRevision = 0;

  function updateStats(data) {
    const { online, totalVisits, windowSeconds, scope, peerFresh } = data ?? {};
    if (!Number.isSafeInteger(online) || online < 0 ||
        !Number.isSafeInteger(totalVisits) || totalVisits < 0 ||
        !Number.isFinite(windowSeconds) || windowSeconds <= 0) throw new Error('Invalid traffic response');

    const onlineText = formatNumber.format(online);
    const totalText = formatNumber.format(totalVisits);
    if (onlineCount.textContent !== onlineText) {
      onlineCount.textContent = onlineText;
      compactCount.textContent = onlineText;
    }
    if (totalVisitCount.textContent !== totalText) totalVisitCount.textContent = totalText;
    if (navigator.onLine === false) {
      markOffline();
    } else {
      const combined = scope === 'combined';
      board.dataset.scope = combined ? 'combined' : 'local';
      setState(combined && !peerFresh ? 'partial' : 'live',
        t('widgets.traffic.onlineEstimate', '按最近 {seconds} 秒的访问活动估算在线人数。', { seconds: formatNumber.format(windowSeconds) }),
        combined ? (peerFresh ? t('widgets.traffic.combined', '两站合计') : t('widgets.traffic.syncing', '两站同步中')) : '');
    }
  }

  function closeStream() {
    clearTimeout(streamRetry);
    streamRetry = undefined;
    stream?.close();
    stream = undefined;
  }

  function syncStream() {
    if (document.hidden || navigator.onLine === false) {
      closeStream();
      return;
    }
    if (typeof EventSource !== 'function' || stream || streamRetry) return;
    const connection = new EventSource('/api/traffic/events');
    stream = connection;
    connection.onmessage = event => {
      if (stream !== connection) return;
      try {
        updateStats(JSON.parse(event.data));
        streamRevision++;
      } catch { /* The existing heartbeat can still refresh the panel. */ }
    };
    connection.onerror = () => {
      if (stream !== connection || connection.readyState !== EventSource.CLOSED) return;
      closeStream();
      streamRetry = setTimeout(() => {
        streamRetry = undefined;
        syncStream();
      }, 20_000);
    };
  }

  function markOffline() {
    setState('offline', visitPending ? t('widgets.traffic.offlinePending', '网络已断开，联网后更新。') : t('widgets.traffic.offlineCached', '网络已断开，当前显示上次统计。'));
  }

  async function refresh() {
    clearTimeout(heartbeat);
    if (navigator.onLine === false) {
      markOffline();
      return;
    }
    if (document.hidden) return;
    if (inFlight) {
      refreshQueued = true;
      return;
    }

    inFlight = true;
    if (board.dataset.state === 'offline') setState('loading', t('widgets.traffic.refreshing', '正在更新访问统计。'));
    const startedAtRevision = streamRevision;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('/api/traffic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ pageId, visit: visitPending }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Traffic request failed');

      const payload = await response.json();
      if (startedAtRevision === streamRevision) updateStats({
        ...payload,
        scope: response.headers.get('X-Traffic-Scope'),
        peerFresh: response.headers.get('X-Traffic-Peer-State') === 'live',
      });
      visitPending = false;
    } catch {
      if (navigator.onLine === false) markOffline();
      else if (startedAtRevision !== streamRevision) { /* A newer push already updated the panel. */ }
      else if (visitPending) setState('unavailable', t('widgets.traffic.loadFailed', '暂时无法获取访问统计，稍后重试。'));
      else setState('stale', t('widgets.traffic.updateFailed', '暂时无法更新，当前显示上次统计。'));
    } finally {
      clearTimeout(timeout);
      inFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        refresh();
      } else if (!document.hidden && navigator.onLine !== false) {
        heartbeat = setTimeout(refresh, heartbeatMs);
      }
    }
  }

  document.addEventListener('pointerdown', event => {
    if (board.open && !board.contains(event.target)) board.open = false;
  });
  board.addEventListener('keydown', event => {
    if (board.open && event.key === 'Escape') {
      board.open = false;
      summary?.focus({ preventScroll: true });
    }
  });
  setState('loading', t('widgets.traffic.fetching', '正在获取访问统计。'));
  function onConnectionChange() {
    syncStream();
    refresh();
  }
  document.addEventListener('visibilitychange', onConnectionChange);
  window.addEventListener('online', onConnectionChange);
  window.addEventListener('offline', onConnectionChange);
  window.addEventListener('pagehide', closeStream);
  window.addEventListener('pageshow', syncStream);
  onConnectionChange();
})();
