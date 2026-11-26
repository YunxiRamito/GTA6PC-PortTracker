(() => {
  'use strict';

  const t = (key, fallback, params) => window.SiteI18n?.t(key, fallback, params) ??
    (params ? fallback.replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token) : fallback);

  const board = document.getElementById('trafficBoard');
  const note = board?.querySelector('.traffic-history-note');
  const plots = Array.from(board?.querySelectorAll('canvas[data-traffic-series]') || []);
  if (!note || plots.length !== 2) return;

  const windowSeconds = 6 * 60 * 60;
  const refreshMs = 120_000;
  const formatNumber = new Intl.NumberFormat(window.SiteI18n?.locale || document.documentElement.lang || undefined);
  let history;
  let loadedAt = -Infinity;
  let pending = false;
  let timer;

  function setNote(text) {
    if (note.textContent !== text) note.textContent = text;
    note.hidden = !text;
  }

  function parseHistory(data) {
    const { windowSeconds: duration, sampleSeconds, asOf, points } = data ?? {};
    if (duration !== windowSeconds || !Number.isFinite(sampleSeconds) || sampleSeconds <= 0 ||
        !Number.isSafeInteger(asOf) || !Array.isArray(points) || points.length > 361) {
      throw new Error('Invalid trend response');
    }
    const from = asOf - duration * 1000;
    const sampleMs = sampleSeconds * 1000;
    const segments = [];
    let previous;
    for (const point of points) {
      if (!point || !Number.isSafeInteger(point.time) || point.time < from || point.time > asOf ||
          (previous && point.time <= previous.time) ||
          !Number.isSafeInteger(point.online) || point.online < 0 ||
          !Number.isSafeInteger(point.totalVisits) || point.totalVisits < 0) {
        throw new Error('Invalid trend sample');
      }
      if (!previous || point.time - previous.time > sampleMs * 1.6) segments.push([]);
      segments.at(-1).push(point);
      previous = point;
    }
    return { from, sampleMs, points, segments };
  }

  function drawPlot(canvas) {
    const { width, height } = canvas.getBoundingClientRect();
    if (width <= 8 || height <= 8) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const scale = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const points = history?.points || [];
    canvas.toggleAttribute('data-ready', points.length > 0);
    if (!points.length) return;

    const name = canvas.dataset.trafficSeries;
    const values = points.map(point => point[name]);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const span = Math.max(high - low, 4);
    const offset = (span - (high - low)) / 2;
    const inset = 3;
    const baseline = height - inset;
    const style = getComputedStyle(canvas);
    const color = style.getPropertyValue('--traffic-line').trim();
    const area = ctx.createLinearGradient(0, inset, 0, baseline);
    area.addColorStop(0, style.getPropertyValue('--traffic-fill').trim());
    area.addColorStop(1, 'transparent');
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.45;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const segment of history.segments) {
      const coords = segment.map(point => ({
        x: inset + (point.time - history.from) / (windowSeconds * 1000) * (width - 2 * inset),
        y: baseline - (point[name] - low + offset) / span * (height - 2 * inset),
      }));
      const first = coords[0];
      const last = coords.at(-1);
      if (coords.length > 1) {
        const line = new Path2D();
        line.moveTo(first.x, first.y);
        for (let i = 1; i < coords.length; i++) {
          const previous = coords[i - 1];
          const current = coords[i];
          const middle = (previous.x + current.x) / 2;
          // Ease each segment without going past either sample's value.
          line.bezierCurveTo(middle, previous.y, middle, current.y, current.x, current.y);
        }
        const fill = new Path2D(line);
        fill.lineTo(last.x, baseline);
        fill.lineTo(first.x, baseline);
        fill.closePath();
        ctx.fillStyle = area;
        ctx.fill(fill);
        ctx.stroke(line);
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 1.65, 0, Math.PI * 2);
      ctx.fill();
    }

    const label = name === 'online' ? t('widgets.trafficHistory.online', '在线人数') : t('widgets.trafficHistory.visits', '总访问量');
    const latest = formatNumber.format(values.at(-1));
    const range = high === low ? '' :
      t('widgets.trafficHistory.range', '，范围 {low} 到 {high}', { low: formatNumber.format(low), high: formatNumber.format(high) });
    canvas.setAttribute('aria-label', t('widgets.trafficHistory.chart', '最近 {hours} 小时{label}趋势，最近记录 {latest}{range}', {
      hours: windowSeconds / 3600, label, latest, range,
    }));
  }

  function draw() {
    if (board.open) plots.forEach(drawPlot);
  }

  function showCoverage() {
    const points = history.points;
    if (points.length < 2) setNote(t('widgets.trafficHistory.collecting', '数据积累中'));
    else setNote(points[0].time - history.from > history.sampleMs * 1.6 ? t('widgets.trafficHistory.coverage', '已显示目前记录') : '');
  }

  async function refresh() {
    clearTimeout(timer);
    if (!board.open || document.hidden) return;
    if (navigator.onLine === false) {
      setNote(history ? t('widgets.trafficHistory.offlineCached', '离线 · 显示上次记录') : t('widgets.trafficHistory.offlineUnavailable', '离线 · 趋势暂不可用'));
      return;
    }
    if (pending) return;
    const untilRefresh = refreshMs - (performance.now() - loadedAt);
    if (history && untilRefresh > 0) {
      showCoverage();
      timer = setTimeout(refresh, untilRefresh);
      return;
    }

    pending = true;
    if (!history) setNote(t('widgets.trafficHistory.loading', '正在读取趋势…'));
    try {
      const response = await fetch('/api/traffic/history', {
        cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error('Trend request failed');
      history = parseHistory(await response.json());
      loadedAt = performance.now();
      draw();
      showCoverage();
    } catch {
      setNote(history ? t('widgets.trafficHistory.updateFailed', '暂时未能更新趋势') : t('widgets.trafficHistory.unavailable', '趋势暂不可用'));
    } finally {
      pending = false;
      if (board.open && !document.hidden && navigator.onLine !== false) timer = setTimeout(refresh, refreshMs);
    }
  }

  const resize = new ResizeObserver(draw);
  plots.forEach(plot => resize.observe(plot));
  board.addEventListener('toggle', () => {
    draw();
    void refresh();
  });
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('online', refresh);
  window.addEventListener('offline', refresh);
  if (board.open) void refresh();
})();
