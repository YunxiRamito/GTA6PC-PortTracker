function createGameplayProgressRenderer(document, window) {
  'use strict';

  const statuses = new Set(['planned', 'unknown', 'reported', 'completed', 'blocked']);
  const recordStatuses = new Set(['reported', 'completed', 'blocked']);
  const statusLabels = {
    planned: '计划中',
    unknown: '待核实',
    reported: '自述/未独立验证',
    completed: '已核实',
    blocked: '受阻',
  };
  const section = document.getElementById('gameplay-stages');
  const title = document.getElementById('gameplayProgressTitle');
  const defaultTitle = title ? title.textContent : '';
  const note = document.getElementById('gameplayProgressNote');
  const answer = document.getElementById('gameplayProgressAnswer');
  const count = document.getElementById('gameplayProgressCount');
  const board = document.getElementById('gameplayProgressBoard');
  const list = document.getElementById('gameplayProgressList');
  const detail = document.getElementById('gameplayProgressDetail');
  const empty = document.getElementById('gameplayProgressEmpty');
  const detailId = 'gameplayProgressDetail';
  const rows = new Map();
  const buttons = new Map();
  const exiting = new Map();
  const labelPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const validText = (value, maximum) => typeof value === 'string' &&
    value.trim().length > 0 && value.length <= maximum && !value.includes('\0');
  let records = [];
  // undefined follows the default stage, '' keeps the panel collapsed, and an ID keeps the visitor's choice.
  let choice;
  let selectedId = null;
  let detailSignature = null;
  let hasRendered = false;

  function safeHttpsSource(value) {
    if (typeof value === 'string' && /^#[a-z0-9][a-z0-9-]*$/i.test(value)) return new URL(value, document.baseURI);
    if (typeof value !== 'string' || value.length > 2048 ||
        !/^https:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  function sourceLabel(url) {
    const resource = `${url.hostname}${url.pathname}`.replace(/\/$/, '') || url.hostname;
    return resource.length > 76 ? `${resource.slice(0, 75)}…` : resource;
  }

  function setText(element, value) {
    if (!element) return;
    if (element.textContent !== value) element.textContent = value;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function syncVisibility() {
    const hasRecords = rows.size > 0;
    if (board) board.hidden = !hasRecords && list.childElementCount === 0;
    if (empty) empty.hidden = hasRecords;
  }

  function canAnimate() {
    if (document.hidden || typeof window.matchMedia !== 'function') return false;
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function focusList() {
    if (board) board.hidden = false;
    if (list) { list.tabIndex = -1; list.focus({ preventScroll: true }); }
  }

  function focusSection() {
    if (section) section.focus({ preventScroll: true });
    else focusList();
  }

  function orderedButtons() {
    return records.map(record => buttons.get(record.id)).filter(Boolean);
  }

  function moveFocus(event) {
    const order = orderedButtons();
    const index = order.indexOf(event.currentTarget);
    if (index === -1) return;
    const targets = {
      ArrowLeft: order[Math.max(0, index - 1)],
      ArrowRight: order[Math.min(order.length - 1, index + 1)],
      Home: order[0],
      End: order[order.length - 1],
    };
    if (!Object.hasOwn(targets, event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    targets[event.key].focus();
  }

  function createRow(record, index) {
    const row = element('li', `gameplay-progress-item is-${record.status}`);
    row.dataset.milestoneId = record.id;
    row.dataset.signature = record.signature;

    const segment = element('span', 'gameplay-progress-segment');
    segment.setAttribute('aria-hidden', 'true');

    const button = element('button', 'gameplay-progress-node');
    button.type = 'button';
    button.id = `gameplay-stage-${record.id}`;
    button.setAttribute('aria-controls', detailId);
    button.setAttribute('aria-expanded', 'false');
    button.append(
      element('span', 'gameplay-progress-index', String(index + 1).padStart(2, '0')),
      element('span', 'gameplay-progress-label', record.label),
      element('span', 'gameplay-progress-status', statusLabels[record.status]),
    );
    button.addEventListener('click', () => {
      choice = selectedId === record.id ? '' : record.id;
      applySelection(true);
    });
    button.addEventListener('keydown', moveFocus);

    row.append(segment, button);
    buttons.set(record.id, button);
    return row;
  }

  function defaultSelection() {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (recordStatuses.has(records[index].status)) return records[index].id;
    }
    return '';
  }

  function detailBody(record) {
    const body = element('div', `gameplay-progress-detail-body is-${record ? record.status : 'hint'}`);
    if (!record) {
      body.append(element('p', 'gameplay-progress-detail-hint', '点选阶段查看依据'));
      return body;
    }
    const heading = element('p', 'gameplay-progress-detail-stage');
    heading.append(
      element('span', 'gameplay-progress-detail-label', record.label),
      element('span', 'gameplay-progress-detail-status', statusLabels[record.status]),
    );
    body.append(heading);
    body.append(element('p', 'gameplay-progress-evidence', record.evidence || '暂无公开依据。'));
    if (record.testedOn) body.append(element('p', 'gameplay-progress-tested', `测试对象：${record.testedOn}`));
    if (record.verificationWarning) body.append(element('p', 'gameplay-progress-caution', record.verificationWarning));
    if (record.source) {
      const source = element('a', 'gameplay-progress-source');
      const label = sourceLabel(record.source);
      source.href = record.source.href;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.textContent = `来源：${label}`;
      source.title = `在新窗口查看来源：${label}`;
      body.append(source);
    }
    return body;
  }

  function renderDetail(fromUser) {
    const record = records.find(candidate => candidate.id === selectedId);
    const signature = record ? record.id + record.signature : '';
    if (signature === detailSignature) return;
    detailSignature = signature;
    const active = document.activeElement;
    const hadFocus = Boolean(active && active !== detail && detail.contains(active));
    const focusedHref = hadFocus && typeof active.getAttribute === 'function' ? active.getAttribute('href') : null;
    if (hadFocus) focusList();
    if (detail) detail.textContent = '';
    else return;
    const body = detailBody(record);
    if (fromUser || hasRendered) body.classList.add('is-entering');
    detail.append(body);
    detail.classList[record ? 'add' : 'remove']('is-open');
    if (record) detail.setAttribute('aria-labelledby', `gameplay-stage-${record.id}`);
    else detail.removeAttribute('aria-labelledby');
    if (!hadFocus) return;
    const link = body.querySelector('a');
    if (focusedHref && link && link.getAttribute('href') === focusedHref) link.focus({ preventScroll: true });
    else (buttons.get(selectedId) || section || list).focus({ preventScroll: true });
  }

  function applySelection(fromUser) {
    const kept = choice === '' || records.some(record => record.id === choice);
    const wanted = choice !== undefined && kept ? choice : defaultSelection();
    selectedId = records.some(record => record.id === wanted) ? wanted : '';
    for (const [id, button] of buttons) button.setAttribute('aria-expanded', String(id === selectedId));
    renderDetail(fromUser);
  }

  function removeRow(id, row, animation) {
    if (animation && exiting.get(id)?.animation !== animation) return;
    if (animation) exiting.delete(id);
    if (rows.get(id) === row) return;
    row.remove();
    syncVisibility();
  }

  function leaveRow(id, row, sectionWillBeEmpty) {
    const hadFocus = row.contains(document.activeElement);
    if (hadFocus) {
      if (sectionWillBeEmpty) focusSection();
      else focusList();
    }

    if (typeof row.animate !== 'function' || !canAnimate()) {
      removeRow(id, row);
      return;
    }

    let animation;
    row.inert = true;
    row.setAttribute('aria-hidden', 'true');
    row.classList.add('is-leaving');
    try {
      animation = row.animate([
        { opacity: 1, transform: 'translateY(0)' },
        { opacity: 0, transform: 'translateY(-6px)' },
      ], { duration: 180, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    } catch {
      removeRow(id, row);
      return;
    }

    if (!animation?.finished || typeof animation.finished.then !== 'function') {
      removeRow(id, row);
      return;
    }
    exiting.set(id, { row, animation });
    animation.finished.then(
      () => removeRow(id, row, animation),
      () => removeRow(id, row, animation),
    );
  }

  function announceMilestones() {
    if (typeof document.dispatchEvent !== 'function' || typeof window.CustomEvent !== 'function') return;
    const detailValue = records.map(record => ({ id: record.id, label: record.label }));
    // Kept for listeners that attach after the first poll has already rendered.
    window.PortGameplayMilestones = detailValue;
    document.dispatchEvent(new window.CustomEvent('gameplay-milestones', { detail: detailValue }));
  }

  function parse(progress) {
    const milestones = progress && Array.isArray(progress.milestones) ? progress.milestones : [];
    const parsed = [];
    const seen = new Set();
    for (const item of milestones.slice(0, 12)) {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          typeof item.id !== 'string' || item.id.length > 48 || !labelPattern.test(item.id) ||
          !validText(item.label, 24) || !statuses.has(item.status) || seen.has(item.id)) continue;
      seen.add(item.id);

      const evidence = validText(item.evidence, 160) ? item.evidence.trim() : '';
      const source = safeHttpsSource(item.sourceUrl);
      const claimedVerification = item.status === 'completed' || item.status === 'reported';
      const verifiedEvidence = Boolean(evidence && source);
      const status = claimedVerification && !verifiedEvidence ? 'unknown' : item.status;
      let verificationWarning = '';
      if (claimedVerification && !verifiedEvidence) {
        verificationWarning = item.status === 'completed'
          ? '原“已核实”标记缺少有效证据或安全来源，已降级为待核实，不计入核实记录。'
          : '原社区自述缺少有效证据或安全来源，已降级为待核实。';
      }
      const record = {
        id: item.id,
        label: item.label.trim(),
        status,
        evidence,
        testedOn: validText(item.testedOn, 60) ? item.testedOn.trim() : '',
        source,
        verificationWarning,
      };
      record.signature = JSON.stringify([
        record.label, record.status, record.evidence, record.testedOn, source?.href || '', record.verificationWarning,
      ]);
      parsed.push(record);
    }
    return parsed;
  }

  function summarize() {
    const verified = records.filter(record => record.status === 'completed' && record.evidence && record.source);
    const reported = records.filter(record => record.status === 'reported');
    const farthestVerified = verified[verified.length - 1];
    const farthestReported = reported[reported.length - 1];
    setText(answer, farthestVerified ? farthestVerified.label : '尚无核实记录');
    if (!records.length) {
      setText(count, '暂无游戏内进度记录');
      return;
    }
    setText(count, `已核实 ${verified.length} / ${records.length}` +
      (farthestReported ? ` · 最远自述：${farthestReported.label}` : ''));
  }

  function render(progress) {
    records = parse(progress);

    const gameplayTitle = validText(progress?.title, 24) ? progress.title.trim() : '';
    const gameplayNote = validText(progress?.note, 240) ? progress.note.trim() : '';
    setText(title, gameplayTitle || defaultTitle);
    setText(note, gameplayNote);
    if (note) note.hidden = !gameplayNote;
    summarize();

    const nextIds = new Set(records.map(record => record.id));
    for (const [id, row] of rows) {
      if (nextIds.has(id)) continue;
      rows.delete(id);
      buttons.delete(id);
      leaveRow(id, row, nextIds.size === 0);
    }

    const orderedRows = [];
    records.forEach((record, index) => {
      const pendingExit = exiting.get(record.id);
      if (pendingExit) {
        exiting.delete(record.id);
        pendingExit.animation.cancel();
        pendingExit.row.remove();
      }

      let row = rows.get(record.id);
      const signature = `${index}:${record.signature}`;
      if (!row || row.dataset.signature !== signature) {
        const hadFocus = Boolean(row && row.contains(document.activeElement));
        if (hadFocus) focusList();
        const updated = createRow({ ...record, signature }, index);
        if (row) row.replaceWith(updated);
        row = updated;
        rows.set(record.id, row);
        if (hadFocus) buttons.get(record.id).focus({ preventScroll: true });
      }
      orderedRows.push(row);
    });

    const activeElement = document.activeElement;
    const focusedRow = orderedRows.find(row => row.contains(activeElement));
    const changesOrder = orderedRows.some((row, index) => list.children[index] !== row);
    if (focusedRow && changesOrder) focusSection();
    for (let index = 0; index < orderedRows.length; index += 1) {
      const row = orderedRows[index];
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    }
    if (focusedRow && changesOrder && focusedRow.contains(activeElement)) {
      activeElement.focus({ preventScroll: true });
    }

    applySelection(false);
    if (records.length) setText(empty, '');
    else setText(empty, '暂无可显示的游戏内里程碑数据。');
    syncVisibility();
    hasRendered = true;
    announceMilestones();
  }

  render.setError = function setError() {
    setText(answer, '暂时无法读取');
    setText(count, '暂不可用');
    setText(note, '');
    if (note) note.hidden = true;
    setText(empty, '暂时无法读取游戏内进度；请稍后重试。');
    if (empty) empty.hidden = false;
    syncVisibility();
  };

  return render;
}

if (typeof module === 'object' && module.exports) {
  module.exports = createGameplayProgressRenderer;
} else (() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, '0');
  const formatChina = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
  const svgNS = 'http://www.w3.org/2000/svg';
  const countdownPanel = document.querySelector('section.countdown-wrap');
  const countdownMenuLabel = document.querySelector('.menu-chapters a[href="#community-event"] strong');
  const countdownMenuText = countdownMenuLabel?.textContent;
  const rendered = new Map();
  const renderGameplayProgress = createGameplayProgressRenderer(document, window);
  let gameplayProgressStamp;
  let target = NaN;
  let countdownLabel = '';
  let countdownTimer;
  let countdownExit;
  let homeNewsSignature;
  let announcementRows = [];
  let announcementsExpanded = false;
  let busy = false;
  let timer;
  let resolveInitialLayout;
  window.PortInitialLayout = new Promise(resolve => { resolveInitialLayout = resolve; });

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function icon(name, classes = '') {
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', `ui-icon${classes ? ' ' + classes : ''}`);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(svgNS, 'use');
    use.setAttribute('href', `/assets/ui/fluent.svg#${name}`);
    svg.append(use);
    return svg;
  }

  function link(el, value) {
    if (typeof value === 'string' && /^#[a-z0-9][a-z0-9-]*$/i.test(value)) {
      el.href = value;
      el.removeAttribute('target');
      el.removeAttribute('rel');
      return true;
    }
    try {
      const url = new URL(value);
      if (!url.username && !url.password && url.protocol === 'https:') {
        el.href = value;
        if (url.protocol === 'https:') {
          el.target = '_blank';
          el.rel = 'noopener noreferrer';
        }
        return true;
      }
    } catch { /* An invalid link is not made clickable. */ }
    el.removeAttribute('href');
    return false;
  }

  function writeDigits(id, value, animate = false) {
    const el = $(id);
    if (el.textContent === value) return;
    el.textContent = value;
    if (animate) {
      el.classList.remove('tick');
      void el.offsetWidth;
      el.classList.add('tick');
    }
  }

  function tick() {
    if (!Number.isFinite(target)) return;
    const left = Math.max(0, Math.ceil((target - Date.now()) / 1000));
    const label = left ? countdownLabel : '社区所述时间已到 · 不代表已发布';
    if ($('cdLabel').textContent !== label) $('cdLabel').textContent = label;
    $('countdown').classList.toggle('ended', left === 0);
    writeDigits('cdDays', pad(Math.floor(left / 86400)));
    writeDigits('cdHours', pad(Math.floor(left / 3600) % 24));
    writeDigits('cdMins', pad(Math.floor(left / 60) % 60));
    writeDigits('cdSecs', pad(left % 60), left > 0);
  }

  function hideCountdown() {
    if (countdownPanel.hidden || countdownExit) return;
    if (countdownPanel.contains(document.activeElement)) countdownPanel.parentElement.focus({ preventScroll: true });
    countdownPanel.inert = true;
    if (document.hidden || !rendered.has('countdown') || !countdownPanel.classList.contains('is-visible') ||
        !countdownPanel.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      countdownPanel.hidden = true;
      return;
    }
    const exit = countdownPanel.animate({ opacity: [1, 0], transform: ['translateY(0)', 'translateY(8px)'] }, {
      duration: 220, easing: 'cubic-bezier(.22, 1, .36, 1)',
    });
    countdownExit = exit;
    exit.finished.then(() => {
      if (countdownExit !== exit) return;
      countdownPanel.hidden = true;
      countdownExit = undefined;
    }, () => { /* Re-enabling can cancel the exit. */ });
  }

  function renderCountdown(cfg) {
    const enabled = cfg.enabled !== false;
    if (countdownMenuLabel) {
      const label = enabled ? countdownMenuText : '移植进度';
      if (countdownMenuLabel.textContent !== label) countdownMenuLabel.textContent = label;
    }
    if (!enabled) {
      target = NaN;
      clearInterval(countdownTimer);
      countdownTimer = undefined;
      hideCountdown();
      return;
    }
    const date = new Date(cfg.target);
    if (Number.isNaN(+date)) return;
    countdownExit?.cancel();
    countdownExit = undefined;
    countdownPanel.inert = countdownPanel.hidden = false;
    target = +date;
    countdownLabel = cfg.label;
    $('cdTarget').textContent = `${formatChina.format(date)}（北京时间 / UTC+8）`;
    $('cdUtc').textContent = `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    $('cdMeta').hidden = false;
    $('cdSource').textContent = cfg.source;
    $('cdSource').hidden = !cfg.source;
    renderCountdownActions(cfg);
    tick();
    countdownTimer ??= setInterval(tick, 1000);
  }

  function renderCountdownActions(cfg) {
    const actions = $('cdActions');
    const focused = actions.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
    const buttons = Array.isArray(cfg.buttons) ? cfg.buttons.slice(0, 3) : [{ label: '活动来源', url: cfg.officialUrl }];
    const links = [];
    for (const item of buttons) {
      if (typeof item?.label !== 'string' || !item.label.trim()) continue;
      const anchor = node('a', 'cd-official');
      if (!link(anchor, item.url)) continue;
      anchor.append(node('span', '', item.label), icon('arrow-up-right'));
      links.push(anchor);
    }
    actions.replaceChildren(...links);
    actions.hidden = actions.inert = !links.length;
    if (focused) {
      const next = links.find(anchor => anchor.getAttribute('href') === focused);
      (next || countdownPanel.parentElement).focus({ preventScroll: true });
    }
  }

  function renderHome(data) {
    $('homeLatestUpdate').textContent = data.latestUpdate;
    const list = $('homeNewsLinks');
    const items = [];
    const seen = new Set();
    for (const entry of Array.isArray(data.latestNews) ? data.latestNews : []) {
      if (typeof entry?.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id) || seen.has(entry.id)) continue;
      const title = typeof entry.title === 'string' ? entry.title.trim() : '';
      if (!title) continue;
      items.push([`#news-${entry.id}`, title, entry.correction === true]);
      seen.add(entry.id);
      if (items.length === 2) break;
    }
    const signature = JSON.stringify(items);
    if (homeNewsSignature === signature) return;
    homeNewsSignature = signature;
    const focused = list.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
    const links = items.map(([href, title, correction]) => {
      const anchor = node('a', 'poster-news-link');
      anchor.setAttribute('href', href);
      anchor.title = correction ? `更正：${title}` : title;
      if (correction) anchor.classList.add('is-correction');
      anchor.append(node('span', 'poster-news-link-title', anchor.title), icon('arrow-right'));
      return anchor;
    });
    if (links.length) list.replaceChildren(...links);
    list.inert = list.hidden = !links.length;
    if (focused) {
      const next = links.find(anchor => anchor.getAttribute('href') === focused);
      (next || $('homeNewsSummary')).focus({ preventScroll: true });
    }
  }

  const playabilityLabels = new Map([
    ['unplayable', '不能玩'],
    ['unstable', '能进入游戏，运行不稳定'],
    ['playable', '可以畅玩'],
  ]);

  function showPlayability(playability, fallback = '可玩情况待核对。') {
    const label = playabilityLabels.get(playability?.status);
    const summary = typeof playability?.summary === 'string' ? playability.summary.trim() : '';
    // The saved summary is the verdict. The status sets the indicator and supplies a fallback.
    const answer = summary || label;
    const url = playability?.sourceUrl;
    const safeSource = answer && typeof url === 'string' && url.length <= 2048 &&
      /^https:\/\//i.test(url) && !/[\u0000-\u0020\u007f\\]/.test(url) ? url : undefined;
    const copy = $('routePlayabilitySummary');
    const source = $('routePlayabilitySource');
    if (!copy || !source) return;
    const hadFocus = document.activeElement === source;
    $('routePlayability')?.setAttribute('data-status', label ? playability.status : 'neutral');
    if (copy.textContent !== (answer || fallback)) copy.textContent = answer || fallback;
    source.hidden = !link(source, safeSource);
    if (hadFocus && source.hidden) $('port-progress')?.focus({ preventScroll: true });
  }

  function alignInitialPlayabilityAnchor() {
    if (window.location?.hash !== '#port-progress') return;
    const section = $('port-progress');
    const heroContent = section?.closest('.hero-opening-content');
    const nav = document.querySelector('.site-nav');
    if (!heroContent || !nav) return;

    // The centered hero can move after the browser scrolls to the fragment.
    // Correct its position during initial loading until the visitor interacts.
    const listeners = new AbortController();
    let frame = 0;
    const queue = () => {
      if (frame || listeners.signal.aborted) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (window.location.hash !== '#port-progress') return;
        const offset = nav.offsetHeight + 10;
        const top = section.getBoundingClientRect().top;
        if (top < offset - 1 || top >= window.innerHeight) {
          window.scrollTo({ top: window.scrollY + top - offset, behavior: 'instant' });
        }
      });
    };
    const observer = window.ResizeObserver ? new window.ResizeObserver(queue) : null;
    observer?.observe(heroContent);
    observer?.observe(section);
    const stop = () => {
      listeners.abort();
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      window.clearTimeout(deadline);
    };
    const deadline = window.setTimeout(stop, 25_000);
    const options = { passive: true, signal: listeners.signal };
    for (const event of ['hashchange', 'pointerdown', 'wheel', 'touchstart', 'keydown']) {
      window.addEventListener(event, stop, options);
    }
    window.addEventListener('pageshow', queue, options);
    window.PortInitialLayout.then(queue);
  }

  function renderRoadmap({ playability, gameplayProgress } = {}) {
    showPlayability(playability);
    const section = $('gameplay-stages');
    if (!section || !$('gameplayProgressList')) return;
    const stamp = JSON.stringify(gameplayProgress);
    if (stamp === gameplayProgressStamp) return;
    const configured = gameplayProgress !== undefined;
    if (!configured && section.contains(document.activeElement)) $('port-progress')?.focus({ preventScroll: true });
    section.hidden = !configured;
    renderGameplayProgress(gameplayProgress);
    gameplayProgressStamp = stamp;
  }

  function announcementDate(value) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = new Date(value);
    return Number.isNaN(+date) ? '时间未记录' : formatChina.format(date);
  }

  function showAnnouncements() {
    announcementRows.forEach((row, index) => { row.hidden = !announcementsExpanded && index >= 3; });
    const toggle = $('announcementsToggle');
    toggle.hidden = announcementRows.length <= 3;
    toggle.setAttribute('aria-expanded', String(announcementsExpanded));
    $('announcementsToggleLabel').textContent = announcementsExpanded ? '收起公告' : `再看 ${Math.max(0, announcementRows.length - 3)} 条公告`;
  }

  function announcementButton(button) {
    const label = typeof button?.label === 'string' ? button.label.trim() : '';
    const url = button?.url;
    if (!label || typeof url !== 'string' || /[\u0000-\u0020\u007f\\]/.test(url)) return null;
    const internal = /^#.+|^\/(?!\/)/.test(url);
    if (!internal && !/^https?:\/\/[^/?#]/i.test(url)) return null;
    try {
      const destination = new URL(url, location.origin);
      if (destination.username || destination.password || (internal && destination.origin !== location.origin)) return null;
      const anchor = node('a', 'announcement-button');
      anchor.href = url;
      if (!internal && destination.origin !== location.origin) {
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
      }
      const iconName = anchor.target === '_blank' ? 'arrow-up-right' : url === '#downloads' ? 'arrow-down' : 'arrow-right';
      anchor.append(node('span', '', label), icon(iconName));
      return anchor;
    } catch { return null; }
  }

  function renderAnnouncements(data) {
    $('announcementSource').hidden = !link($('announcementSource'), data.source);
    announcementRows = data.items.slice().sort((a, b) => Date.parse(b.datetime) - Date.parse(a.datetime)).map(item => {
      const row = node('li', 'announcement-item');
      const date = node('time', '', announcementDate(item.datetime));
      date.dateTime = item.datetime;
      const copy = node('div');
      copy.append(node('h3', '', item.title), node('p', '', item.summary));
      if (Array.isArray(item.buttons)) {
        const buttons = item.buttons.slice(0, 3).map(announcementButton).filter(Boolean);
        if (buttons.length) {
          const actions = node('div', 'announcement-buttons');
          actions.append(...buttons);
          copy.append(actions);
        }
      }
      row.append(date, copy);
      return row;
    });
    $('announcementsList').replaceChildren(...announcementRows);
    $('announcementNote').textContent = announcementRows.length ? '公告为发布者自述，未独立核实。时间为北京时间。' : '暂无已收录的公告。';
    showAnnouncements();
  }

  function renderDownloads(data) {
    const list = $('downloadList');
    const opened = new Set([...list.querySelectorAll('.download-entry[open]')].map(el => el.dataset.key));
    const active = list.contains(document.activeElement) ? document.activeElement : null;
    const activeKey = active?.closest('.download-entry')?.dataset.key;
    const activeHref = active?.getAttribute('href');
    const items = data.items.map((item, index) => {
      const key = `${index}:${item.title}`;
      const channels = Array.isArray(item.channels) ? item.channels : [{
        label: '查看资源', url: item.url,
      }];
      const channelList = node('ul', 'download-channel-list');
      channelList.setAttribute('aria-label', '下载渠道');
      for (const channel of channels) {
        if (typeof channel?.label !== 'string' || !channel.label.trim()) continue;
        const anchor = node('a', 'download-channel');
        if (!link(anchor, channel.url)) continue;
        anchor.append(node('span', '', channel.label), icon('arrow-down'));
        const row = node('li');
        row.append(anchor);
        channelList.append(row);
      }
      if (!channelList.childElementCount) return null;
      const entry = node('details', 'download-entry');
      entry.dataset.key = key;
      entry.open = opened.has(key);
      const trigger = node('summary', 'download-card');
      const mark = node('span', 'download-card-icon');
      mark.append(icon('arrow-down'));
      const copy = node('span', 'download-card-copy');
      copy.append(node('strong', '', item.title));
      if (item.description) copy.append(node('span', '', item.description));
      copy.append(node('span', 'download-card-action', '选择下载渠道'));
      trigger.append(mark, copy, icon('chevron-down', 'download-card-arrow'));
      entry.append(trigger, channelList);
      return entry;
    }).filter(Boolean);
    list.replaceChildren(...items);
    list.hidden = !items.length;
    if (activeKey) {
      const entry = items.find(item => item.dataset.key === activeKey);
      const channel = activeHref && entry && [...entry.querySelectorAll('.download-channel')].find(anchor => anchor.getAttribute('href') === activeHref);
      (channel || entry?.querySelector('summary') || $('downloads')).focus({ preventScroll: true });
    }
    $('downloadNote').textContent = items.length ? (data.note || '') : (data.note || '暂无示例资源。');
    $('downloadNote').hidden = !$('downloadNote').textContent;
  }

  const renderers = { home: renderHome, countdown: renderCountdown, roadmap: renderRoadmap, announcements: renderAnnouncements, downloads: renderDownloads };
  $('announcementsToggle').addEventListener('click', () => { announcementsExpanded = !announcementsExpanded; showAnnouncements(); });

  // ---- Port progress renderer (homepage total-progress block) ----
  const portScoreApi = window.PortScore;

  function setProgressValue(track, fill, score) {
    if (score === null) {
      track.removeAttribute('aria-valuenow');
      fill.style.removeProperty('--w');
    } else {
      const value = String(score);
      if (track.getAttribute('aria-valuenow') !== value) {
        track.setAttribute('aria-valuenow', value);
        fill.style.setProperty('--w', value + '%');
      }
    }
  }

  function progressMilestones(progress) {
    const labels = progress && progress.labels && typeof progress.labels === 'object' ? progress.labels : {};
    const source = Array.isArray(progress?.milestones) && progress.milestones.length
      ? progress.milestones
      : (Array.isArray(portScoreApi?.MILESTONES) ? portScoreApi.MILESTONES : []);
    const result = [];
    const seen = new Set();
    source.slice(0, 16).forEach((item, index) => {
      const key = typeof item?.key === 'string' ? item.key.trim() : (typeof item?.id === 'string' ? item.id.trim() : '');
      if (!key || seen.has(key)) return;
      const label = typeof item?.label === 'string' && item.label.trim()
        ? item.label.trim()
        : (typeof labels[key] === 'string' && labels[key].trim() ? labels[key].trim() : key);
      const at = Number.isFinite(Number(item?.at)) ? Math.min(100, Math.max(0, Number(item.at)))
        : source.length > 1 ? (index / (source.length - 1)) * 100 : 0;
      seen.add(key);
      result.push({ key, label, at });
    });

    const isRendered = item => /render|渲染/i.test(item.key) || /render|渲染/i.test(item.label);
    if (!result.some(isRendered)) {
      const before = result.find(item => item.key === 'ingame');
      const after = result.find(item => item.key === 'fps30' || /30/.test(item.key));
      if (before && after && after.at > before.at) {
        result.push({ key: 'rendered', label: '完全渲染', at: before.at + (after.at - before.at) / 2 });
        result.sort((a, b) => a.at - b.at);
      }
    }
    return result.length ? result : [{ key: 'groundwork', label: '基础准备', at: 0 }];
  }

  function milestoneByKey(milestones, key) {
    if (!key) return null;
    return milestones.find(item => item.key === key) ||
      milestones.find(item => /render|渲染/i.test(item.key) && /render|渲染/i.test(String(key))) || null;
  }

  function mobileMilestoneKeys(milestones) {
    const keys = new Set();
    if (!milestones.length) return keys;
    keys.add(milestones[0].key);
    keys.add(milestones[milestones.length - 1].key);
    const ingame = milestoneByKey(milestones, 'ingame');
    if (ingame) keys.add(ingame.key);
    return keys;
  }

  function renderHomeProgress(progress, score) {
    const number = $('homeProgressScore');
    const meter = $('homeProgressMeter');
    const fill = $('homeProgressFill');
    const empty = $('homeProgressEmpty');
    const leader = $('homeProgressLeader');
    const project = $('homeProgressProject');
    if (!number || !meter || !fill || !empty || !leader || !project) return;

    const scoreText = score === null ? '—' : score.toFixed(1) + '%';
    if (number.textContent !== scoreText) number.textContent = scoreText;
    setProgressValue(meter, fill, score);
    meter.hidden = score === null;
    empty.hidden = score !== null;

    const projectName = score !== null && typeof progress?.leaderName === 'string' ? progress.leaderName.trim() : '';
    if (score !== null) {
      const basis = projectName ? `总进度取自领先项目 ${projectName} 的移植评分` : '总进度取自领先项目的移植评分';
      meter.title = basis;
      meter.setAttribute('aria-valuetext', `${scoreText}，${basis}`);
    } else {
      meter.removeAttribute('title');
      meter.removeAttribute('aria-valuetext');
    }
    const hadFocus = document.activeElement === project;
    if (project.textContent !== projectName) project.textContent = projectName;
    leader.hidden = !projectName;
    if (hadFocus && leader.hidden) $('homeNewsSummary')?.focus({ preventScroll: true });
  }

  function renderPortProgress(dashboardData) {
    if (!portScoreApi) return;
    const progress = dashboardData?.progress;
    const ranked = Array.isArray(progress?.ranked) ? progress.ranked : [];
    const score = ranked.length && Number.isFinite(progress.score) && progress.score >= 0 && progress.score <= 100
      ? progress.score : null;
    const hasData = score !== null;
    renderHomeProgress(progress, score);

    const ppSection = $('gameplay-progress');
    const ppEmpty = $('portProgressEmpty');
    const ppBarWrap = $('portProgressBarWrap');
    const ppStats = $('portProgressStats');
    const ppHistory = $('portProgressHistory');
    const ppLeader = $('portProgressLeader');
    const ppLeaderLink = $('portProgressLeaderLink');
    const ppScore = $('portProgressScore');
    const ppNum = $('portProgressNum');
    const track = $('portProgressTrack');
    const fill = $('portProgressFill');
    const avatarBox = $('portProgressAvatars');

    if (ppScore) {
      ppScore.hidden = !hasData;
      ppScore.removeAttribute('aria-live');
      ppScore.removeAttribute('aria-atomic');
      ppScore.setAttribute('aria-hidden', 'true');
    }
    const ppTitle = $('portProgressTitle');
    if (ppTitle && ppTitle.textContent !== '项目进度') ppTitle.textContent = '项目进度';
    const ppLeaderLabel = ppLeader?.querySelector('.port-progress-leader-label');
    if (ppLeaderLabel && ppLeaderLabel.textContent !== '领先项目：') ppLeaderLabel.textContent = '领先项目：';
    const ppBootLabel = $('ppStatBoots')?.previousElementSibling;
    if (ppBootLabel && ppBootLabel.textContent !== '已运行程序') ppBootLabel.textContent = '已运行程序';
    if (ppNum && hasData) {
      const scoreText = score.toFixed(1);
      if (ppNum.textContent !== scoreText) ppNum.textContent = scoreText;
    }
    if (ppBarWrap) ppBarWrap.removeAttribute('aria-hidden');
    if (avatarBox) avatarBox.removeAttribute('aria-hidden');
    if (track && fill) {
      track.setAttribute('role', 'progressbar');
      track.removeAttribute('aria-label');
      track.setAttribute('aria-labelledby', 'portProgressTitle');
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      fill.classList.add('progress-motion-fill');
      setProgressValue(track, fill, score);
    }

    if (ppLeader) {
      const hadFocus = document.activeElement === ppLeaderLink;
      ppLeader.hidden = !hasData || !progress.leaderName;
      if (hadFocus && ppLeader.hidden) ppSection?.focus({ preventScroll: true });
    }

    if (!hasData) {
      if (ppEmpty) ppEmpty.hidden = false;
      if (ppBarWrap) ppBarWrap.hidden = true;
      if (ppStats) ppStats.hidden = true;
      if (ppHistory) ppHistory.hidden = true;
      return;
    }
    if (ppEmpty) ppEmpty.hidden = true;

    const milestones = progressMilestones(progress);

    // Leader line
    if (ppLeader && progress.leaderName) {
      if (ppLeaderLink && ppLeaderLink.textContent !== progress.leaderName) ppLeaderLink.textContent = progress.leaderName;
      if (ppLeaderLink) ppLeaderLink.href = progressArchiveHref(dashboardData, progress.leaderId);
      const ms = $('portProgressLeaderMilestone');
      if (ms) ms.textContent = progress.leaderReachedLabel || milestoneByKey(milestones, progress.leaderReached)?.label || '';
    }

    // Stats
    if (ppStats) {
      const setDd = (id, val) => { const el = $(id); if (el) el.textContent = val; };
      const furthestMs = milestoneByKey(milestones, progress.furthestMilestone);
      setDd('ppStatFurthest', furthestMs ? furthestMs.label : '—');
      setDd('ppStatTop3', progress.top3avg != null ? progress.top3avg.toFixed(1) + '%' : '—');
      setDd('ppStatBoots', (progress.bootsCount || 0) + ' / ' + (progress.rankedCount || 0));
      setDd('ppStatTotal', dashboardData?.stats?.total || '—');
      ppStats.hidden = false;
    }

    // Progress bar: fill + ticks + labels
    if (ppBarWrap) {
      ppBarWrap.hidden = false;
      const ticks = $('portProgressTicks');
      const labels = $('portProgressLabels');
      if (ticks) {
        ticks.replaceChildren(...milestones.slice(1).map(m => {
          const tick = node('i');
          tick.style.left = m.at + '%';
          return tick;
        }));
      }
      if (labels) {
        const furthest = milestoneByKey(milestones, progress.furthestMilestone || 'groundwork');
        const furthestIdx = furthest ? milestones.indexOf(furthest) : 0;
        const mobileKeys = mobileMilestoneKeys(milestones);
        labels.replaceChildren(...milestones.map((m, i) => {
          const mark = node('div', (i <= furthestIdx ? 'ppl-item is-reached' : 'ppl-item') + (mobileKeys.has(m.key) ? ' is-mobile-key' : ''));
          mark.style.left = m.at + '%';
          mark.dataset.milestoneKey = m.key;
          mark.append(node('b', 'ppl-percent', m.at + '%'), node('span', 'ppl-dot'), node('span', 'ppl-label', m.label));
          return mark;
        }));
      }

      if (avatarBox) {
        const publicProjects = Array.isArray(dashboardData?.projects) ? dashboardData.projects : [];
        const privateProjects = Array.isArray(dashboardData?.privateRepositories) ? dashboardData.privateRepositories : [];
        renderPortProgressAvatars(avatarBox, ranked, progress.leaderId, publicProjects,
          dashboardData?.communityBuild ? [dashboardData.communityBuild, ...privateProjects] : privateProjects);
      }
    }

    // History chart
    const history = Array.isArray(progress.history) ? progress.history : [];
    if (ppHistory) {
      const pts = history.filter(h => typeof h.leader === 'number');
      if (pts.length >= 2) {
        ppHistory.hidden = false;
        const chart = $('portProgressHistoryChart');
        if (chart) {
          const W = 1000, H = 70;
          const max = Math.max(30, ...pts.map(p => p.leader)) * 1.1;
          const x = i => (i / (pts.length - 1)) * W;
          const y = v => H - (v / max) * (H - 6) - 3;
          const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.leader).toFixed(1)}`).join(' ');
          chart.innerHTML = `<defs><linearGradient id="ppHG" x1="0" x2="1"><stop offset="0" stop-color="#f4a1c0"/><stop offset=".6" stop-color="#ffb4a2"/><stop offset="1" stop-color="#ffd39a"/></linearGradient><linearGradient id="ppHF" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4a1c0" stop-opacity=".22"/><stop offset="1" stop-color="#f4a1c0" stop-opacity="0"/></linearGradient></defs><path d="${d} L${W} ${H} L0 ${H} Z" fill="url(#ppHF)"/><path d="${d}" fill="none" stroke="url(#ppHG)" stroke-width="3" vector-effect="non-scaling-stroke"/>`;
        }
      } else {
        ppHistory.hidden = true;
      }
    }
  }

  function renderPortProgressAvatars(box, ranked, leaderId, publicProjects, privateProjects) {
    const W = box.clientWidth || box.offsetWidth || 600;
    if (!W) return;
    const GAP = W < 420 ? 34 : 48;
    const top6 = ranked.slice(0, 6);
    const allProjects = [...publicProjects, ...privateProjects];
    const projectMap = new Map(allProjects.map(p => [p.id, p]));
    const items = top6.map(r => ({
      r,
      project: projectMap.get(r.id),
      x: (r.score / 100) * W,
    })).filter(it => it.project && (typeof it.project.repo === 'string' && it.project.repo.trim() || it.project.id === 'community-build' || /^private-repo-[a-z0-9-]+$/i.test(String(it.project.id || '')))).sort((a, b) => a.x - b.x);
    // Spread avatars to avoid overlap
    items.forEach((it, i) => { it.a = i ? Math.max(it.x, items[i - 1].a + GAP) : it.x; });
    const shift = items.length ? items.reduce((s, it) => s + (it.x - it.a), 0) / items.length : 0;
    items.forEach((it, i) => {
      it.a += shift;
      it.a = Math.max(18, i ? Math.max(it.a, items[i - 1].a + GAP) : it.a);
    });
    const overflow = items.length ? items[items.length - 1].a - (W - 18) : 0;
    if (overflow > 0) items.forEach(it => { it.a -= overflow; });

    const H = 80;
    const avatarY = H - 68;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.style.cssText = 'position:absolute;inset:0;overflow:visible;pointer-events:none';
    svg.setAttribute('aria-hidden', 'true');
    for (const it of items) {
      const y0 = avatarY + 32;
      const isLead = it.r.id === leaderId;
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', `M${it.a} ${y0} C ${it.a} ${y0 + 18}, ${it.x} ${H - 18}, ${it.x} ${H}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', isLead ? '#f4a1c0' : 'rgba(255,222,215,.22)');
      path.setAttribute('stroke-width', '1.5');
      svg.append(path);
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', String(it.x)); dot.setAttribute('cy', String(H - 1)); dot.setAttribute('r', '3');
      dot.setAttribute('fill', isLead ? '#f4a1c0' : 'rgba(255,222,215,.35)');
      svg.append(dot);
    }
    box.innerHTML = '';
    box.style.cssText = `position:relative;height:${H}px`;
    box.append(svg);
    for (const it of items) {
      const isLead = it.r.id === leaderId;
      const p = it.project;
      const name = p?.title || (p?.repo ? p.repo.split('/').pop() : it.r.id || '?');
      const avatar = document.createElement('button');
      avatar.type = 'button';
      avatar.className = 'pp-pin' + (isLead ? ' is-leader' : '');
      avatar.dataset.pinTarget = p.id === 'community-build' ? 'community-build' : (p.id && /^private-repo-/.test(p.id) ? p.id : p.repo);
      avatar.setAttribute('aria-label', `${name}，移植进度 ${it.r.score.toFixed(1)}%，跳转到工程档案`);
      avatar.style.cssText = `position:absolute;left:${it.a}px;bottom:${H - avatarY - 32}px;transform:translateX(-50%)`;
      avatar.addEventListener('click', () => {
        const handled = p.id === 'community-build'
          ? typeof window.focusCommunityBuild === 'function' && window.focusCommunityBuild()
          : /^private-repo-/.test(String(p.id || ''))
            ? typeof window.focusPrivateRepository === 'function' && window.focusPrivateRepository(p.id)
          : typeof window.focusProjectArchive === 'function' && window.focusProjectArchive(p.repo);
        if (!handled) {
          const anchor = document.getElementById(p.id === 'community-build' || /^private-repo-/.test(String(p.id || '')) ? p.id : projectAnchorId(p.repo));
          anchor?.scrollIntoView({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        }
      });
      const art = document.createElement('span');
      art.className = 'pp-pin-art';
      art.setAttribute('aria-hidden', 'true');
      avatar.append(art);
      if (isLead) {
        const lbl = document.createElement('span');
        lbl.className = 'pp-avatar-label';
        lbl.textContent = name + ' · ' + it.r.score.toFixed(1) + '%';
        avatar.append(lbl);
      }
      const initial = document.createElement('span');
      initial.className = 'pp-avatar-fb';
      initial.setAttribute('aria-hidden', 'true');
      initial.textContent = (name || '?').slice(0, 2);
      art.append(initial);
      box.append(avatar);
    }
  }

  function projectAnchorId(repo) {
    const value = typeof repo === 'string' ? repo.trim().toLowerCase() : '';
    const slug = value.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug ? `project-${slug}` : '';
  }

  function progressArchiveHref(dashboardData, leaderId) {
    if (leaderId === 'community-build') return '#community-build';
    if (typeof leaderId === 'string' && /^private-repo-[a-z0-9-]+$/i.test(leaderId)) return '#' + leaderId;
    const project = Array.isArray(dashboardData?.projects) ? dashboardData.projects.find(item => item?.id === leaderId) : null;
    return project?.repo ? '#' + projectAnchorId(project.repo) : '#dashboard';
  }

  // ---- end port progress renderer ----

  // expose renderPortProgress for app.js to call after dashboard fetch
  window.renderPortProgress = renderPortProgress;

  async function refresh() {
    if (busy || document.hidden) return;
    clearTimeout(timer);
    busy = true;
    try {
      const response = await fetch('/api/content', { cache: 'no-cache', signal: AbortSignal.timeout(9000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { content, updatedAt } = await response.json();
      const updateDate = new Date(updatedAt);
      const stamp = $('siteUpdatedAt');
      if (!Number.isNaN(+updateDate) && stamp.dateTime !== updatedAt) {
        stamp.dateTime = updatedAt;
        stamp.textContent = formatChina.format(updateDate) + '（北京时间）';
      }
      for (const [key, render] of Object.entries(renderers)) {
        const section = key === 'roadmap' ? {
          playability: content.roadmap?.playability, gameplayProgress: content.roadmap?.gameplayProgress,
        } : content[key];
        const stamp = JSON.stringify(section);
        if (stamp === rendered.get(key)) continue;
        render(section);
        rendered.set(key, stamp);
      }
    } catch {
      const errors = {
        home: ['homeLatestUpdate', '暂时无法读取。'], countdown: ['cdLabel', '暂时无法读取倒计时。'],
        announcements: ['announcementNote', '暂时无法读取公告。'], downloads: ['downloadNote', '暂时无法读取下载分区。'],
      };
      for (const [key, [id, message]] of Object.entries(errors)) {
        const node = $(id);
        if (node && !rendered.has(key)) node.textContent = message;
      }
      if (!rendered.has('roadmap')) showPlayability(undefined, '暂时无法读取可玩情况。');
    } finally {
      busy = false;
      resolveInitialLayout?.();
      resolveInitialLayout = undefined;
      timer = setTimeout(refresh, rendered.size ? 60_000 : 10_000);
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); refresh(); } });
  window.addEventListener('online', refresh);
  alignInitialPlayabilityAnchor();
  refresh();
})();
