(() => {
  'use strict';

  const t = (key, fallback, params) => window.SiteI18n?.t(key, fallback, params) ??
    (params ? fallback.replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token) : fallback);
  const locale = window.SiteI18n?.locale || 'zh-CN';

  const MAX_CODE_POINTS = 60;
  const MAX_SEEN_IDS = 500;
  const MAX_PENDING_CHIPS = 12;
  const MAX_CHIP_WAIT_MS = 4500;
  const RISING_MS = 7200;
  const LIKE_GRACE_MS = 3000;
  const FADE_OUT_MS = 1200;
  const STILL_VISIBLE_MS = 5500;
  const MIN_MOBILE_LAYER_HEIGHT = 240;
  const CHIP_EDGE = 8;
  const CHIP_GAP = 10;
  const BURST_GAP = 5;
  const BURST_INTERVAL_MS = 1100;
  const BURST_HOLD_MS = 4000;
  const MODERATION_HOLD_MS = 470;
  const MODERATION_MOVE_PX = 10;
  const ADMIN_API = '/api/admin/danmaku';
  const COMMUNITY_VOTE_API = '/api/danmaku/community-votes';
  const COMMUNITY_COOLDOWN_MS = 5 * 60_000;
  const COMMUNITY_FAILURE_VISIBLE_MS = 1600;
  const COMMUNITY_SUCCESS_VISIBLE_MS = 1800;
  const HISTORY_QUIET_MS = 2500;
  const HISTORY_WINDOW_MS = 5 * 60_000;
  const MAX_HISTORY_QUEUE = 640;
  const DRAWER_LIMIT = 50;
  const DRAWER_REQUEST_TIMEOUT = 6500;
  const DRAWER_RECENT_TIMEOUT = 7500;
  const DRAWER_RETRY_DELAYS = [1200, 3000];
  // The mirror's live relay can be reconnecting even after the primary page is healthy.
  const MIRROR_DRAWER_RETRY_DELAYS = [...DRAWER_RETRY_DELAYS, 5500, 7500];
  const DRAWER_DATE = new Intl.DateTimeFormat(locale, {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const HISTORY_PACE_MS = 450;
  const DISPLAY_KEY = 'port-tracker-danmaku-display';
  const APPEARANCE_KEY = 'port-tracker-danmaku-appearance';
  const MEMBER_COLORS = new Set(['default', 'mint', 'sky', 'rose', 'lemon']);
  const STAFF_COLORS = new Map([
    ['owner', ['owner-red', 'admin-teal', 'moderator-teal', 'hatsune-green', 'gold', 'orange']],
    ['admin', ['admin-teal', 'gold', 'orange']],
    ['moderator', ['moderator-teal', 'orange']],
  ]);
  const SPONSOR_COLORS = new Set(['gold', 'hatsune-green']);
  const RANK_NAMES = new Map([
    ['owner', t('widgets.danmaku.roleOwner', '站长')],
    ['admin', t('widgets.danmaku.roleAdmin', '管理')],
    ['moderator', t('widgets.danmaku.roleModerator', '纪委')],
    ['sponsor', t('widgets.danmaku.roleContributor', '共创')],
  ]);
  const NICKNAME_LIMIT = 12;
  const NICKNAME_LENGTH_MESSAGE = t('widgets.danmaku.nicknameLength', '最多 6 个汉字或 12 个英文字母。');
  const CLOSED_NOTICE = t('widgets.danmaku.closedNotice', '管理员暂时关闭了实时弹幕');
  const LIKES_KEY = 'port-tracker-danmaku-likes-client';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const widget = document.getElementById('danmakuWidget');
  const dock = widget?.parentElement;
  if (!dock || widget.hasAttribute('data-danmaku-ready')) return;
  const manualDisplay = dock.dataset.danmakuMount === 'manual' || document.body.classList.contains('login-body');
  const toggle = document.getElementById('danmakuToggle');
  const toggleText = document.getElementById('danmakuToggleText');
  const composer = document.getElementById('danmakuComposer');
  const options = document.getElementById('danmakuOptions');
  const optionsClose = document.getElementById('danmakuOptionsClose');
  const appearanceForm = document.getElementById('danmakuAppearance');
  const rankTagField = document.getElementById('danmakuRankTagField');
  const rankTagSelect = document.getElementById('danmakuRankTag');
  const rankTagPreview = document.getElementById('danmakuRankPreview');
  const groupTagSelect = document.getElementById('danmakuGroupTag');
  const groupTagPreview = document.getElementById('danmakuGroupPreview');
  const nicknameInput = document.getElementById('danmakuNickname');
  const guestNickname = document.getElementById('danmakuGuestNickname');
  const accountSummary = document.getElementById('danmakuAccountSummary');
  const accountNickname = document.getElementById('danmakuAccountNickname');
  const accountLink = document.getElementById('danmakuAccountLink');
  const siteAccount = manualDisplay ? null : document.getElementById('siteAccount');
  const fixedConsoleLink = siteAccount?.closest('[data-site-topbar="console"]');
  const siteAccountLabel = siteAccount?.querySelector('#siteAccountLabel');
  const siteAccountAvatar = siteAccount?.querySelector('#siteAccountAvatar');
  const memberColors = document.getElementById('danmakuMemberColors');
  const nicknameCount = document.getElementById('danmakuNicknameCount');
  const appearanceStatus = document.getElementById('danmakuAppearanceStatus');
  const specialColorOptions = memberColors?.querySelectorAll('[data-staff-color], [data-sponsor-color]');
  const historyButton = document.getElementById('danmakuHistoryToggle');
  const historyDrawer = document.getElementById('danmakuHistory');
  const historyClose = document.getElementById('danmakuHistoryClose');
  const historyStatus = document.getElementById('danmakuHistoryStatus');
  const historyList = document.getElementById('danmakuHistoryList');
  const form = document.getElementById('danmakuForm');
  const input = document.getElementById('danmakuInput');
  const inputShell = input?.closest('.danmaku-input-shell');
  const inputLogin = document.getElementById('danmakuInputLogin');
  const inputLoginFallback = document.getElementById('danmakuInputLoginFallback');
  const inputAdmin = document.getElementById('danmakuInputAdmin');
  const count = document.getElementById('danmakuCount');
  const sendButton = document.getElementById('danmakuSend');
  const sendLabel = document.getElementById('danmakuSendLabel');
  const status = document.getElementById('danmakuStatus');
  const display = document.getElementById('danmakuDisplay');
  const displayButton = document.getElementById('danmakuDisplayButton');
  const heartSymbol = sendButton?.querySelector('use')?.getAttribute('href')?.replace(/#.*$/, '#heart') || '/assets/ui/fluent.svg#heart';
  const feedState = document.getElementById('danmakuFeedState');
  const layer = document.getElementById('danmakuLayer');
  const guestButton = document.getElementById('danmakuGuest');
  const moderation = document.getElementById('danmakuModeration');
  const moderationTitle = document.getElementById('danmakuModerationTitle');
  const moderationClose = document.getElementById('danmakuModerationClose');
  const moderationActions = document.getElementById('danmakuModerationActions');
  const moderationQuote = document.getElementById('danmakuModerationQuote');
  const moderationStatus = document.getElementById('danmakuModerationStatus');
  const moderationConfirm = document.getElementById('danmakuModerationConfirm');
  const durationButtons = moderationActions?.querySelectorAll('[data-duration]');
  const durationInputs = moderationActions?.querySelectorAll('[data-duration-unit]');
  const notice = document.getElementById('danmakuNotice');
  const availabilityNotice = document.getElementById('danmakuAvailabilityNotice');
  const trafficBoard = document.getElementById('trafficBoard');
  const qqMenu = document.getElementById('qqMenu');
  const siteMenu = document.getElementById('siteMenu');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  if (!dock || !toggle || !toggleText || !composer || !options || !form || !input || !inputShell || !inputLogin || !inputLoginFallback || !inputAdmin || !sendLabel || !layer || !moderationActions || !memberColors) return;
  widget.dataset.danmakuReady = '';

  function createActionMenu() {
    const menu = document.createElement('div');
    menu.className = 'danmaku-message-actions';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('widgets.danmaku.actions', '弹幕操作'));
    menu.hidden = true;
    menu.inert = true;
    const actions = document.createElement('div');
    actions.className = 'danmaku-message-actions-list';
    for (const [name, text, iconName] of [
      ['select', t('widgets.danmaku.select', '选择'), 'document'],
      ['copy', t('widgets.danmaku.copy', '复制'), 'copy'],
      ['community-vote', t('widgets.danmaku.startVote', '发起禁言投票'), 'pause'],
      ['management-ban', t('widgets.danmaku.managementBan', '管理封禁'), 'dismiss'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'danmaku-message-action';
      button.dataset.action = name;
      button.setAttribute('role', 'menuitem');
      const icon = document.createElementNS(SVG_NS, 'svg');
      icon.classList.add('ui-icon');
      icon.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS(SVG_NS, 'use');
      use.setAttribute('href', `/assets/ui/fluent.svg#${iconName}`);
      icon.append(use);
      const label = document.createElement('span');
      label.dataset.actionLabel = '';
      label.textContent = text;
      button.append(icon, label);
      actions.append(button);
    }
    actionMenuStatus = document.createElement('p');
    actionMenuStatus.className = 'danmaku-message-actions-status';
    actionMenuStatus.setAttribute('role', 'status');
    actionMenuStatus.setAttribute('aria-live', 'polite');
    menu.append(actions, actionMenuStatus);
    document.body.append(menu);
    menu.addEventListener('click', event => { void handleActionMenuClick(event); });
    return menu;
  }

  let stream;
  let retryTimer;
  let closeTimer;
  let optionsCloseTimer;
  let historyCloseTimer;
  let historyLoad;
  let historyPhase = 'loading';
  let historyNotice;
  let historyStatusMessage;
  let historyRevision = 0;
  let historyStreamInterrupted = false;
  const historyRows = new Map();
  let nextAvailability;
  let closurePending = false;
  let closureChip;
  let sendController;
  let cooldownTimer;
  let cooldownUntil = 0;
  let localEchoId = 0;
  let reducedTimer;
  let composing = false;
  let suppressImeSubmit = false;
  let viewportFrame;
  let quietReplayTimer;
  let historyPumpTimer;
  let replayController;
  let historyQueue = [];
  let replayActive = false;
  let replayAllowed = false;
  let replayAttempted = false;
  let liveRevision = 0;
  let motionFrame;
  let previousFrame;
  let motionTime = 0;
  let geometry;
  let hoveredChip;
  let moderationHold;
  let blockHeldClick = false;
  let lastArrival = -Infinity;
  let burstUntil = 0;
  let nextDirection = -1;
  const pendingChips = [];
  const visibleChips = new Map();
  const withdrawnIds = new Set();
  let hasSent = false;
  let adminOrigin;
  const adminEndpoint = path => `${adminOrigin === location.origin ? '' : adminOrigin}${ADMIN_API}/${path}`;
  let accountOrigin;
  let member = null;
  let moderator = false;
  let gold = false;
  const isMirror = document.documentElement.hasAttribute('data-site-mirror');
  let mirrorPrimaryUnavailable = document.documentElement.hasAttribute('data-primary-unavailable');
  let loginRequired = false;
  let checkedAdminAt = 0;
  let checkingAdmin;
  let guestMode = false;
  let currentMute = { muted: false, expiresAt: null };
  let muteRevision = 0;
  let muteTimer;
  let checkingMute;
  let noticeTimer;
  let selectedItem;
  let selectedDuration = '';
  let savingMute = false;
  let moderationRevision = 0;
  let moderationReturnFocus;
  let moderationCloseTimer;
  let actionMenu;
  let actionMenuTarget;
  let actionMenuStatus;
  let actionMenuReturnFocus;
  let actionMenuCloseTimer;
  let communityCooldownTimer;
  let communityCooldownUntil = 0;
  const seenIds = new Set();
  const seenOrder = [];
  const ownIds = new Set();
  const reactionCounts = new Map();
  const reacted = new Set();
  const reacting = new Set();
  let reactionClient;
  const communityVotes = new Map();
  const communityVoteRequests = new Map();
  const communityVoteSending = new Set();
  const supportedCommunityVotes = new Set();
  const communityVoteTimers = new Map();
  const communityVoteNoticeTimers = new Map();

  actionMenu = createActionMenu();

  function storageRead(key = DISPLAY_KEY) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function storageWrite(value, key = DISPLAY_KEY) {
    try { localStorage.setItem(key, value); } catch { /* Private browsing may disable storage. */ }
  }

  function nicknameUnits(value) {
    let units = 0;
    for (const character of value) units += character.codePointAt(0) <= 0x7f ? 1 : 2;
    return units;
  }

  function cleanNickname(value) {
    if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) return null;
    const nickname = value.normalize('NFC').trim();
    return nicknameUnits(nickname) <= NICKNAME_LIMIT ? nickname : null;
  }

  function validGroupTag(value) {
    return Number.isInteger(value) && value >= 1 && value <= 8;
  }

  function validRankTag(value) {
    return value === 'none' || RANK_NAMES.has(value);
  }

  function readAppearance() {
    let stored;
    try { stored = JSON.parse(storageRead(APPEARANCE_KEY)); } catch { /* Discard invalid saved values. */ }
    return {
      nickname: cleanNickname(stored?.nickname) ?? '',
      groupTag: validGroupTag(stored?.groupTag) ? stored.groupTag : undefined,
      rankTag: validRankTag(stored?.rankTag) ? stored.rankTag : undefined,
      color: MEMBER_COLORS.has(stored?.color) ? stored.color : 'default',
      sponsorColor: MEMBER_COLORS.has(stored?.sponsorColor) || SPONSOR_COLORS.has(stored?.sponsorColor)
        ? stored.sponsorColor : 'gold',
      staffColors: Object.fromEntries([...STAFF_COLORS].map(([role, colors]) => {
        const value = stored?.staffColors?.[role];
        return [role, MEMBER_COLORS.has(value) || colors.includes(value) || SPONSOR_COLORS.has(value) ? value : colors[0]];
      })),
    };
  }

  let appearance = readAppearance();
  let rankTagDraft;

  display.checked = !manualDisplay && storageRead() !== 'off';
  replayAllowed = performance.getEntriesByType('navigation')[0]?.type === 'reload' && display.checked && !document.hidden;
  replayAttempted = !replayAllowed;
  layer.dataset.reducedMotion = String(reducedMotion.matches);

  function setStatus(message, tone = '') {
    status.textContent = message;
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
  }

  function setFeedState(message) {
    feedState.textContent = nextAvailability === false ? t('widgets.danmaku.closed', '实时弹幕已关闭') : message;
  }

  function setAvailability(active) {
    if (typeof active !== 'boolean' || active === nextAvailability) return;
    const wasClosed = nextAvailability === false;
    nextAvailability = active;
    if (!active || wasClosed) restartDrawerHistory();
    input.readOnly = !active;
    updateInputGate();
    if (active) {
      closurePending = false;
      closureChip?.remove();
      closureChip = undefined;
      availabilityNotice.textContent = '';
      setFeedState(display.checked ? t('widgets.danmaku.connected', '弹幕已连接') : t('widgets.danmaku.displayDisabled', '已关闭显示'));
    } else {
      cancelHistoricalReplay(true);
      clearChips();
      for (const spark of layer.querySelectorAll('.danmaku-like-spark')) spark.remove();
      closeModeration(false);
      setStatus('');
      setFeedState('');
      closurePending = true;
      showClosureNotice();
    }
    updateSend();
  }

  function showClosureNotice() {
    if (!closurePending || !geometry || document.hidden || siteMenu?.open || qqMenu?.open) return;
    closurePending = false;
    if (manualDisplay && !display.checked && composer.inert) return;
    availabilityNotice.textContent = CLOSED_NOTICE;
    if (manualDisplay && !display.checked) return;
    const chip = document.createElement('span');
    chip.className = 'danmaku-system';
    chip.textContent = CLOSED_NOTICE;
    chip.style.right = `${geometry.right}px`;
    chip.style.bottom = `${Math.max(CHIP_EDGE, layer.clientHeight - geometry.baseline)}px`;
    layer.append(chip);
    closureChip = chip;
    const rise = Math.max(0, Math.min(150, geometry.baseline - chip.offsetHeight - CHIP_EDGE));
    const motion = reducedMotion.matches ? 'none' : `translateY(-${rise}px)`;
    const animation = chip.animate([
      { opacity: 0, transform: 'translateY(0)' },
      { opacity: 1, offset: .16 },
      { opacity: 1, offset: .7 },
      { opacity: 0, transform: motion },
    ], { duration: 5800, easing: 'cubic-bezier(.2,.65,.25,1)', fill: 'both' });
    animation.onfinish = () => {
      chip.remove();
      if (closureChip === chip) closureChip = undefined;
    };
  }

  function codePointCount(value) {
    return Array.from(value).length;
  }

  function limitText(value) {
    return Array.from(value).slice(0, MAX_CODE_POINTS).join('');
  }

  function updateCount() {
    const points = codePointCount(input.value);
    count.textContent = `${points} / ${MAX_CODE_POINTS}`;
    count.classList.toggle('is-limit', points >= MAX_CODE_POINTS);
  }

  function updateInputGate() {
    const guestMuted = !mirrorPrimaryUnavailable && currentMute.muted && !signedIn();
    const promptVisible = guestMuted;
    input.disabled = guestMuted;
    inputShell.toggleAttribute('data-guest-muted', guestMuted);
    inputLogin.hidden = mirrorPrimaryUnavailable || !promptVisible || !accountOrigin;
    inputLoginFallback.hidden = mirrorPrimaryUnavailable || !promptVisible || Boolean(accountOrigin);
    if (accountOrigin) inputLogin.href = accountOrigin + '/';
    input.placeholder = guestMuted ? '' : nextAvailability === false ? t('widgets.danmaku.pausedPlaceholder', '实时弹幕已暂停') : t('widgets.danmaku.placeholder', '说点什么…');
  }

  function stopMotion() {
    if (motionFrame !== undefined) cancelAnimationFrame(motionFrame);
    motionFrame = undefined;
    previousFrame = undefined;
    clearTimeout(reducedTimer);
    reducedTimer = undefined;
  }

  function clearChips() {
    stopMotion();
    closeActionMenu(false);
    visibleChips.clear();
    layer.replaceChildren();
    hoveredChip = undefined;
    motionTime = 0;
    pendingChips.length = 0;
    lastArrival = -Infinity;
    burstUntil = 0;
    nextDirection = -1;
  }

  function closeStream() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    stream?.close();
    stream = undefined;
  }

  function cancelHistoricalReplay(clearVisible = false) {
    clearTimeout(quietReplayTimer);
    clearTimeout(historyPumpTimer);
    quietReplayTimer = undefined;
    historyPumpTimer = undefined;
    historyQueue = [];
    if (replayController) {
      replayController.abort();
      replayController = undefined;
    }
    if (clearVisible && replayActive) clearChips();
    replayActive = false;
  }

  function handleLiveItem(item, localOnly = false) {
    if (!localOnly) addDrawerMessage(item);
    if (seenIds.has(item.id) || withdrawnIds.has(item.id)) return;
    liveRevision += 1;
    replayAllowed = false;
    replayAttempted = true;
    cancelHistoricalReplay();
    for (let index = pendingChips.length - 1; index >= 0; index--) {
      if (pendingChips[index].historical) pendingChips.splice(index, 1);
    }
    showOnce(item, localOnly);
  }

  function scheduleHistoricalReplay() {
    if (!replayAllowed || replayAttempted || !canReceive()) return;
    clearTimeout(quietReplayTimer);
    quietReplayTimer = setTimeout(() => {
      quietReplayTimer = undefined;
      void replayRecent();
    }, HISTORY_QUIET_MS);
  }

  async function replayRecent() {
    if (!replayAllowed || replayAttempted || !canReceive()) return;
    replayAttempted = true;
    const revisionAtStart = liveRevision;
    const controller = new AbortController();
    replayController = controller;
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch('/api/danmaku/recent', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (replayController !== controller || controller.signal.aborted || liveRevision !== revisionAtStart ||
          !canReceive() || !Array.isArray(payload?.messages) ||
          payload.messages.length > MAX_HISTORY_QUEUE) return;

      const currentTime = Date.now();
      const cutoff = currentTime - HISTORY_WINDOW_MS;
      const unique = new Map();
      for (const candidate of payload.messages) {
        const item = parseItem(candidate);
        if (!item || seenIds.has(item.id) || withdrawnIds.has(item.id)) continue;
        const createdAt = Date.parse(item.createdAt);
        if (!Number.isFinite(createdAt) || createdAt < cutoff || createdAt > currentTime + 30_000) continue;
        if (!unique.has(item.id)) unique.set(item.id, item);
      }
      historyQueue = [...unique.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      if (historyQueue.length) {
        replayActive = true;
        pumpHistoricalQueue();
      }
    } catch {
      // Replay is best-effort; live delivery stays connected if history is unavailable.
    } finally {
      clearTimeout(timeout);
      if (replayController === controller) replayController = undefined;
    }
  }

  function pumpHistoricalQueue() {
    historyPumpTimer = undefined;
    if (!replayActive) return;
    if (!canReceive()) {
      cancelHistoricalReplay(true);
      return;
    }
    if (pendingChips.length) {
      historyPumpTimer = setTimeout(pumpHistoricalQueue, 180);
      return;
    }

    if (historyQueue.length) showOnce(historyQueue.shift());
    if (historyQueue.length) {
      historyPumpTimer = setTimeout(pumpHistoricalQueue, reducedMotion.matches ? 1000 : HISTORY_PACE_MS);
    }
    finishHistoricalReplay();
  }

  function finishHistoricalReplay() {
    if (!historyQueue.length && !pendingChips.length && !visibleChips.size) replayActive = false;
  }

  function canShowDanmaku() {
    return nextAvailability !== false && !document.hidden && navigator.onLine !== false && !siteMenu?.open && !qqMenu?.open;
  }

  function canReceive() {
    return display.checked && canShowDanmaku();
  }

  function canConnect() {
    // Availability and mute changes still reach visitors who hide other people's messages.
    if (manualDisplay && !display.checked && composer.inert && !hasSent && !currentMute.muted) return false;
    return !document.hidden && navigator.onLine !== false && ((!siteMenu?.open && !qqMenu?.open) || hasSent || currentMute.muted);
  }

  function syncDanmakuAnchor() {
    const anchor = widget.getBoundingClientRect();
    const region = layer.getBoundingClientRect();
    const width = Math.floor(region.width);
    const right = Math.max(CHIP_EDGE, Math.ceil(region.right - dock.getBoundingClientRect().right));
    const baseline = Math.max(0, Math.min(Math.floor(region.height), Math.floor(anchor.top - region.top - CHIP_EDGE)));
    const previous = geometry;
    if (previous?.width === width && previous.right === right && previous.baseline === baseline) return;

    geometry = {
      width, right, baseline,
      maxWidth: Math.min(280, width - right - CHIP_EDGE),
      maxVisible: window.innerWidth < 480 ? 3 : 5,
      maxBurstVisible: window.innerWidth < 480 ? 7 : 11,
    };
    // Keep in-flight bubbles and their progress when the viewport or dock moves.
    if (previous) {
      const shiftX = (width - right) - (previous.width - previous.right);
      const still = reducedMotion.matches;
      for (const flight of visibleChips.values()) {
        flight.x += shiftX;
        if (still) flight.y = Math.max(0, baseline - flight.height);
        paintFlight(flight, still);
      }
    }
    for (const entry of pendingChips) entry.measured = undefined;
    if (closureChip) closureChip.style.bottom = `${Math.max(CHIP_EDGE, layer.clientHeight - baseline)}px`;
    showClosureNotice();
    requestMotion();
    finishHistoricalReplay();
  }

  function connectStream() {
    showClosureNotice();
    if (!canConnect()) {
      closeStream();
      if (!display.checked) setFeedState(t('widgets.danmaku.displayDisabled', '已关闭显示'));
      else if (document.hidden) setFeedState(t('widgets.danmaku.backgroundTab', '切回页面后继续'));
      else if (navigator.onLine === false) setFeedState(t('widgets.danmaku.offline', '网络已断开'));
      else setFeedState(t('widgets.danmaku.paused', '暂时暂停'));
      return;
    }
    if (typeof EventSource !== 'function' || stream || retryTimer) return;

    setFeedState(t('widgets.danmaku.connecting', '正在连接…'));
    const connection = new EventSource('/api/danmaku/events', { withCredentials: true });
    stream = connection;
    connection.onopen = () => {
      if (stream !== connection) return;
      setFeedState(display.checked ? t('widgets.danmaku.connected', '弹幕已连接') : t('widgets.danmaku.displayDisabled', '已关闭显示'));
      if (historyStreamInterrupted) {
        historyStreamInterrupted = false;
        restartDrawerHistory();
      }
      scheduleHistoricalReplay();
      void refreshMute();
    };
    connection.addEventListener('availability', event => {
      if (stream !== connection) return;
      try {
        const { active } = JSON.parse(event.data);
        if (typeof active === 'boolean') {
          setAvailability(active);
        }
      } catch { /* Ignore malformed notices. */ }
    });
    connection.addEventListener('mute', event => {
      if (stream !== connection) return;
      if (signedIn()) void refreshMute();
      else try { setMute(JSON.parse(event.data)); } catch { /* Ignore malformed notices. */ }
    });
    connection.addEventListener('like', event => {
      if (stream !== connection) return;
      try { applyReaction(JSON.parse(event.data)); } catch { /* Ignore malformed counts. */ }
    });
    connection.addEventListener('community-vote', event => {
      if (stream !== connection) return;
      try { applyCommunityVote(JSON.parse(event.data)); } catch { /* Ignore malformed vote states. */ }
    });
    connection.addEventListener('remove', event => {
      if (stream !== connection) return;
      try { forgetRemoved(JSON.parse(event.data).ids); } catch { /* Ignore malformed notices. */ }
      if (signedIn()) void refreshMute();
    });
    connection.onmessage = event => {
      if (stream !== connection) return;
      try {
        const item = parseItem(JSON.parse(event.data));
        if (item?.moderation && signedIn()) void refreshMute();
        if (!item || !canShowDanmaku()) return;
        if (display.checked) handleLiveItem(item);
        else addDrawerMessage(item);
      } catch { /* Ignore malformed events; the next event remains usable. */ }
    };
    connection.onerror = () => {
      if (stream !== connection) return;
      if (!historyStreamInterrupted) {
        historyStreamInterrupted = true;
        restartDrawerHistory();
      }
      if (connection.readyState === EventSource.CLOSED) {
        closeStream();
        setFeedState(t('widgets.danmaku.disconnected', '连接中断，稍后重试'));
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          connectStream();
        }, 6000);
      } else {
        setFeedState(t('widgets.danmaku.reconnecting', '正在重新连接…'));
      }
    };
  }

  function parseItem(value) {
    if (!value || (typeof value.id !== 'string' && typeof value.id !== 'number') || typeof value.text !== 'string') return null;
    const id = String(value.id).trim();
    const isModeration = value.kind === 'moderation';
    const text = (isModeration ? Array.from(value.text).slice(0, 112).join('') : limitText(value.text)).trim();
    if (!id || !text) return null;
    const admin = !isModeration && value.admin === true;
    const staff = !isModeration && STAFF_COLORS.has(value.staff) ? value.staff : admin ? 'admin' : '';
    const member = !isModeration && value.member === true;
    const sponsor = member && value.sponsor === true;
    const anonymous = value.anonymous === true;
    const canDisplayColor = MEMBER_COLORS.has(value.color) || STAFF_COLORS.get(staff)?.includes(value.color)
      || (sponsor && SPONSOR_COLORS.has(value.color));
    return {
      id, text, admin, anonymous,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
      moderation: isModeration,
      groupTag: !isModeration && validGroupTag(value.groupTag) ? value.groupTag : undefined,
      rankTag: member && !anonymous && value.kind === undefined && validRankTag(value.rankTag) ? value.rankTag : undefined,
      nickname: isModeration ? '' : cleanNickname(value.nickname) ?? '',
      color: !isModeration && canDisplayColor ? value.color
        : !isModeration && STAFF_COLORS.has(value.staff) ? STAFF_COLORS.get(staff)[0] : '',
      staff,
      member,
      sponsor,
      avatar: member && typeof value.avatar === 'string' && /^[a-f0-9]{32}$/.test(value.avatar) ? value.avatar : '',
      likes: Number.isSafeInteger(value.likes) && value.likes > 0 ? value.likes : 0,
    };
  }

  function parseCommunityVote(value) {
    if (!value || typeof value.messageId !== 'string' || !/^[\da-f-]{36}$/.test(value.messageId)) return null;
    const { messageId } = value;
    const votes = Number.isSafeInteger(value.votes) && value.votes >= 0 ? value.votes : null;
    const threshold = Number.isSafeInteger(value.threshold) && value.threshold >= 2 ? value.threshold : null;
    const expiresAt = typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)) ? value.expiresAt : null;
    const status = ['pending', 'failed', 'passed'].includes(value.status) ? value.status : '';
    if (!messageId || votes === null || threshold === null || !expiresAt || !status) return null;
    const remainingCooldownSeconds = Number.isSafeInteger(value.remainingCooldownSeconds) && value.remainingCooldownSeconds > 0
      ? value.remainingCooldownSeconds : 0;
    return { messageId, votes, threshold, expiresAt, status, remainingCooldownSeconds };
  }

  function communityVoteRemaining(vote) {
    if (!vote?.expiresAt) return 0;
    return Math.max(0, Math.ceil((Date.parse(vote.expiresAt) - Date.now()) / 1000));
  }

  function createCommunityVoteNode(className = 'danmaku-community-vote') {
    const row = document.createElement('div');
    row.className = className;
    row.hidden = true;
    row.setAttribute('role', 'status');
    const label = document.createElement('span');
    label.dataset.communityVoteLabel = '';
    const count = document.createElement('button');
    count.type = 'button';
    if (className === 'danmaku-community-vote') count.tabIndex = -1;
    count.dataset.communityVoteCount = '';
    row.append(label, count);
    return row;
  }

  function paintCommunityVoteNode(node, item) {
    if (!node || !item) return;
    const vote = communityVotes.get(item.id);
    const label = node.querySelector('[data-community-vote-label]');
    const count = node.querySelector('[data-community-vote-count]');
    const visible = Boolean(vote && ['pending', 'failed', 'passed'].includes(vote.status));
    node.hidden = !visible;
    if (!visible) {
      delete node.dataset.status;
      return;
    }
    node.dataset.status = vote.status;
    count.hidden = vote.status !== 'pending';
    if (vote.status === 'pending') {
      label.textContent = t('widgets.danmaku.voteStarted', '⚠ 已被发起禁言投票');
      const supported = supportedCommunityVotes.has(item.id);
      const sending = communityVoteSending.has(item.id);
      count.textContent = t('widgets.danmaku.voteCount', '{action}（{votes}/{threshold}）', {
        action: supported ? t('widgets.danmaku.voteSupported', '已支持') : sending ? t('widgets.danmaku.voteSending', '提交中') : t('widgets.danmaku.voteHold', '长按支持'),
        votes: vote.votes, threshold: vote.threshold,
      });
      count.disabled = supported || sending || !votable(item) || ownIds.has(item.id) || nextAvailability === false;
    } else if (vote.status === 'failed') {
      label.textContent = t('widgets.danmaku.voteFailedNotice', '社区投票禁言未通过');
      count.textContent = '';
    } else {
      label.textContent = t('widgets.danmaku.votePassedNotice', '社区禁言已生效 · 3 小时');
      count.textContent = '';
    }
  }

  function updateFlightLayout(flight) {
    if (!flight?.chip?.isConnected) return;
    const { chip } = flight;
    const showingVote = Boolean(chip.querySelector('.danmaku-community-vote:not([hidden])'));
    if (Boolean(flight.voteLayout) === showingVote) return;
    flight.voteLayout = showingVote;
    chip.style.width = '';
    chip.style.height = '';
    const { width, height } = chip.getBoundingClientRect();
    if (flight.communityFrozen) {
      flight.communityFrozenX = Math.max(0, Math.min(flight.communityFrozenX, geometry.width - width));
      flight.communityFrozenY = Math.max(0, Math.min(flight.communityFrozenY, geometry.baseline - height));
    }
    flight.width = width;
    flight.height = height;
    chip.style.width = `${width}px`;
    chip.style.height = `${height}px`;
  }

  function freezeCommunityFlight(flight) {
    if (!flight || flight.communityFrozen) return;
    const age = Math.max(0, motionTime - flight.start);
    const progress = Math.min(1, age / flight.duration);
    flight.communityFrozenAge = age;
    flight.communityFrozenX = flight.x + progress * flight.dx;
    flight.communityFrozenY = flight.y + progress * flight.dy;
    flight.communityFrozen = true;
    flight.chip.dataset.communityFrozen = 'true';
    paintFlight(flight);
  }

  function releaseCommunityFlight(flight) {
    if (!flight?.communityFrozen) return;
    flight.start = motionTime - flight.communityFrozenAge;
    delete flight.communityFrozen;
    delete flight.communityFrozenAge;
    delete flight.communityFrozenX;
    delete flight.communityFrozenY;
    delete flight.chip.dataset.communityFrozen;
    paintFlight(flight);
  }

  function syncCommunityFlight(flight) {
    const vote = communityVotes.get(flight?.item?.id);
    if (vote && (vote.status === 'failed' || (vote.status === 'pending' && communityVoteRemaining(vote) > 0))) freezeCommunityFlight(flight);
    else releaseCommunityFlight(flight);
    updateFlightLayout(flight);
    if (flight) paintFlight(flight, reducedMotion.matches);
  }

  function updateCommunityVoteDom(messageId) {
    const flight = visibleChips.get(messageId);
    if (flight) {
      paintCommunityVoteNode(flight.chip.querySelector('.danmaku-community-vote'), flight.item);
      syncCommunityFlight(flight);
    }
    const entry = historyRows.get(messageId);
    if (entry) paintCommunityVoteNode(entry.communityVote, entry.item);
    if (actionMenuTarget?.item.id === messageId) renderActionMenu(actionMenuTarget);
    requestMotion();
  }

  function applyCommunityVote(value) {
    const vote = parseCommunityVote(value);
    if (!vote) return;
    const previous = communityVotes.get(vote.messageId);
    if (previous?.expiresAt === vote.expiresAt && (previous.status !== 'pending' ||
        previous.votes > vote.votes || (previous.status === vote.status && previous.votes === vote.votes))) return;
    communityVotes.set(vote.messageId, vote);
    if (communityVotes.size > MAX_HISTORY_QUEUE) communityVotes.delete(communityVotes.keys().next().value);
    clearTimeout(communityVoteTimers.get(vote.messageId));
    communityVoteTimers.delete(vote.messageId);
    if (vote.status === 'pending') {
      const remaining = communityVoteRemaining(vote);
      if (remaining > 0) {
        communityVoteTimers.set(vote.messageId, setTimeout(async () => {
          communityVoteTimers.delete(vote.messageId);
          await refreshCommunityVote(vote.messageId);
          if (communityVotes.get(vote.messageId) === vote) {
            communityVotes.delete(vote.messageId);
            updateCommunityVoteDom(vote.messageId);
          }
        }, Math.max(0, Date.parse(vote.expiresAt) - Date.now()) + 250));
      }
    } else if (vote.status === 'failed') {
      clearTimeout(communityVoteNoticeTimers.get(vote.messageId));
      communityVoteNoticeTimers.set(vote.messageId, setTimeout(() => {
        communityVoteNoticeTimers.delete(vote.messageId);
        if (communityVotes.get(vote.messageId)?.status !== 'failed') return;
        communityVotes.delete(vote.messageId);
        updateCommunityVoteDom(vote.messageId);
      }, COMMUNITY_FAILURE_VISIBLE_MS));
    }
    if (vote.remainingCooldownSeconds > 0) setCommunityCooldown(vote.remainingCooldownSeconds);
    updateCommunityVoteDom(vote.messageId);
  }

  function communityVoteEndpoint() {
    return member && adminOrigin
      ? { url: adminEndpoint('community-votes'), credentials: 'include' }
      : { url: COMMUNITY_VOTE_API, credentials: 'same-origin' };
  }

  function refreshCommunityVote(messageId) {
    if (communityVoteRequests.has(messageId)) return communityVoteRequests.get(messageId);
    const request = (async () => {
      try {
        const { url, credentials } = communityVoteEndpoint();
        const response = await fetch(`${url}?messageId=${encodeURIComponent(messageId)}`, {
          credentials, cache: 'no-store', headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout?.(4500),
        });
        if (!response.ok) return;
        const payload = await response.json();
        setCommunityCooldown(payload?.remainingCooldownSeconds);
        if (payload?.vote) applyCommunityVote(payload.vote);
        else if (!communityVotes.has(messageId) || communityVotes.get(messageId) === null) {
          communityVotes.set(messageId, null);
          updateCommunityVoteDom(messageId);
        }
      } catch { /* Vote status is best-effort; POST and SSE remain authoritative. */ }
      finally { communityVoteRequests.delete(messageId); }
    })();
    communityVoteRequests.set(messageId, request);
    return request;
  }

  function remember(id) {
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    seenOrder.push(id);
    if (seenOrder.length > MAX_SEEN_IDS) seenIds.delete(seenOrder.shift());
    return true;
  }

  function showOnce(item, localOnly = false) {
    if ((!display.checked && (manualDisplay || !ownIds.has(item.id))) || !canShowDanmaku() || withdrawnIds.has(item.id) || !remember(item.id)) return;
    scheduleChip(item, localOnly);
  }

  function visibleRankTags({ staff, sponsor, rankTag }) {
    if (rankTag === 'none') return [];
    if (rankTag !== undefined) return [rankTag];
    return [staff, sponsor && 'sponsor'].filter(Boolean);
  }

  function createRankBadge(rank) {
    const badge = document.createElement('span');
    badge.className = 'danmaku-rank';
    badge.dataset.rank = rank;
    badge.textContent = RANK_NAMES.get(rank);
    return badge;
  }

  function appendIdentity(line, item) {
    if (item.anonymous) return;
    const nickname = item.nickname || (item.member ? t('widgets.danmaku.anonymousMember', '用户') : item.admin ? t('widgets.danmaku.admin', '管理员') : t('widgets.danmaku.guest', '游客'));
    if (item.member) {
      const avatar = document.createElement('span');
      avatar.className = 'danmaku-message-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = Array.from(nickname)[0];
      if (item.avatar) {
        const image = document.createElement('img');
        image.alt = '';
        image.width = image.height = 18;
        image.decoding = 'async';
        image.hidden = true;
        image.addEventListener('load', () => { image.hidden = false; }, { once: true });
        image.src = `/api/danmaku/avatar/${item.avatar}.png`;
        avatar.append(image);
      }
      line.append(avatar);
    }
    const name = document.createElement('span');
    name.className = 'danmaku-nickname';
    name.textContent = nickname;
    line.append(name);
    line.append(...visibleRankTags(item).map(createRankBadge));
  }

  function paintGroupTag(badge, groupTag) {
    if (validGroupTag(groupTag)) {
      badge.textContent = t('widgets.danmaku.groupNumber', '{group}群', { group: groupTag });
      badge.dataset.groupTag = String(groupTag);
    } else {
      delete badge.dataset.groupTag;
    }
  }

  function appendGroupTag(line, item) {
    if (!validGroupTag(item.groupTag)) return;
    const badge = document.createElement('span');
    badge.className = 'danmaku-group-tag';
    paintGroupTag(badge, item.groupTag);
    line.append(badge);
  }

  function measureChip(item, localOnly) {
    if (geometry.maxWidth < 64 || geometry.baseline < 24) return null;
    const chip = document.createElement('span');
    chip.className = 'danmaku-chip';
    chip.dataset.messageId = item.id;
    if (localOnly) chip.dataset.localOnly = 'true';
    if (item.moderation) chip.dataset.moderation = 'true';
    if (item.admin) chip.dataset.admin = 'true';
    if (item.color) chip.dataset.color = item.color;
    if (!item.moderation) {
      chip.dataset.likeable = 'true';
      const line = document.createElement('span');
      line.className = 'danmaku-message-head';
      appendIdentity(line, item);
      appendGroupTag(line, item);
      const like = document.createElement('span');
      like.className = 'danmaku-like';
      const count = document.createElement('span');
      count.className = 'danmaku-like-count';
      like.append(makeHeart(), count);
      line.append(like);
      chip.append(line);
      paintReaction({ chip, item });
    }
    const message = document.createElement('span');
    message.className = 'danmaku-chip-text';
    message.textContent = item.text;
    chip.append(message);
    if (!item.moderation) {
      const communityVote = createCommunityVoteNode();
      chip.append(communityVote);
      paintCommunityVoteNode(communityVote, item);
    }
    chip.style.maxWidth = geometry.maxWidth + 'px';
    layer.append(chip);
    const { width, height } = chip.getBoundingClientRect();
    chip.remove();
    // Keep the measured border box stable if a web font loads during a flight.
    chip.style.width = width + 'px';
    chip.style.height = height + 'px';
    return { chip, item, width, height };
  }

  function makeFlight(measured, direction, { burst = false, level = 0, maxY = Infinity } = {}) {
    const rightmost = geometry.width - geometry.right - measured.width;
    const fanWidth = Math.max(0, Math.min(220, rightmost - CHIP_EDGE));
    const drift = fanWidth * .13;
    const targetX = direction < 0 ? rightmost - fanWidth : rightmost;
    const baseline = Math.max(0, geometry.baseline - measured.height);
    const lift = level * (measured.height + BURST_GAP);
    if (lift > baseline * .56) return;
    const nominalY = baseline - lift;
    const y = Math.min(nominalY, maxY);
    if (y < 0) return;
    const likeCount = Math.max(measured.item.likes || 0, reactionCounts.get(measured.item.id) || 0);
    const duration = burst ? Math.max(2800, .86 * RISING_MS * nominalY / geometry.baseline)
      : Math.max(3400, RISING_MS * nominalY / geometry.baseline);
    // Starting above a slow bubble shortens this flight without changing its speed.
    const remaining = nominalY > 0 ? y / nominalY : 1;
    return {
      ...measured,
      x: targetX - direction * drift,
      y,
      dx: direction * drift,
      dy: -y,
      start: motionTime,
      fadeInAt: motionTime,
      likeCount,
      burst,
      slow: likeCount > 0,
      duration: Math.max(1, duration * remaining) / reactionSpeed(likeCount),
    };
  }

  function overlapInterval(offset, velocity, size, otherSize, gap) {
    const low = -size - gap;
    const high = otherSize + gap;
    if (Math.abs(velocity) < 1e-9) {
      return offset > low && offset < high ? [-Infinity, Infinity] : null;
    }
    const a = (low - offset) / velocity;
    const b = (high - offset) / velocity;
    return [Math.min(a, b), Math.max(a, b)];
  }

  function pathsCollide(candidate, active) {
    const elapsed = motionTime - active.start;
    const timeTogether = Math.min(candidate.duration, active.duration - elapsed);
    const xv = active.dx / active.duration;
    const yv = active.dy / active.duration;
    const gap = candidate.burst || active.burst ? BURST_GAP : CHIP_GAP;
    const x = overlapInterval(candidate.x - (active.x + xv * elapsed), candidate.dx / candidate.duration - xv, candidate.width, active.width, gap);
    const y = overlapInterval(candidate.y - (active.y + yv * elapsed), candidate.dy / candidate.duration - yv, candidate.height, active.height, gap);
    // Reserve the rectangles for the whole shared flight, including across a mode change.
    return x && y && Math.max(0, x[0], y[0]) < Math.min(timeTogether, x[1], y[1]);
  }

  function paintFlight(flight, still = false) {
    const age = motionTime - flight.start;
    const frozen = flight.communityFrozen;
    const progress = still || frozen ? 0 : age / flight.duration;
    const fade = still || frozen ? 1 : Math.max(0, Math.min(1, (motionTime - flight.fadeInAt) / 260, (flight.duration - age) / FADE_OUT_MS));
    const x = frozen ? flight.communityFrozenX : flight.x + progress * flight.dx;
    const y = frozen ? flight.communityFrozenY : flight.y + progress * flight.dy;
    flight.chip.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0)';
    flight.chip.style.opacity = String(fade * fade * (3 - 2 * fade));
  }

  function removeVisibleChip(id) {
    const flight = visibleChips.get(id);
    if (!flight) return;
    if (actionMenuTarget?.item.id === id) closeActionMenu(false);
    visibleChips.delete(id);
    if (hoveredChip === flight.chip) hoveredChip = undefined;
    flight.chip.remove();
  }

  function markOwnItem(item) {
    ownIds.add(item.id);
    if (ownIds.size > MAX_SEEN_IDS) ownIds.delete(ownIds.values().next().value);
    const flight = visibleChips.get(item.id);
    if (flight) flight.chip.dataset.own = 'true';
    if (communityVotes.has(item.id)) updateCommunityVoteDom(item.id);
  }

  function placeFlight(flight, still = false) {
    if (ownIds.has(flight.item.id)) flight.chip.dataset.own = 'true';
    paintFlight(flight, still);
    visibleChips.set(flight.item.id, flight);
    flight.chip.toggleAttribute('data-slow', flight.slow);
    layer.append(flight.chip);
    syncCommunityFlight(flight);
    if (still) {
      flight.stillUntil = performance.now() + STILL_VISIBLE_MS;
      flight.stillProtectedUntil = 0;
    }
    if (!flight.item.moderation) paintReaction(flight);
  }

  function makeHeart() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('ui-icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', heartSymbol);
    svg.append(use);
    return svg;
  }

  function getReactionClient() {
    if (reactionClient) return reactionClient;
    try { reactionClient = localStorage.getItem(LIKES_KEY); } catch { /* Private mode may disable storage. */ }
    if (/^[a-f0-9]{32}$/.test(reactionClient || '')) return reactionClient;
    reactionClient = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(LIKES_KEY, reactionClient); } catch { /* Keep the identifier for this page. */ }
    return reactionClient;
  }

  function paintReaction({ chip, item }) {
    const count = Math.max(item.likes || 0, reactionCounts.get(item.id) || 0);
    chip.querySelector('.danmaku-like-count').textContent = count > 99 ? '99+' : String(count);
    chip.toggleAttribute('data-has-likes', count > 0);
    chip.toggleAttribute('data-liked', reacted.has(item.id));
  }

  function applyReaction({ id, count }) {
    if (typeof id !== 'string' || !Number.isSafeInteger(count) || count < 1 || count > 10_000) return;
    if (count <= (reactionCounts.get(id) || 0)) return;
    reactionCounts.set(id, count);
    if (reactionCounts.size > MAX_SEEN_IDS) reactionCounts.delete(reactionCounts.keys().next().value);
    const entry = historyRows.get(id);
    if (entry) paintDrawerLikes(entry);
    const flight = visibleChips.get(id);
    if (!flight || flight.item.moderation || count <= flight.likeCount) return;
    paintReaction(flight);
    if (reducedMotion.matches) {
      flight.stillProtectedUntil = performance.now() + LIKE_GRACE_MS;
      flight.stillUntil = Math.max(flight.stillUntil, flight.stillProtectedUntil);
    } else {
      slowFlight(flight, count);
    }
    flight.likeCount = count;
    requestMotion();
  }

  function reactionSpeed(count) {
    // Each confirmed like reduces the speed, with diminishing increments in a busy room.
    return .30 + .70 / (1 + .5 * count);
  }

  function retimeFlight(flight, scale) {
    const progress = Math.min(1, (motionTime - flight.start) / flight.duration);
    const remaining = 1 - progress;
    return {
      start: motionTime,
      x: flight.x + progress * flight.dx,
      y: flight.y + progress * flight.dy,
      dx: flight.dx * remaining,
      dy: flight.dy * remaining,
      duration: flight.duration * remaining * scale,
    };
  }

  function slowFlight(flight, count) {
    const remaining = flight.start + flight.duration - motionTime;
    if (remaining <= 0) return;
    const scale = Math.max(reactionSpeed(flight.likeCount) / reactionSpeed(count), (LIKE_GRACE_MS + FADE_OUT_MS) / remaining);
    Object.assign(flight, retimeFlight(flight, scale), { slow: true });
    flight.chip.setAttribute('data-slow', '');
  }
  function burstHearts(chip) {
    const rect = chip.getBoundingClientRect();
    const region = layer.getBoundingClientRect();
    const x = rect.left + rect.width / 2 - region.left;
    const y = rect.top - region.top;
    const reduced = reducedMotion.matches;
    for (const [index, drift] of (reduced ? [0] : [-18, 1, 20]).entries()) {
      const spark = document.createElement('span');
      spark.className = 'danmaku-like-spark';
      spark.style.left = `${x + drift / 3}px`;
      spark.style.top = `${y}px`;
      spark.append(makeHeart());
      layer.append(spark);
      const path = reduced ? 'none' : `translate(${drift}px, -42px) scale(.7)`;
      const animation = spark.animate([
        { opacity: 0, transform: 'scale(.55)' },
        { opacity: 1, offset: .24 },
        { opacity: 0, transform: path },
      ], { duration: 730, delay: reduced ? 0 : index * 45, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' });
      animation.onfinish = () => spark.remove();
    }
  }

  async function likeMessage(item, flight = visibleChips.get(item.id)) {
    const { id } = item;
    if (item.moderation || withdrawnIds.has(id) || reacted.has(id) || reacting.has(id) || nextAvailability === false) return;
    reacting.add(id);
    if (flight) {
      burstHearts(flight.chip);
      if (hoveredChip === flight.chip) hoveredChip = undefined;
      requestMotion();
    }
    try {
      const localOnly = flight?.chip.hasAttribute('data-local-only');
      let result = { id, count: 1 };
      if (!localOnly) {
        const response = await fetch('/api/danmaku/like', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, clientId: getReactionClient() }),
          signal: AbortSignal.timeout?.(4000),
        });
        if (!response.ok) return;
        result = await response.json();
        if (result?.id !== id || !Number.isSafeInteger(result.count) || result.count < 1) return;
      }
      reacted.add(id);
      if (reacted.size > MAX_SEEN_IDS) reacted.delete(reacted.values().next().value);
      if (visibleChips.has(id)) paintReaction(visibleChips.get(id));
      if (historyRows.has(id)) paintDrawerLikes(historyRows.get(id));
      applyReaction(result);
    } catch { /* Leave the reaction available to retry if the network fails. */ }
    finally { reacting.delete(id); }
  }

  function findOpenFlight(measured, burst) {
    const active = [...visibleChips.values()];
    const slowed = active.filter(flight => flight.slow);
    const directions = burst ? [nextDirection, -nextDirection] : [0];
    const fit = (direction, position) => {
      const flight = makeFlight(measured, direction, { burst, ...position });
      if (!flight || active.some(other => pathsCollide(flight, other))) return;
      if (direction) nextDirection = -direction;
      return flight;
    };
    for (const level of (burst ? [0, 1, 2, 3] : [0])) {
      for (const direction of directions) {
        const flight = fit(direction, { level });
        if (flight) return flight;
      }
    }
    if (slowed.length === 0) return;

    // If the normal lane is blocked by a slow bubble, try alongside it before starting higher.
    const alternate = [nextDirection, -nextDirection];
    if (!burst) {
      for (const direction of alternate) {
        const flight = fit(direction, {});
        if (flight) return flight;
      }
    }
    const minStartY = Math.max(36, geometry.baseline * .22);
    const starts = slowed.map(flight => {
      const progress = (motionTime - flight.start) / flight.duration;
      return flight.y + progress * flight.dy - measured.height - CHIP_GAP;
    }).filter(y => y >= minStartY).sort((a, b) => b - a);
    for (const maxY of starts) {
      for (const direction of burst ? alternate : [0, ...alternate]) {
        const flight = fit(direction, { maxY });
        if (flight) return flight;
      }
    }
  }

  function stepMotion(timestamp) {
    motionFrame = undefined;
    if (!canShowDanmaku()) {
      clearChips();
      finishHistoricalReplay();
      return;
    }
    motionTime += timestamp - (previousFrame ?? timestamp);
    previousFrame = timestamp;
    for (const [id, flight] of visibleChips) {
      if (!flight.communityFrozen && motionTime - flight.start >= flight.duration) {
        removeVisibleChip(id);
      } else {
        paintFlight(flight);
      }
    }

    for (let index = pendingChips.length - 1; index >= 0; index--) {
      const entry = pendingChips[index];
      if (withdrawnIds.has(entry.item.id) || (!entry.historical && timestamp - entry.queuedAt > MAX_CHIP_WAIT_MS)) {
        pendingChips.splice(index, 1);
      }
    }
    const burst = pendingChips.length > 1 || timestamp < burstUntil;
    const slowSlots = [...visibleChips.values()].filter(flight => flight.slow).length;
    const capacity = (burst ? geometry.maxBurstVisible : geometry.maxVisible) + Math.min(2, slowSlots);
    const liveFirst = burst && !pendingChips[0]?.historical;
    let measurements = 0;
    for (let index = liveFirst ? pendingChips.length - 1 : 0; index >= 0 && index < pendingChips.length && visibleChips.size < capacity;) {
      const entry = pendingChips[index];
      if (entry.measured === undefined) {
        if (measurements >= 4) break;
        measurements++;
        entry.measured = measureChip(entry.item, entry.localOnly);
      }
      const flight = entry.measured && findOpenFlight(entry.measured, burst);
      if (flight) placeFlight(flight);
      if (flight || !entry.measured) pendingChips.splice(index, 1);
      else if (!liveFirst) break;
      if (liveFirst) index--;
    }
    finishHistoricalReplay();
    requestMotion();
  }

  function requestMotion() {
    // Pausing only the hovered chip lets trailing bubbles fly into it.
    if (hoveredChip || moderationHold?.live || layer.hasAttribute('data-paused')) {
      stopMotion();
      return;
    }
    if (!pendingChips.length && !visibleChips.size) {
      previousFrame = undefined;
      return;
    }
    if (!reducedMotion.matches) {
      if (motionFrame === undefined) motionFrame = requestAnimationFrame(stepMotion);
      return;
    }

    clearTimeout(reducedTimer);
    reducedTimer = undefined;
    let current = visibleChips.values().next().value;
    const now = performance.now();
    if (current?.communityFrozen) return;
    if (current && now >= current.stillUntil) {
      removeVisibleChip(current.item.id);
      current = undefined;
    }
    if (pendingChips.length && (current?.stillProtectedUntil ?? 0) <= now) {
      const entry = pendingChips.pop();
      pendingChips.length = 0;
      if (!withdrawnIds.has(entry.item.id) && canShowDanmaku()) {
        const measured = measureChip(entry.item, entry.localOnly);
        if (measured) {
          if (current) removeVisibleChip(current.item.id);
          current = makeFlight(measured, 0);
          placeFlight(current, true);
        }
      }
    }
    if (current) {
      const wakeAt = pendingChips.length ? Math.min(current.stillProtectedUntil, current.stillUntil) : current.stillUntil;
      reducedTimer = setTimeout(requestMotion, Math.max(8, wakeAt - performance.now()));
    }
    finishHistoricalReplay();
  }

  function scheduleChip(item, localOnly) {
    const queuedAt = performance.now();
    if (queuedAt - lastArrival < BURST_INTERVAL_MS || pendingChips.length) burstUntil = queuedAt + BURST_HOLD_MS;
    lastArrival = queuedAt;
    if (pendingChips.length >= MAX_PENDING_CHIPS) pendingChips.shift();
    pendingChips.push({ item, localOnly, queuedAt, historical: replayActive });
    requestMotion();
  }

  function syncComposerViewport() {
    cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(() => {
      const viewport = window.visualViewport;
      const unzoomedViewport = viewport && viewport.scale === 1;
      const offset = unzoomedViewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
      const visibleHeight = unzoomedViewport ? viewport.height : window.innerHeight;
      const visibleTop = unzoomedViewport ? viewport.offsetTop : 0;
      dock.style.setProperty('--danmaku-visual-height', `${Math.round(visibleHeight)}px`);
      dock.style.setProperty('--danmaku-keyboard-offset', `${Math.round(offset)}px`);
      const half = visibleHeight / 2;
      const upperInset = Math.min(half, Math.max(0, visibleHeight - MIN_MOBILE_LAYER_HEIGHT));
      layer.style.top = offset > 0 || upperInset < half ? `${Math.round(visibleTop + upperInset)}px` : '';
      syncDanmakuAnchor();
    });
  }

  function historyIsOpen() { return historyDrawer && !historyDrawer.inert; }

  function paintDrawerLikes({ item, likes }) {
    if (!likes) return;
    const count = Math.max(item.likes, reactionCounts.get(item.id) || 0);
    likes.querySelector('[data-history-like-count]').textContent = count > 99 ? '99+' : String(count);
    likes.setAttribute('aria-pressed', String(reacted.has(item.id)));
  }

  function createDrawerEntry(item) {
    const row = document.createElement('li');
    row.className = 'danmaku-history-item';
    row.toggleAttribute('data-admin', item.admin);
    row.toggleAttribute('data-moderation', item.moderation);
    if (item.color) row.dataset.color = item.color;
    const meta = document.createElement('div');
    meta.className = 'danmaku-message-head danmaku-history-meta';
    if (item.moderation) {
      const author = document.createElement('span');
      author.className = 'danmaku-history-author';
      author.textContent = t('widgets.danmaku.moderationRecord', '管理记录');
      meta.append(author);
    } else {
      appendIdentity(meta, item);
      appendGroupTag(meta, item);
    }
    const date = new Date(item.createdAt);
    if (Number.isFinite(date.getTime())) {
      const time = document.createElement('time');
      time.dateTime = date.toISOString();
      time.textContent = DRAWER_DATE.format(date);
      meta.append(time);
    }
    const text = document.createElement('p');
    text.className = 'danmaku-history-text';
    text.textContent = item.text;
    const communityVote = item.moderation ? null : createCommunityVoteNode('danmaku-history-community-vote');
    if (communityVote) paintCommunityVoteNode(communityVote, item);
    let likes;
    if (!item.moderation) {
      likes = document.createElement('button');
      likes.type = 'button';
      likes.className = 'danmaku-history-likes';
      const label = document.createElement('span');
      label.className = 'sr-only';
      label.textContent = t('widgets.danmaku.likes', '赞 ');
      const count = document.createElement('span');
      count.dataset.historyLikeCount = '';
      likes.append(makeHeart(), label, count);
      meta.append(likes);
    }
    row.append(meta, text);
    if (communityVote) row.append(communityVote);
    const entry = { item, row, likes, communityVote };
    row.dataset.messageId = item.id;
    paintDrawerLikes(entry);
    return entry;
  }

  function mergeDrawerMessages(items, replaceThrough = -1) {
    if (!items.length && replaceThrough < 0) return;
    const received = new Map(items.filter(item => !withdrawnIds.has(item.id)).map(item => [item.id, item]));
    const merged = new Map();
    for (const [id, { item, revision }] of historyRows) {
      if (revision > replaceThrough) merged.set(id, item);
    }
    for (const [id, item] of received) merged.set(id, item);
    const revision = ++historyRevision;
    const ordered = [...merged.values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, DRAWER_LIMIT);
    const kept = new Set(ordered.map(item => item.id));
    const scrollTop = historyList.scrollTop;
    const listTop = scrollTop > 0 ? historyList.getBoundingClientRect().top : 0;
    const anchor = scrollTop > 0 && [...historyList.children].find(row => row.getBoundingClientRect().bottom > listTop);
    const anchorTop = anchor && anchor.offsetTop;
    for (const [id, { row }] of historyRows) {
      if (kept.has(id)) continue;
      historyRows.delete(id);
      row.remove();
    }
    ordered.forEach((item, index) => {
      let entry = historyRows.get(item.id);
      if (!entry) {
        entry = createDrawerEntry(item);
        historyRows.set(item.id, entry);
      } else if (item.likes > entry.item.likes) {
        entry.item.likes = item.likes;
        paintDrawerLikes(entry);
      }
      if (received.has(item.id)) entry.revision = revision;
      const before = historyList.children[index] ?? null;
      if (entry.row !== before) historyList.insertBefore(entry.row, before);
    });
    if (anchor?.isConnected) historyList.scrollTop = scrollTop + anchor.offsetTop - anchorTop;
  }

  function paintHistoryStatus(phase = historyPhase) {
    historyPhase = phase;
    historyList.hidden = phase === 'paused';
    const hasRows = historyRows.size > 0;
    const status = {
      loading: hasRows ? t('widgets.danmaku.historyUpdating', '正在更新历史弹幕…') : t('widgets.danmaku.historyLoading', '正在读取历史弹幕…'),
      retrying: t('widgets.danmaku.historyRetrying', '暂时无法读取完整历史，正在重试…'),
      unavailable: t('widgets.danmaku.historyUnavailable', '暂时无法读取完整历史。重新打开可重试。'),
      paused: t('widgets.danmaku.historyPaused', '弹幕已暂停。'),
      ready: hasRows ? '' : t('widgets.danmaku.historyEmpty', '还没有历史弹幕。'),
    }[phase];
    if (historyStatusMessage === status) return;
    historyStatusMessage = status;
    historyNotice?.cancel();
    historyNotice = undefined;
    if (reducedMotion.matches || !historyIsOpen()) {
      historyStatus.textContent = status;
      return;
    }
    if (status) historyStatus.textContent = status;
    const animation = historyStatus.animate([{ opacity: status ? 0 : 1 }, { opacity: status ? 1 : 0 }], {
      duration: status ? 160 : 120, easing: 'cubic-bezier(.2,.65,.25,1)',
    });
    historyNotice = animation;
    if (!status) animation.onfinish = () => {
      if (historyNotice !== animation) return;
      historyStatus.textContent = '';
      historyNotice = undefined;
    };
  }

  function addDrawerMessage(item) {
    if (nextAvailability === false) return;
    if (item.moderation) {
      if (historyLoad) historyLoad.refreshAfter = true;
      else loadDrawerHistory();
      return;
    }
    mergeDrawerMessages([item]);
    if (historyIsOpen()) paintHistoryStatus();
  }

  function cancelDrawerHistory() {
    const load = historyLoad;
    historyLoad = undefined;
    if (!load) return;
    clearTimeout(load.timer);
    load.controller.abort();
  }

  function restartDrawerHistory() {
    cancelDrawerHistory();
    loadDrawerHistory();
  }

  function loadDrawerHistory() {
    if (!historyIsOpen() || document.hidden || historyLoad) return;
    if (!isMirror && nextAvailability === false) {
      paintHistoryStatus('paused');
      return;
    }
    if (navigator.onLine === false) {
      paintHistoryStatus('unavailable');
      return;
    }
    const load = { controller: new AbortController(), attempt: 0, sawEmpty: false };
    historyLoad = load;
    paintHistoryStatus('loading');
    void requestDrawerHistory(load);
  }

  async function readPublicHistory(endpoint, limit, signal, timeoutMs = DRAWER_REQUEST_TIMEOUT) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);
    try {
      const response = await fetch(endpoint, {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      if (response.status !== 200) return { retryable: response.status >= 500 || response.status === 408 };
      const payload = await response.json();
      if (controller.signal.aborted || !Array.isArray(payload?.messages) || payload.messages.length > limit ||
          (payload.partial !== undefined && typeof payload.partial !== 'boolean')) return { retryable: true };
      const items = payload.messages.map(parseItem).filter(item => item && Number.isFinite(Date.parse(item.createdAt)));
      // New servers can mark a complete snapshot explicitly. Keep legacy responses compatible.
      const partial = payload.partial === true || items.length !== payload.messages.length;
      return { items, partial, explicitlyComplete: payload.partial === false && !partial, retryable: true };
    } catch {
      return { retryable: true };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }

  async function loadRecentForDrawer(load) {
    const result = await readPublicHistory('/api/danmaku/recent', MAX_HISTORY_QUEUE, load.controller.signal, DRAWER_RECENT_TIMEOUT);
    if (historyLoad !== load || !result.items) return;
    const now = Date.now();
    mergeDrawerMessages(result.items.filter(item => {
      const time = Date.parse(item.createdAt);
      // Replay carries live moderation text. Only the archive supplies public moderation records.
      return !item.moderation && time >= now - HISTORY_WINDOW_MS && time <= now + 30_000;
    }));
    return result;
  }

  function canConfirmLegacyEmptyHistory() {
    return !historyStreamInterrupted && (!stream || stream.readyState === EventSource.OPEN) &&
      (!isMirror || (nextAvailability === true && !mirrorPrimaryUnavailable));
  }

  async function requestDrawerHistory(load) {
    if (historyLoad !== load) return;
    load.refreshAfter = false;
    const revision = historyRevision;
    const result = await readPublicHistory('/api/danmaku/history', DRAWER_LIMIT, load.controller.signal);
    if (historyLoad !== load) return;

    const items = result.items?.filter(item => !withdrawnIds.has(item.id));
    const legacyMirrorOutage = isMirror && mirrorPrimaryUnavailable && !result.explicitlyComplete;
    const complete = !result.partial && !legacyMirrorOutage && nextAvailability !== false;
    if (items?.length) {
      // Keep messages delivered by live events or recent fallback during this request.
      mergeDrawerMessages(items, complete ? revision : -1);
      if (complete && !load.refreshAfter) {
        cancelDrawerHistory();
        paintHistoryStatus('ready');
        return;
      }
    }

    // Older servers also return unmarked empty arrays as placeholders during outages.
    const empty = complete && result.items?.length === 0;
    if (empty && result.explicitlyComplete && !load.refreshAfter) {
      mergeDrawerMessages([], revision);
      cancelDrawerHistory();
      paintHistoryStatus('ready');
      return;
    }
    const legacyEmpty = empty && canConfirmLegacyEmptyHistory() && !historyRows.size;
    if (legacyEmpty && load.sawEmpty) {
      const recent = await load.recent;
      if (historyLoad !== load) return;
      if (!historyRows.size && !load.refreshAfter && canConfirmLegacyEmptyHistory() && (!isMirror || recent?.explicitlyComplete)) {
        cancelDrawerHistory();
        paintHistoryStatus('ready');
        return;
      }
    }
    load.sawEmpty = legacyEmpty;
    const delays = isMirror ? MIRROR_DRAWER_RETRY_DELAYS : DRAWER_RETRY_DELAYS;
    const delay = delays[load.attempt++];
    if (!result.retryable || delay === undefined) {
      await load.recent;
      if (historyLoad !== load) return;
      cancelDrawerHistory();
      paintHistoryStatus('unavailable');
      return;
    }
    paintHistoryStatus('retrying');
    if (!load.recent && !historyRows.size) load.recent = loadRecentForDrawer(load);
    load.timer = setTimeout(() => void requestDrawerHistory(load), delay);
  }

  function openHistoryDrawer() {
    if (composer.inert || historyIsOpen()) return;
    clearTimeout(historyCloseTimer);
    closeOptions(false);
    historyDrawer.hidden = false;
    historyDrawer.getBoundingClientRect();
    historyDrawer.inert = false;
    historyDrawer.dataset.open = 'true';
    historyButton.setAttribute('aria-expanded', 'true');
    historyClose.focus({ preventScroll: true });
    loadDrawerHistory();
  }

  function closeHistoryDrawer(restoreFocus = true) {
    if (!historyIsOpen()) return;
    if (restoreFocus && historyDrawer.contains(document.activeElement)) historyButton.focus({ preventScroll: true });
    historyDrawer.inert = true;
    historyDrawer.dataset.open = 'false';
    historyButton.setAttribute('aria-expanded', 'false');
    cancelDrawerHistory();
    clearTimeout(historyCloseTimer);
    historyCloseTimer = setTimeout(() => { historyDrawer.hidden = true; }, reducedMotion.matches ? 0 : 220);
  }

  function openComposer() {
    clearTimeout(closeTimer);
    if (trafficBoard?.open) trafficBoard.open = false;
    hoveredChip = undefined;
    requestMotion();
    updateSend();
    composer.hidden = false;
    composer.inert = false;
    if (displayButton) displayButton.inert = false;
    if (historyButton) historyButton.inert = false;
    // Establish the collapsed layout before revealing the contents of the pill.
    composer.getBoundingClientRect();
    composer.dataset.open = 'true';
    widget.dataset.open = 'true';
    toggleText.textContent = t('widgets.danmaku.style', '样式');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', t('widgets.danmaku.settingsOpen', '打开弹幕设置'));
    syncComposerViewport();
    void refreshAdmin();
    void refreshMute();
    if (manualDisplay) connectStream();
  }

  function signedIn() { return !mirrorPrimaryUnavailable && Boolean(member || moderator); }
  function staffRole() { return member?.staff || (gold ? 'admin' : ''); }
  function canSelectColor(color, role, sponsor) {
    return MEMBER_COLORS.has(color) || (role === 'owner' && STAFF_COLORS.get(role)?.includes(color))
      || color === STAFF_COLORS.get(role)?.[0] || (sponsor && SPONSOR_COLORS.has(color));
  }

  function preferredColor() {
    const role = staffRole();
    const sponsor = member?.sponsor === true;
    const chosen = role ? appearance.staffColors[role] : sponsor ? appearance.sponsorColor : appearance.color;
    if (canSelectColor(chosen, role, sponsor)) return chosen;
    return STAFF_COLORS.get(role)?.[0] || 'default';
  }

  function selectableRankTags() {
    if (!signedIn() || !member) return [];
    const { rankTags, staff, sponsor } = member;
    // An empty server list is authoritative. Only older sessions lack this field.
    return rankTags ?? [...RANK_NAMES.keys()].filter(rank =>
      staff === 'owner' || rank === staff || (rank === 'sponsor' && sponsor));
  }

  function canSelectRankTag(tag, ranks) {
    // Hiding is separate from the list of grantable labels. Admin/mod badges cannot be hidden.
    if (tag === 'none') return ranks.length > 0 && (!member?.staff || member.staff === 'owner');
    return ranks.includes(tag);
  }

  function preferredRankTag(ranks = selectableRankTags()) {
    return canSelectRankTag(appearance.rankTag, ranks) ? appearance.rankTag : undefined;
  }

  function paintRankTagPreview() {
    if (!rankTagSelect || !rankTagPreview) return;
    const ranks = rankTagSelect.disabled ? [] : visibleRankTags({
      staff: member?.staff,
      sponsor: member?.sponsor,
      rankTag: rankTagSelect.value || undefined,
    });
    const badges = rankTagPreview.children;
    if (ranks.length === badges.length && ranks.every((rank, index) => badges[index].dataset.rank === rank)) return;
    rankTagPreview.replaceChildren(...ranks.map(createRankBadge));
  }

  function renderRankTagOptions(reset = false) {
    if (!rankTagField || !rankTagSelect) return;
    const ranks = selectableRankTags();
    rankTagField.hidden = rankTagSelect.disabled = ranks.length === 0;
    for (const option of rankTagSelect.options ?? []) {
      if (validRankTag(option.value)) option.hidden = option.disabled = !canSelectRankTag(option.value, ranks);
    }
    if (reset || (rankTagDraft && !canSelectRankTag(rankTagDraft, ranks))) rankTagDraft = undefined;
    rankTagSelect.value = rankTagDraft ?? preferredRankTag(ranks) ?? '';
    paintRankTagPreview();
  }

  function updateNicknameCount() {
    const units = nicknameUnits(nicknameInput.value.normalize('NFC').trim());
    nicknameCount.textContent = `${units} / ${NICKNAME_LIMIT}`;
    nicknameCount.toggleAttribute('data-over-limit', units > NICKNAME_LIMIT);
  }

  function renderAppearanceOptions(reset = false) {
    guestNickname.hidden = signedIn() && Boolean(member);
    accountSummary.hidden = !signedIn() || !member;
    accountNickname.textContent = member?.nickname || t('widgets.danmaku.nicknameUnset', '尚未设置昵称');
    memberColors.hidden = !signedIn();
    const role = staffRole();
    const sponsor = member?.sponsor === true;
    for (const choice of specialColorOptions) {
      const input = choice.querySelector('input');
      input.disabled = choice.hidden = !canSelectColor(input.value, role, sponsor);
    }
    const identity = `${role}:${sponsor}`;
    if (reset || memberColors.dataset.role !== identity) appearanceForm.elements.color.value = preferredColor();
    memberColors.dataset.role = identity;
    renderRankTagOptions(reset);
    updateNicknameCount();
  }

  function renderAccountOptions() {
    accountLink.hidden = mirrorPrimaryUnavailable || !adminOrigin || manualDisplay;
    // Keep the console's existing profile action steady even if session discovery fails.
    if (siteAccount && !fixedConsoleLink) siteAccount.hidden = accountLink.hidden;
    guestButton.hidden = mirrorPrimaryUnavailable || !loginRequired;
    if (!adminOrigin || manualDisplay) return;

    const hasAccount = signedIn();
    const loginUrl = accountOrigin ? `${accountOrigin}/` : `${adminOrigin}/admin/login`;
    const destination = hasAccount ? `${adminOrigin}/admin/#/account/profile` : loginUrl;
    accountLink.href = destination;
    const accountLabel = hasAccount ? t('widgets.danmaku.myAccount', '我的账号') : t('widgets.danmaku.signIn', '登录');
    const accountCaption = hasAccount ? t('widgets.danmaku.myAccountCompact', '我的账号') : accountLabel;
    accountLink.textContent = accountCaption;
    if (accountCaption !== accountLabel) accountLink.setAttribute('aria-label', accountLabel);
    else accountLink.removeAttribute('aria-label');
    if (!siteAccount || !siteAccountLabel || !siteAccountAvatar || (fixedConsoleLink && !hasAccount)) return;
    siteAccount.hidden = accountLink.hidden;
    siteAccount.href = destination;
    siteAccount.setAttribute('aria-label', accountLabel);
    siteAccount.title = accountLabel;
    siteAccount.toggleAttribute('data-signed-in', hasAccount);
    siteAccountLabel.textContent = hasAccount ? Array.from(member?.nickname || t('widgets.danmaku.accountInitial', '账'))[0] : t('widgets.danmaku.signIn', '登录');

    const avatarUrl = member?.avatarTag ? adminEndpoint(`avatar?v=${member.avatarTag}`) : null;
    if (siteAccountAvatar.getAttribute('src') === avatarUrl) return;
    siteAccountAvatar.hidden = true;
    siteAccountLabel.hidden = false;
    if (avatarUrl) siteAccountAvatar.src = avatarUrl;
    else siteAccountAvatar.removeAttribute('src');
  }

  function openOptions(focusPanel = false) {
    if (!options.inert) return;
    closeHistoryDrawer(false);
    nicknameInput.value = appearance.nickname;
    if (groupTagSelect) {
      groupTagSelect.value = appearance.groupTag ?? '';
      paintGroupTag(groupTagPreview, appearance.groupTag);
    }
    appearanceStatus.textContent = '';
    nicknameInput.removeAttribute('aria-invalid');
    renderAccountOptions();
    renderAppearanceOptions(true);
    void refreshAdmin();
    clearTimeout(optionsCloseTimer);
    if (options.hidden) {
      options.hidden = false;
      options.getBoundingClientRect();
    }
    options.inert = false;
    options.dataset.open = 'true';
    if (focusPanel) optionsClose.focus({ preventScroll: true });
  }

  function closeOptions(returnFocus = true) {
    if (options.inert) return;
    if (returnFocus && options.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    options.inert = true;
    options.dataset.open = 'false';
    clearTimeout(optionsCloseTimer);
    optionsCloseTimer = setTimeout(() => { options.hidden = true; }, reducedMotion.matches ? 0 : 250);
  }

  function closeComposer(returnFocus = true) {
    if (composer.inert) return;
    if (returnFocus && widget.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    closeOptions(false);
    closeHistoryDrawer(false);
    composer.inert = true;
    if (displayButton) displayButton.inert = true;
    if (historyButton) historyButton.inert = true;
    composer.dataset.open = 'false';
    widget.dataset.open = 'false';
    toggleText.textContent = t('widgets.danmaku.chat', '弹');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', t('widgets.danmaku.composerOpen', '打开弹幕输入栏'));
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { composer.hidden = true; }, reducedMotion.matches ? 0 : 350);
    syncComposerViewport();
    if (manualDisplay) connectStream();
  }

  toggle.addEventListener('click', () => {
    if (composer.inert) {
      openComposer();
      return;
    }
    openOptions();
  });
  toggle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (composer.inert) openComposer();
    openOptions(true);
  });
  appearanceForm.addEventListener('input', () => {
    appearanceStatus.textContent = '';
    nicknameInput.removeAttribute('aria-invalid');
    updateNicknameCount();
  });
  rankTagSelect?.addEventListener('change', () => {
    rankTagDraft = rankTagSelect.value;
    paintRankTagPreview();
  });
  groupTagSelect?.addEventListener('change', () => paintGroupTag(groupTagPreview, Number(groupTagSelect.value)));
  appearanceForm.addEventListener('submit', event => {
    event.preventDefault();
    const nickname = member ? appearance.nickname : cleanNickname(nicknameInput.value);
    if (nickname === null) {
      nicknameInput.setAttribute('aria-invalid', 'true');
      appearanceStatus.textContent = nicknameUnits(nicknameInput.value.trim()) > NICKNAME_LIMIT
        ? NICKNAME_LENGTH_MESSAGE : t('widgets.danmaku.nicknameInvalid', '昵称含有无法显示的字符。');
      nicknameInput.focus({ preventScroll: true });
      return;
    }
    const color = appearanceForm.elements.color.value;
    appearance.nickname = nickname;
    if (groupTagSelect) {
      const tag = Number(groupTagSelect.value);
      appearance.groupTag = validGroupTag(tag) ? tag : undefined;
    }
    if (rankTagSelect && !rankTagSelect.disabled) {
      const tag = rankTagSelect.value;
      appearance.rankTag = canSelectRankTag(tag, selectableRankTags()) ? tag : undefined;
    }
    if (signedIn()) {
      const role = staffRole();
      const sponsor = member?.sponsor === true;
      if (canSelectColor(color, role, sponsor)) {
        if (role) appearance.staffColors[role] = color;
        else if (sponsor) appearance.sponsorColor = color;
        else appearance.color = color;
      }
    }
    storageWrite(JSON.stringify(appearance), APPEARANCE_KEY);
    closeOptions();
  });
  historyButton?.addEventListener('click', () => {
    if (historyIsOpen()) closeHistoryDrawer();
    else openHistoryDrawer();
  });
  historyClose?.addEventListener('click', () => closeHistoryDrawer());
  optionsClose.addEventListener('click', () => closeOptions());
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.key !== 'Escape' || composing || event.isComposing || event.keyCode === 229) return;
    if (actionMenu && !actionMenu.hidden) closeActionMenu();
    else if (!moderation.inert) closeModeration();
    else if (historyIsOpen()) closeHistoryDrawer();
    else if (!options.inert) closeOptions();
    else if (!composer.inert) closeComposer();
    else return;
    event.preventDefault();
  });
  document.addEventListener('pointerdown', event => {
    const target = event.target;
    const onDanmaku = layer.contains(target);
    const onActionMenu = actionMenu?.contains(target);
    const onModeration = !moderation.inert && moderation.contains(target);
    if (!onActionMenu && actionMenu && !actionMenu.hidden) closeActionMenu(false);
    if (onDanmaku && event.button === 0 && document.activeElement === input) event.preventDefault();
    if (!moderation.inert && !onModeration && !onActionMenu) closeModeration(false);
    if (!widget.contains(target) && !onDanmaku && !onActionMenu && !onModeration) closeComposer(false);
  });
  document.addEventListener('pointerdown', event => {
    if (trafficBoard?.open && !trafficBoard.contains(event.target)) trafficBoard.open = false;
  });
  trafficBoard?.addEventListener('toggle', () => {
    if (trafficBoard.open) closeComposer(false);
  });
  window.addEventListener('resize', syncDanmakuAnchor, { passive: true });
  window.addEventListener('resize', () => {
    if (actionMenuTarget) renderActionMenu(actionMenuTarget);
  }, { passive: true });
  if (typeof ResizeObserver === 'function') {
    const anchorObserver = new ResizeObserver(syncDanmakuAnchor);
    anchorObserver.observe(widget.parentElement);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelDrawerHistory();
      cancelModerationHold();
      closeModeration(false);
      replayAllowed = false;
      replayAttempted = true;
      cancelHistoricalReplay(true);
      clearChips();
    } else {
      void refreshAdmin(true);
    }
    connectStream();
    if (!document.hidden) loadDrawerHistory();
  });
  window.addEventListener('online', () => {
    connectStream();
    loadDrawerHistory();
  });
  window.addEventListener('offline', () => {
    connectStream();
    restartDrawerHistory();
  });
  window.addEventListener('pagehide', () => {
    cancelDrawerHistory();
    replayAllowed = false;
    replayAttempted = true;
    cancelHistoricalReplay(true);
    closeStream();
    clearChips();
  });
  window.addEventListener('pageshow', event => {
    connectStream();
    if (event.persisted) loadDrawerHistory();
  });
  window.addEventListener('focus', () => {
    updateSend();
    void refreshAdmin(true);
    if (hasSent || currentMute.muted) void refreshMute();
  });

  display.addEventListener('change', () => {
    if (!manualDisplay) storageWrite(display.checked ? 'on' : 'off');
    if (!display.checked) {
      replayAllowed = false;
      replayAttempted = true;
      cancelHistoricalReplay(true);
    }
    clearChips();
    if (!display.checked) setFeedState(t('widgets.danmaku.displayDisabled', '已关闭显示'));
    else if (stream?.readyState === EventSource.OPEN) setFeedState(t('widgets.danmaku.connected', '弹幕已连接'));
    connectStream();
  });
  reducedMotion.addEventListener?.('change', event => {
    if (event.matches && historyNotice) {
      historyNotice.cancel();
      historyNotice = undefined;
      historyStatus.textContent = historyStatusMessage;
    }
    layer.dataset.reducedMotion = String(event.matches);
    clearChips();
  });

  const visibilityObserver = new MutationObserver(() => {
    if (siteMenu?.open || qqMenu?.open) {
      replayAllowed = false;
      replayAttempted = true;
      cancelHistoricalReplay(true);
      closeComposer(false);
      closeModeration(false);
      if (!hasSent && !currentMute.muted) closeStream();
      clearChips();
      setFeedState(t('widgets.danmaku.paused', '暂时暂停'));
    } else {
      connectStream();
    }
  });
  if (siteMenu) visibilityObserver.observe(siteMenu, { attributes: true, attributeFilter: ['open', 'class'] });
  if (qqMenu) visibilityObserver.observe(qqMenu, { attributes: true, attributeFilter: ['open'] });
  visibilityObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  function enforceInputLimit() {
    const bounded = limitText(input.value);
    if (bounded !== input.value) {
      input.value = bounded;
      setStatus(t('widgets.danmaku.sendMax', '最多 {max} 个字，请删减后再发送。', { max: MAX_CODE_POINTS }), 'error');
    } else if (status.dataset.tone === 'error') {
      setStatus('');
    }
    updateCount();
  }

  sendButton.addEventListener('pointerdown', event => {
    // Keep a touch keyboard open while the send button is pressed.
    if (document.activeElement === input) event.preventDefault();
  });
  input.addEventListener('focus', syncComposerViewport);
  input.addEventListener('blur', syncComposerViewport);
  window.visualViewport?.addEventListener('resize', syncComposerViewport);
  window.visualViewport?.addEventListener('scroll', syncComposerViewport);
  window.addEventListener('resize', syncComposerViewport);

  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => {
    composing = false;
    setTimeout(enforceInputLimit, 0);
  });
  input.addEventListener('input', event => {
    if (composing || event.isComposing) {
      updateCount();
      return;
    }
    enforceInputLimit();
  });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    if (composing || event.isComposing || event.keyCode === 229) {
      suppressImeSubmit = true;
      setTimeout(() => { suppressImeSubmit = false; }, 0);
      return;
    }
    event.preventDefault();
    updateSend();
    if (!sendButton.disabled) form.requestSubmit();
  });

  function remainingSendCooldown() {
    return signedIn() ? 0 : Math.max(0, cooldownUntil - Date.now());
  }

  function remainingCommunityCooldownSeconds() {
    return Math.max(0, Math.ceil((communityCooldownUntil - Date.now()) / 1000));
  }

  function setCommunityCooldown(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    communityCooldownUntil = Math.max(communityCooldownUntil, Date.now() + Math.min(COMMUNITY_COOLDOWN_MS, Math.ceil(seconds) * 1000));
    tickCommunityCooldown();
  }

  function tickCommunityCooldown() {
    clearTimeout(communityCooldownTimer);
    const remaining = remainingCommunityCooldownSeconds();
    if (actionMenuTarget) renderActionMenu(actionMenuTarget);
    if (remaining && actionMenuTarget) communityCooldownTimer = setTimeout(tickCommunityCooldown, 1000);
  }

  function setActionMenuStatus(message, tone = '') {
    if (!actionMenuStatus) return;
    actionMenuStatus.textContent = message;
    if (tone) actionMenuStatus.dataset.tone = tone;
    else delete actionMenuStatus.dataset.tone;
  }

  function selectMessageText(node) {
    const text = node?.querySelector('.danmaku-chip-text, .danmaku-history-text');
    if (!text) return false;
    const selection = window.getSelection?.();
    if (!selection) return false;
    const range = document.createRange();
    text.dataset.selected = 'true';
    range.selectNodeContents(text);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  async function copyMessageText(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch { /* Fall back when the browser denies clipboard access. */ }
    }
    const helper = document.createElement('textarea');
    try {
      helper.value = text;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.append(helper);
      helper.select();
      return document.execCommand('copy');
    } catch { return false; }
    finally { helper.remove(); }
  }

  function actionTarget(target, fromHistory) {
    const selector = fromHistory ? '.danmaku-history-item' : '.danmaku-chip';
    const node = target?.closest(selector);
    const records = fromHistory ? historyRows : visibleChips;
    const item = node && records.get(node.dataset.messageId)?.item;
    return item && !withdrawnIds.has(item.id) ? { node, item, fromHistory } : null;
  }

  function votable(item) {
    return !item.admin && !item.staff && !item.moderation && !item.id.startsWith('local-echo:');
  }

  function canStartCommunityVote() {
    return Boolean(member && !moderator && !loginRequired);
  }

  function pendingCommunityVote(id) {
    const vote = communityVotes.get(id);
    return vote?.status === 'pending' && communityVoteRemaining(vote) > 0;
  }

  function renderActionMenu(target) {
    if (!actionMenu || !target) return;
    const vote = communityVotes.get(target.item.id);
    const communityButton = actionMenu.querySelector('[data-action="community-vote"]');
    const managementButton = actionMenu.querySelector('[data-action="management-ban"]');
    const communityLabel = communityButton?.querySelector('[data-action-label]');
    const pending = pendingCommunityVote(target.item.id);
    communityButton.hidden = !votable(target.item) || (!pending && !canStartCommunityVote());
    managementButton.hidden = !moderator || target.item.admin || target.item.moderation ||
      target.item.id.startsWith('local-echo:') || target.management;
    if (!communityButton.hidden) {
      const cooldown = remainingCommunityCooldownSeconds();
      const finished = vote?.status === 'failed' || vote?.status === 'passed';
      const own = ownIds.has(target.item.id);
      const supported = supportedCommunityVotes.has(target.item.id);
      communityButton.disabled = communityVoteSending.has(target.item.id) || own || supported || finished || nextAvailability === false || (!pending && cooldown > 0);
      if (own) communityLabel.textContent = t('widgets.danmaku.voteOwn', '不能投自己的弹幕');
      else if (pending) communityLabel.textContent = t('widgets.danmaku.voteCount', '{action}（{votes}/{threshold}）', {
        action: supported ? t('widgets.danmaku.voteSupported', '已支持') : t('widgets.danmaku.voteSupport', '支持禁言'),
        votes: vote.votes, threshold: vote.threshold,
      });
      else if (vote?.status === 'failed') communityLabel.textContent = t('widgets.danmaku.voteFailed', '社区投票未通过');
      else if (vote?.status === 'passed') communityLabel.textContent = t('widgets.danmaku.votePassed', '社区禁言已生效');
      else if (cooldown > 0) communityLabel.textContent = t('widgets.danmaku.voteCooldownLabel', '发起禁言投票（还剩 {seconds} 秒）', { seconds: cooldown });
      else communityLabel.textContent = t('widgets.danmaku.startVote', '发起禁言投票');
    }
    if (actionMenu.hidden) return;
    const rect = target.node.getBoundingClientRect();
    const menuRect = actionMenu.getBoundingClientRect();
    const gap = 8;
    const left = Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, rect.left + rect.width / 2 - menuRect.width / 2));
    const top = rect.top >= menuRect.height + gap ? rect.top - menuRect.height - gap : Math.min(window.innerHeight - menuRect.height - 8, rect.bottom + gap);
    actionMenu.style.left = `${Math.round(left)}px`;
    actionMenu.style.top = `${Math.round(Math.max(8, top))}px`;
  }

  function openActionMenu(item, node, fromHistory = false, mobile = false) {
    if (!item) return;
    closeModeration(false);
    cancelModerationHold();
    actionMenuReturnFocus = document.activeElement;
    const management = mobile && moderator && !item.admin && !item.moderation && !item.id.startsWith('local-echo:');
    actionMenuTarget = { item, node, fromHistory, management };
    actionMenu.setAttribute('aria-label', t('widgets.danmaku.actionsForMessage', '弹幕操作：{message}', { message: item.text }));
    if (!fromHistory) layer.dataset.paused = 'true';
    clearTimeout(actionMenuCloseTimer);
    actionMenu.hidden = false;
    actionMenu.inert = false;
    actionMenu.getBoundingClientRect();
    actionMenu.dataset.open = 'true';
    setActionMenuStatus('');
    tickCommunityCooldown();
    if (votable(item)) {
      void refreshAdmin().then(() => {
        if (actionMenuTarget?.item.id !== item.id) return;
        renderActionMenu(actionMenuTarget);
        return refreshCommunityVote(item.id);
      });
    }
    if (management) openModeration(item, fromHistory, true);
    actionMenu.querySelector('.danmaku-message-action:not([hidden])')?.focus({ preventScroll: true });
  }

  function closeActionMenu(restoreFocus = true) {
    if (!actionMenu || actionMenu.inert) return;
    if (restoreFocus && actionMenuReturnFocus?.isConnected && !actionMenuReturnFocus.closest('[hidden], [inert]')) {
      actionMenuReturnFocus.focus({ preventScroll: true });
    }
    actionMenu.inert = true;
    actionMenu.dataset.open = 'false';
    const selectedText = actionMenuTarget?.node.querySelector('[data-selected]');
    if (selectedText) delete selectedText.dataset.selected;
    actionMenuTarget = undefined;
    if (moderation.inert) delete layer.dataset.paused;
    setActionMenuStatus('');
    clearTimeout(actionMenuCloseTimer);
    actionMenuCloseTimer = setTimeout(() => { actionMenu.hidden = true; }, reducedMotion.matches ? 0 : 170);
    requestMotion();
  }

  function communityVoteError(payload) {
    if (locale === 'zh-CN' && payload?.error) return payload.error;
    switch (payload?.code) {
      case 'community_vote_action_invalid': return t('widgets.danmaku.voteInvalid', '投票操作有误');
      case 'community_vote_start_forbidden': return t('widgets.danmaku.voteRestricted', '只有普通登录用户可以发起社区禁言投票');
      case 'community_vote_login_required': return t('widgets.danmaku.voteSignIn', '请先登录普通账号，再发起或支持社区禁言投票');
      case 'community_vote_not_found': return t('widgets.danmaku.voteMissing', '这条弹幕没有正在进行的社区禁言投票');
      case 'community_vote_processing': return t('widgets.danmaku.voteProcessing', '这条社区禁言投票正在处理');
      case 'community_vote_exists': return t('widgets.danmaku.voteExists', '这条弹幕已有进行中的投票，请选择支持');
      case 'community_vote_target_unavailable': return t('widgets.danmaku.voteTargetUnavailable', '这条弹幕无法发起社区禁言投票');
      case 'duplicate_vote': return t('widgets.danmaku.voteDuplicate', '这个账号或设备已投过票');
      case 'community_vote_closed': return t('widgets.danmaku.voteEnded', '这条投票已结束。');
      case 'community_vote_self_vote': return t('widgets.danmaku.voteOwn', '不能投自己的弹幕');
      default: return t('widgets.danmaku.voteUnavailable', '暂时无法提交投票。');
    }
  }

  async function submitCommunityVote(item, action) {
    if (!item || !votable(item) || ownIds.has(item.id) || supportedCommunityVotes.has(item.id) ||
        communityVoteSending.has(item.id) || nextAvailability === false) return;
    if (action === 'start' && !canStartCommunityVote()) return;
    const feedback = (message, error = false) => {
      if (actionMenuTarget?.item.id === item.id) setActionMenuStatus(message, error ? 'error' : '');
      else showNotice(message, error);
    };
    const cooldown = remainingCommunityCooldownSeconds();
    if (action === 'start' && cooldown > 0) {
      feedback(t('widgets.danmaku.voteCooldown', '发起社区禁言投票还需等待 {seconds} 秒。', { seconds: cooldown }), true);
      return;
    }
    communityVoteSending.add(item.id);
    updateCommunityVoteDom(item.id);
    try {
      const { url, credentials } = communityVoteEndpoint();
      const response = await fetch(url, {
        method: 'POST', credentials, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ messageId: item.id, action }),
        signal: AbortSignal.timeout?.(8000),
      });
      const payload = await response.json().catch(() => ({}));
      if (payload?.vote) applyCommunityVote(payload.vote);
      const serverSeconds = payload?.remainingCooldownSeconds ?? payload?.vote?.remainingCooldownSeconds;
      if (Number.isFinite(serverSeconds) && serverSeconds > 0) setCommunityCooldown(serverSeconds);
      if (response.status === 429 && payload?.code === 'community_vote_cooldown') {
        const retryAfter = Number(response.headers.get('Retry-After'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) setCommunityCooldown(retryAfter);
        const remaining = remainingCommunityCooldownSeconds();
        feedback(t('widgets.danmaku.voteCooldown', '发起社区禁言投票还需等待 {seconds} 秒。', { seconds: remaining || Math.ceil(retryAfter || 0) }), true);
      } else if (!response.ok) {
        if (payload?.code === 'duplicate_vote') supportedCommunityVotes.add(item.id);
        feedback(communityVoteError(payload), payload?.code !== 'duplicate_vote');
      } else if (payload?.vote && payload.vote.status !== 'failed') {
        supportedCommunityVotes.add(item.id);
        if (actionMenuTarget?.item.id === item.id) closeActionMenu();
        if (action === 'support') showNotice(payload.vote.status === 'passed' ? t('widgets.danmaku.votePassedStatus', '社区禁言已生效。') : t('widgets.danmaku.voteSupportedStatus', '已支持社区禁言。'), false);
      } else {
        feedback(t('widgets.danmaku.voteEnded', '这条投票已结束。'), true);
      }
    } catch {
      feedback(t('widgets.danmaku.voteError', '社区投票暂时失败，请稍后重试。'), true);
    } finally {
      communityVoteSending.delete(item.id);
      if (supportedCommunityVotes.size > MAX_HISTORY_QUEUE) supportedCommunityVotes.delete(supportedCommunityVotes.values().next().value);
      updateCommunityVoteDom(item.id);
    }
  }

  async function handleActionMenuClick(event) {
    const button = event.target.closest('.danmaku-message-action');
    if (!button || button.disabled || !actionMenuTarget) return;
    const { item, node, fromHistory } = actionMenuTarget;
    if (button.dataset.action === 'select') {
      setActionMenuStatus(selectMessageText(node) ? t('widgets.danmaku.selected', '已选择弹幕文字。') : t('widgets.danmaku.selectFailed', '无法选择这条弹幕。'));
    } else if (button.dataset.action === 'copy') {
      setActionMenuStatus(await copyMessageText(item.text) ? t('widgets.danmaku.copied', '已复制弹幕。') : t('widgets.danmaku.copyFailed', '复制失败，请长按文字选择。'), 'error');
    } else if (button.dataset.action === 'management-ban') {
      closeActionMenu(false);
      openModeration(item, fromHistory);
    } else if (button.dataset.action === 'community-vote') {
      await submitCommunityVote(item, pendingCommunityVote(item.id) ? 'support' : 'start');
    }
  }

  function updateSend() {
    clearTimeout(cooldownTimer);
    const remaining = remainingSendCooldown();
    const seconds = Math.max(0, Math.ceil(remaining / 1000));
    const blocked = nextAvailability === false || (loginRequired && !mirrorPrimaryUnavailable) || (!mirrorPrimaryUnavailable && currentMute.muted && !(signedIn() && gold));
    const showCooldown = seconds > 0 && !blocked;
    const label = showCooldown ? t('widgets.danmaku.sendCooldown', '{seconds} 秒', { seconds }) : t('widgets.danmaku.send', '发送');
    if (sendLabel.textContent !== label) sendLabel.textContent = label;
    sendLabel.classList.toggle('sr-only', !showCooldown);
    sendButton.toggleAttribute('data-cooldown', showCooldown);
    sendButton.disabled = Boolean(sendController) || blocked || seconds > 0;
    if (seconds > 0) cooldownTimer = setTimeout(updateSend, remaining - (seconds - 1) * 1000 + 12);
  }

  function readSendCooldown(response, header) {
    const value = response.headers.get(header)?.trim();
    if (!value || !/^\d+$/.test(value)) return;
    const seconds = Number(value);
    const until = Date.now() + seconds * 1000;
    if (seconds > 0 && Number.isSafeInteger(until)) {
      cooldownUntil = Math.max(cooldownUntil, until);
      updateSend();
    }
  }

  function setPostingIdentity(nextMember = null, canModerate = false, canPostGold = false) {
    const wasSignedIn = signedIn();
    if (!canModerate && moderator) {
      cancelModerationHold();
      closeModeration();
    }
    member = nextMember;
    moderator = canModerate;
    gold = canPostGold;
    if (actionMenuTarget) renderActionMenu(actionMenuTarget);
    if (wasSignedIn !== signedIn()) {
      currentMute = { muted: false, expiresAt: null };
      muteRevision++;
      clearTimeout(muteTimer);
      void refreshMute();
    }
    inputAdmin.hidden = !(signedIn() && gold);
    widget.toggleAttribute('data-moderator', moderator);
    renderAccountOptions();
    if (!options.inert) renderAppearanceOptions();
    layer.toggleAttribute('data-moderator', moderator);
    if (actionMenuTarget) renderActionMenu(actionMenuTarget);
    if (!moderator && hoveredChip) {
      hoveredChip = undefined;
      requestMotion();
    }
    updateInputGate();
    updateSend();
  }

  function expireAdmin() {
    loginRequired = true;
    checkedAdminAt = 0;
    setPostingIdentity();
    setStatus(t('widgets.danmaku.sessionExpired', '登录已过期，请重新登录。'), 'error');
    if (!composer.inert && options.inert) openOptions(true);
  }

  async function discoverAdmin() {
    const response = await fetch('/api/danmaku/config', { cache: 'no-store', signal: AbortSignal.timeout?.(4000) });
    if (!response.ok) throw new Error('无法读取弹幕配置');
    const { adminOrigin: advertised, accountOrigin: loginOrigin, active } = await response.json();
    if (nextAvailability === undefined) setAvailability(active);
    if (manualDisplay) return null;
    if (typeof loginOrigin === 'string') {
      const login = new URL(loginOrigin);
      if (login.protocol === 'https:' && login.origin === loginOrigin) accountOrigin = login.origin;
    }
    updateInputGate();
    if (typeof advertised !== 'string' || !advertised) return null;
    const url = new URL(advertised);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    if (url.origin !== advertised || (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && url.hostname === location.hostname))) return null;
    return url.origin;
  }

  function refreshAdmin(force = false) {
    if (mirrorPrimaryUnavailable || guestMode || adminOrigin === null || (manualDisplay && composer.inert)) return Promise.resolve();
    if (checkingAdmin) return checkingAdmin;
    if (!force && Date.now() - checkedAdminAt < 4000) return Promise.resolve();
    checkingAdmin = (async () => {
      try {
        if (adminOrigin === undefined) adminOrigin = await discoverAdmin();
        if (mirrorPrimaryUnavailable || !adminOrigin) return;
        renderAccountOptions();
        if (!options.inert) renderAppearanceOptions();
        const response = await fetch(adminEndpoint('session'), {
          credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout?.(4000),
        });
        if (!response.ok) return;
        const session = await response.json();
        if (guestMode || mirrorPrimaryUnavailable) return;
        checkedAdminAt = Date.now();
        if (session.authenticated === true) {
          if (loginRequired) setStatus('');
          loginRequired = false;
          const nextMember = typeof session.nickname === 'string' ? {
            nickname: session.nickname,
            staff: STAFF_COLORS.has(session.staff) ? session.staff : '',
            sponsor: session.sponsor === true,
            rankTags: Object.hasOwn(session, 'rankTags')
              ? [...RANK_NAMES.keys()].filter(rank => Array.isArray(session.rankTags) && session.rankTags.includes(rank))
              : undefined,
            avatarTag: /^[a-f0-9]{32}$/.test(session.avatarTag) ? session.avatarTag : null,
          } : null;
          setPostingIdentity(nextMember, session.canModerate ?? !nextMember, session.gold ?? !nextMember);
        } else if (member || moderator) expireAdmin();
      } catch { /* A temporary network failure does not invalidate a working login. */ }
    })().finally(() => { checkingAdmin = undefined; });
    return checkingAdmin;
  }

  const expiryFormat = new Intl.DateTimeFormat(locale, {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });

  function muteMessage() {
    if (currentMute.source === 'community') return t('widgets.danmaku.communityMuteUntil', '社区禁言至 {time}（北京时间），期间不能发弹幕。', { time: expiryFormat.format(new Date(currentMute.expiresAt)) });
    if (!currentMute.expiresAt) return t('widgets.danmaku.permanentBanNotice', '你已被管理员永久封禁。');
    return t('widgets.danmaku.adminBanUntil', '管理员封禁至 {time}（北京时间）。', { time: expiryFormat.format(new Date(currentMute.expiresAt)) });
  }

  function showNotice(message, muted) {
    clearTimeout(noticeTimer);
    notice.textContent = message;
    notice.dataset.tone = muted ? 'muted' : 'restored';
    notice.dataset.visible = 'true';
    noticeTimer = setTimeout(() => { delete notice.dataset.visible; }, muted ? 12_000 : 5000);
  }

  function setMute(payload, forceNotice = false) {
    if (typeof payload?.muted !== 'boolean') return;
    const expiry = Date.parse(payload.expiresAt);
    if (payload.muted && payload.expiresAt !== null && !Number.isFinite(expiry)) return;
    const muted = payload.muted && (payload.expiresAt === null || expiry > Date.now());
    const expiresAt = muted ? payload.expiresAt : null;
    const source = muted && expiresAt && payload.source === 'community' ? 'community' : undefined;
    const wasMuted = currentMute.muted;
    const changed = wasMuted !== muted || currentMute.expiresAt !== expiresAt || currentMute.source !== source;
    currentMute = { muted, expiresAt, source };
    muteRevision++;
    clearTimeout(muteTimer);
    if (expiresAt) {
      const remaining = Math.max(0, expiry - Date.now());
      const checkAt = Math.min(remaining, 24 * 60 * 60_000);
      muteTimer = setTimeout(() => setMute(currentMute), checkAt + 100);
    }
    updateInputGate();
    updateSend();
    if (gold) return;
    if (muted && (changed || forceNotice)) {
      setStatus(muteMessage(), 'error');
      showNotice(muteMessage(), true);
    } else if (wasMuted && !muted) {
      setStatus(t('widgets.danmaku.muteLifted', '禁言已解除，可以发送弹幕了。'), '');
      showNotice(t('widgets.danmaku.muteLifted', '禁言已解除，可以发送弹幕了。'), false);
    }
  }

  function refreshMute() {
    const account = signedIn();
    if (checkingMute?.account === account) return checkingMute.request;
    const expected = muteRevision;
    const scope = { account };
    scope.request = (async () => {
      try {
        const endpoint = account ? adminEndpoint('status') : '/api/danmaku/status';
        const response = await fetch(endpoint, {
          credentials: account ? 'include' : 'same-origin', cache: 'no-store', signal: AbortSignal.timeout?.(4500),
        });
        if (!response.ok) return;
        const payload = await response.json();
        if (expected === muteRevision && account === signedIn()) setMute(payload);
      } catch { /* Sending still checks the active ban on the server. */ }
    })().finally(() => { if (checkingMute === scope) checkingMute = undefined; });
    checkingMute = scope;
    return scope.request;
  }

  function forgetRemoved(ids) {
    if (!Array.isArray(ids)) return;
    const hadRows = historyRows.size > 0;
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      withdrawnIds.add(id);
      if (withdrawnIds.size > MAX_HISTORY_QUEUE) withdrawnIds.delete(withdrawnIds.keys().next().value);
      historyRows.get(id)?.row.remove();
      historyRows.delete(id);
      const communityPass = communityVotes.get(id)?.status === 'passed';
      const flight = visibleChips.get(id);
      if (communityPass && flight) {
        closeActionMenu(false);
        freezeCommunityFlight(flight);
        clearTimeout(communityVoteNoticeTimers.get(id));
        communityVoteNoticeTimers.set(id, setTimeout(() => {
          removeVisibleChip(id);
          communityVoteNoticeTimers.delete(id);
          requestMotion();
        }, COMMUNITY_SUCCESS_VISIBLE_MS));
        continue;
      }
      removeVisibleChip(id);
    }
    if (hadRows && !historyRows.size) loadDrawerHistory();
    if (historyQueue.length) historyQueue = historyQueue.filter(item => !withdrawnIds.has(item.id));
    for (let index = pendingChips.length - 1; index >= 0; index--) {
      if (withdrawnIds.has(pendingChips[index].item.id)) pendingChips.splice(index, 1);
    }
    requestMotion();
    finishHistoricalReplay();
  }

  function setModerationDuration(duration = '', preset = null, custom = null) {
    selectedDuration = duration;
    for (const button of durationButtons) button.setAttribute('aria-pressed', String(button === preset));
    for (const input of durationInputs) {
      if (input === custom) continue;
      input.value = '';
      input.removeAttribute('aria-invalid');
    }
    moderationStatus.textContent = '';
    moderationConfirm.disabled = savingMute || !duration;
  }

  function openModeration(item, fromHistory = false, keepActionMenu = false) {
    if (!moderator || !item || item.admin || item.moderation || savingMute) return;
    if (!keepActionMenu) closeActionMenu(false);
    if (moderation.hidden) moderationReturnFocus = document.activeElement;
    clearTimeout(moderationCloseTimer);
    moderationRevision++;
    selectedItem = item;
    closeOptions(false);
    if (!fromHistory) closeHistoryDrawer(false);
    layer.dataset.paused = 'true';
    hoveredChip = undefined;
    requestMotion();
    moderation.hidden = false;
    moderation.inert = false;
    moderationTitle.textContent = t('widgets.danmaku.banTitle', '封禁账号和设备');
    moderationQuote.textContent = item.text;
    moderationActions.hidden = false;
    setModerationDuration();
    durationButtons[0].focus({ preventScroll: true });
  }

  function closeModeration(restoreFocus = true) {
    if (moderation.hidden || moderation.inert) return;
    moderationRevision++;
    if (restoreFocus && moderation.contains(document.activeElement)) {
      const previous = moderationReturnFocus;
      const target = previous && !previous.closest('[hidden], [inert]') && previous !== document.body ? previous : toggle;
      target.focus({ preventScroll: true });
    }
    moderation.inert = true;
    if (actionMenuTarget?.management) closeActionMenu(false);
    delete layer.dataset.paused;
    requestMotion();
    selectedItem = undefined;
    clearTimeout(moderationCloseTimer);
    moderationCloseTimer = setTimeout(() => { moderation.hidden = true; }, reducedMotion.matches ? 0 : 180);
  }

  class DanmakuRequestError extends Error {
    constructor(reason) {
      super(reason);
      this.name = 'DanmakuRequestError';
      this.reason = reason;
    }
  }

  function forbiddenMessage() {
    return signedIn() ? t('widgets.danmaku.sendAccountBlocked', '当前账号暂时不能发送，请到控制台查看账号状态。') : t('widgets.danmaku.sendPageBlocked', '无法从当前页面发送，请刷新后重试。');
  }

  function nonceFailureReason(status, code) {
    if (code === 'mirror_control_only') return t('widgets.danmaku.mirrorOnly', '应急管理请通过备用机执行。');
    if (status === 403) return forbiddenMessage();
    if (status === 429) return t('widgets.danmaku.nonceRate', '待用的发送凭证太多，请稍后再试。');
    if (status >= 500) return t('widgets.danmaku.sendUnavailable', '弹幕暂时不可用，请稍后再试。');
    return t('widgets.danmaku.nonceFailed', '发送凭证获取失败（{status}），请刷新页面后重试。', { status });
  }

  function sendFailureMessage(error, viaConsole) {
    if (error instanceof DanmakuRequestError) return error.reason;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return t('widgets.danmaku.sendTimeout', '发送超时，请检查网络后重试。');
    // A failed cross-origin request hides its status; the console host refused it or was unreachable.
    if (error instanceof TypeError) return viaConsole ? t('widgets.danmaku.accountConnection', '无法连接账号服务，请刷新页面后重试。') : t('widgets.danmaku.network', '网络连接失败，请稍后重试。');
    return t('widgets.danmaku.sendError', '发送暂时失败，请稍后重试。');
  }

  async function requestDanmakuNonce(url, signal, admin = false) {
    const response = await fetch(url, {
      cache: 'no-store', redirect: 'error', signal, credentials: admin ? 'include' : 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (admin && response.status === 401) {
      expireAdmin();
      return null;
    }
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw new DanmakuRequestError(nonceFailureReason(response.status, problem?.code));
    }
    const payload = await response.json().catch(() => null);
    const nonce = payload?.nonce;
    if (typeof nonce !== 'string' || !/^[a-f0-9]{48}$/.test(nonce)) {
      throw new DanmakuRequestError(t('widgets.danmaku.nonceInvalid', '发送凭证无效，请刷新页面后重试。'));
    }
    return nonce;
  }

  function moderationFailureMessage(response, result) {
    if (locale === 'zh-CN' && result?.error) return result.error;
    if (result?.code === 'stale_request') return t('widgets.danmaku.banStale', '禁言请求已失效，请重试');
    if (response.status === 404) return t('widgets.danmaku.banTargetGone', '这条弹幕已过期或已下架');
    return t('widgets.danmaku.banError', '暂时无法封禁，请重试。');
  }

  async function submitMute() {
    if (!moderator || !selectedItem || !selectedDuration || moderation.inert || savingMute) return;
    const item = selectedItem;
    const duration = selectedDuration;
    const expected = moderationRevision;
    savingMute = true;
    for (const control of [...durationButtons, ...durationInputs, moderationConfirm]) control.disabled = true;
    moderationActions.setAttribute('data-saving', '');
    moderationStatus.textContent = t('widgets.danmaku.banSaving', '正在封禁…');
    try {
      const signal = AbortSignal.timeout?.(9000);
      const nonce = await requestDanmakuNonce(adminEndpoint('nonce?action=mute'), signal, true);
      if (!nonce || expected !== moderationRevision) return;
      const response = await fetch(adminEndpoint('mutes'), {
        method: 'POST', credentials: 'include', cache: 'no-store', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ messageId: item.id, duration, nonce }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) {
        expireAdmin();
        showNotice(t('widgets.danmaku.adminExpired', '管理员登录已过期，请重新登录。'), true);
      } else if (response.ok && result.mute) {
        forgetRemoved([item.id]);
        closeModeration();
        showNotice(t('widgets.danmaku.banApplied', '已封禁。'), false);
      } else if (expected === moderationRevision) {
        moderationStatus.textContent = moderationFailureMessage(response, result);
      }
    } catch (error) {
      if (expected === moderationRevision) {
        moderationStatus.textContent = error instanceof DanmakuRequestError ? error.reason : t('widgets.danmaku.banError', '暂时无法封禁，请重试。');
      }
    } finally {
      savingMute = false;
      moderationActions.removeAttribute('data-saving');
      for (const control of [...durationButtons, ...durationInputs]) control.disabled = false;
      moderationConfirm.disabled = moderation.inert || !selectedDuration;
    }
  }

  for (const link of [accountLink, siteAccount, inputLogin].filter(Boolean)) {
    link.addEventListener('click', () => { guestMode = false; checkedAdminAt = 0; });
  }
  siteAccountAvatar?.addEventListener('load', () => {
    if (!member?.avatarTag || !siteAccountAvatar.naturalWidth) return;
    siteAccountAvatar.hidden = false;
    siteAccountLabel.hidden = true;
  });
  siteAccountAvatar?.addEventListener('error', () => {
    siteAccountAvatar.hidden = true;
    siteAccountLabel.hidden = false;
  });
  guestButton.addEventListener('click', () => {
    guestMode = true;
    loginRequired = false;
    setPostingIdentity();
    setStatus(currentMute.muted ? muteMessage() : '', currentMute.muted ? 'error' : '');
  });
  moderationClose.addEventListener('click', () => closeModeration());
  for (const button of durationButtons) {
    button.addEventListener('click', () => setModerationDuration(button.dataset.duration, button));
  }
  for (const input of durationInputs) {
    input.addEventListener('input', () => {
      const isHours = input.dataset.durationUnit === 'h';
      const valid = /^[1-9]\d*$/.test(input.value) && input.validity.valid;
      const invalid = !valid && (input.value !== '' || input.validity.badInput);
      setModerationDuration(valid ? `${input.value}${input.dataset.durationUnit}` : '', null, input);
      if (invalid) {
        input.setAttribute('aria-invalid', 'true');
        moderationStatus.textContent = isHours
          ? t('widgets.danmaku.invalidHours', '请输入 1–{max} 小时的整数。', { max: input.max })
          : t('widgets.danmaku.invalidDays', '请输入 1–{max} 天的整数。', { max: input.max });
      } else input.removeAttribute('aria-invalid');
    });
  }
  moderationConfirm.addEventListener('click', () => void submitMute());
  const moderatableChip = '.danmaku-chip:not([data-admin], [data-local-only], [data-moderation])';
  layer.addEventListener('pointerover', event => {
    if (!moderator || event.pointerType !== 'mouse') return;
    const chip = event.target.closest(moderatableChip);
    if (!chip || chip.contains(event.relatedTarget)) return;
    hoveredChip = chip;
    requestMotion();
  });
  layer.addEventListener('pointerout', event => {
    if (!hoveredChip || !hoveredChip.contains(event.target) || hoveredChip.contains(event.relatedTarget)) return;
    hoveredChip = undefined;
    requestMotion();
  });
  layer.addEventListener('click', event => {
    if (event.button !== 0 || event.target.closest('[data-community-vote-count]') || layer.hasAttribute('data-paused')) return;
    const chip = event.target.closest('.danmaku-chip[data-likeable]');
    const flight = chip && visibleChips.get(chip.dataset.messageId);
    if (flight) void likeMessage(flight.item, flight);
  });
  function cancelModerationHold() {
    if (!moderationHold) return;
    clearTimeout(moderationHold.timer);
    moderationHold = undefined;
    requestMotion();
  }

  function installModerationGestures(region, fromHistory) {
    region.addEventListener('contextmenu', event => {
      const target = actionTarget(event.target, fromHistory);
      if (!target) return;
      event.preventDefault();
      if (blockHeldClick) return;
      if (moderationHold?.support && event.target.closest('[data-community-vote-count]')) return;
      if (moderationHold) blockHeldClick = true;
      cancelModerationHold();
      openActionMenu(target.item, target.node, fromHistory, event.pointerType === 'touch');
    });
    region.addEventListener('pointerdown', event => {
      const count = event.target.closest('[data-community-vote-count]');
      if (event.button !== 0 || !event.isPrimary || (event.pointerType === 'mouse' && !count)) return;
      const target = actionTarget(event.target, fromHistory);
      if (!target) return;
      cancelModerationHold();
      const support = Boolean(count && !count.disabled && pendingCommunityVote(target.item.id));
      if (count && !support) return;
      const hold = { id: event.pointerId, x: event.clientX, y: event.clientY, live: !fromHistory && !support, support };
      hold.timer = setTimeout(() => {
        if (moderationHold !== hold || !target.node.isConnected || withdrawnIds.has(target.item.id) || (fromHistory && !historyIsOpen())) {
          cancelModerationHold();
          return;
        }
        blockHeldClick = true;
        cancelModerationHold();
        if (support) void submitCommunityVote(target.item, 'support');
        else openActionMenu(target.item, target.node, fromHistory, true);
      }, MODERATION_HOLD_MS);
      moderationHold = hold;
      if (hold.live) requestMotion();
    });
    region.addEventListener('click', event => {
      const count = event.target.closest('[data-community-vote-count]');
      if (!count || count.disabled) return;
      const target = actionTarget(count, fromHistory);
      if (target) void submitCommunityVote(target.item, 'support');
    });
  }

  document.addEventListener('pointerdown', () => { blockHeldClick = false; }, true);
  document.addEventListener('click', event => {
    if (!blockHeldClick || event.detail === 0) return;
    blockHeldClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener('pointermove', event => {
    const hold = moderationHold;
    if (!hold || event.pointerId !== hold.id) return;
    if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > MODERATION_MOVE_PX) cancelModerationHold();
  }, { passive: true });
  for (const type of ['pointerup', 'pointercancel']) {
    window.addEventListener(type, event => {
      if (event.pointerId === moderationHold?.id) cancelModerationHold();
    });
  }
  historyList.addEventListener('scroll', () => {
    cancelModerationHold();
    if (actionMenuTarget?.fromHistory) closeActionMenu(false);
  }, { passive: true });
  installModerationGestures(layer, false);
  installModerationGestures(historyList, true);
  historyList.addEventListener('click', event => {
    if (event.target.closest('[data-community-vote-count]')) return;
    const row = event.target.closest('.danmaku-history-item');
    const item = row && historyRows.get(row.dataset.messageId)?.item;
    if (item) void likeMessage(item);
  });

  function retryMessage(response, code) {
    if (code === 'mirror_control_only') return t('widgets.danmaku.mirrorOnly', '应急管理请通过备用机执行。');
    if (code === 'nickname') return member ? t('widgets.danmaku.nicknameAccountRejected', '这个昵称不能使用，请到控制台修改。') : t('widgets.danmaku.nicknameGuestRejected', '这个昵称不能使用，请在弹幕设置里修改。');
    if (response.status === 400) return t('widgets.danmaku.sendInvalid', '内容格式不正确，请修改后再试。');
    if (response.status === 403) return forbiddenMessage();
    if (response.status === 409 && code === 'stale_request') return t('widgets.danmaku.sendStale', '这次发送已失效，请再按一次发送。');
    if (response.status === 429) {
      if (signedIn()) return t('widgets.danmaku.sendBusy', '弹幕现在太忙，请稍后再试。');
      if (code === 'duplicate') return t('widgets.danmaku.sendDuplicate', '这条弹幕刚发过，请稍后再试。');
      return remainingSendCooldown() > 0 ? t('widgets.danmaku.sendWait', '发送太频繁，请等倒计时结束。') : t('widgets.danmaku.sendRate', '发送太频繁，请稍后再试。');
    }
    if (response.status >= 500) return t('widgets.danmaku.sendUnavailable', '弹幕暂时不可用，请稍后再试。');
    return t('widgets.danmaku.sendFailed', '发送失败（{status}），请稍后重试。', { status: response.status });
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (composing || suppressImeSubmit || sendController || nextAvailability === false || remainingSendCooldown() > 0) return;
    if (!mirrorPrimaryUnavailable && currentMute.muted && !signedIn()) return;

    const draft = input.value;
    const text = draft.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (!text) {
      setStatus(t('widgets.danmaku.sendEmpty', '先写点内容再发送。'), 'error');
      input.focus({ preventScroll: true });
      return;
    }
    if (codePointCount(text) > MAX_CODE_POINTS) {
      setStatus(t('widgets.danmaku.sendMax', '最多 {max} 个字，请删减后再发送。', { max: MAX_CODE_POINTS }), 'error');
      input.focus({ preventScroll: true });
      return;
    }

    setStatus(t('widgets.danmaku.sending', '正在发送…'));
    sendController = new AbortController();
    form.dataset.mirrorSendInProgress = 'true';
    updateSend();
    const timeout = setTimeout(() => sendController?.abort(), 12000);
    let viaConsole = false;
    try {
      await refreshAdmin();
      if ((loginRequired && !mirrorPrimaryUnavailable) || (!mirrorPrimaryUnavailable && currentMute.muted && !(signedIn() && gold))) {
        setStatus(loginRequired && !mirrorPrimaryUnavailable ? t('widgets.danmaku.signInAgain', '请重新登录后再发送。') : muteMessage(), 'error');
        return;
      }
      if (nextAvailability === false || remainingSendCooldown() > 0) return;
      const consoleSend = signedIn();
      viaConsole = consoleSend;
      const senior = consoleSend && gold;
      const nonce = await requestDanmakuNonce(
        consoleSend ? adminEndpoint('nonce?action=send') : '/api/danmaku/nonce', sendController.signal, consoleSend,
      );
      if (!nonce || nextAvailability === false) return;
      const style = {};
      if (appearance.groupTag !== undefined) style.groupTag = appearance.groupTag;
      if (!consoleSend && appearance.nickname) style.nickname = appearance.nickname;
      const sender = consoleSend ? member : null;
      if (consoleSend) {
        style.color = preferredColor();
        const rankTag = preferredRankTag();
        if (rankTag !== undefined) style.rankTag = rankTag;
      }
      const response = await fetch(consoleSend ? adminEndpoint('messages') : '/api/danmaku', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: consoleSend ? 'include' : 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        body: JSON.stringify({ text, nonce, ...style }),
        signal: sendController.signal,
      });
      const localOnly = response.status === 422;
      const posted = response.status === 201;
      if (!posted && !localOnly) {
        if (!consoleSend && response.status === 429) readSendCooldown(response, 'Retry-After');
        if (consoleSend && response.status === 401) {
          expireAdmin();
          return;
        }
        const problem = await response.json().catch(() => null);
        if (problem?.code === 'closed') {
          setAvailability(false);
          return;
        }
        if (problem?.code === 'muted') {
          setMute({ muted: true, expiresAt: problem.expiresAt, source: problem.source }, true);
          return;
        }
        if (response.status === 403 && problem?.code === 'rank_tag_forbidden') {
          const rejected = style.rankTag;
          const restoreAutomatic = rejected !== undefined && appearance.rankTag === rejected;
          if (restoreAutomatic) {
            appearance.rankTag = undefined;
            if (rankTagDraft === rejected) rankTagDraft = undefined;
            storageWrite(JSON.stringify(appearance), APPEARANCE_KEY);
            if (!options.inert) renderRankTagOptions();
          }
          setStatus(restoreAutomatic
            ? t('widgets.danmaku.rankReset', '所选身份标签已不可用，已恢复自动。请重发，或在「样式」中重选。')
            : t('widgets.danmaku.rankForbidden', '所选身份标签不可用。请在「样式」中检查后再发送。'), 'error');
          void refreshAdmin(true);
          return;
        }
        setStatus(retryMessage(response, problem?.code), 'error');
        return;
      }

      if (!consoleSend) readSendCooldown(response, 'X-Danmaku-Cooldown');
      const reply = await response.json().catch(() => null);
      const item = localOnly
        ? parseItem({ id: 'local-echo:' + ++localEchoId, text, createdAt: new Date().toISOString(), admin: senior, staff: sender?.staff, member: Boolean(sender), sponsor: sender?.sponsor === true, ...style, groupTag: reply?.anonymous === true ? reply.groupTag : style.groupTag, nickname: sender?.nickname ?? style.nickname, anonymous: reply?.anonymous === true })
        : parseItem(reply);
      if (posted && !senior) {
        hasSent = true;
        connectStream();
      }
      if (item) {
        markOwnItem(item);
        handleLiveItem(item, localOnly);
      }
      if (input.value === draft) input.value = '';
      updateCount();
      if (nextAvailability !== false) setStatus(item ? t('widgets.danmaku.sent', '已发送。') : t('widgets.danmaku.sentNotDisplayed', '已提交，但暂时无法显示这条弹幕。'), item ? 'success' : '');
    } catch (error) {
      setStatus(sendFailureMessage(error, viaConsole), 'error');
    } finally {
      clearTimeout(timeout);
      sendController = undefined;
      delete form.dataset.mirrorSendInProgress;
      updateSend();
    }
  });

  window.addEventListener('mirror-primary-availability', event => {
    if (typeof event.detail?.available !== 'boolean') return;
    const unavailable = !event.detail.available;
    if (mirrorPrimaryUnavailable === unavailable) return;
    mirrorPrimaryUnavailable = unavailable;
    restartDrawerHistory();
    if (unavailable) setPostingIdentity(null, false, false);
    else void refreshAdmin(true);
    renderAccountOptions();
    renderAppearanceOptions();
    updateInputGate();
    updateSend();
  });

  updateCount();
  void refreshAdmin();
  syncComposerViewport();
  connectStream();
})();
