(async () => {
  'use strict';

  if (window.AdminAccount) {
    await window.AdminAccount.ready;
    if (!window.AdminAccount.canModerate) return;
  }

  const byId = (id) => document.getElementById(id);
  const danmakuView = byId('danmaku-view');
  const canConfigure = !window.AdminAccount || window.AdminAccount.canEdit;
  const refreshButton = byId('danmaku-refresh');
  const feedback = byId('danmaku-feedback');
  const status = byId('danmaku-status');
  const loginLink = byId('danmaku-login');
  const historyStatus = byId('danmaku-history-status');
  const historyMoreButton = byId('danmaku-history-more-button');
  const settingsForm = byId('danmaku-settings-form');
  const settingsFeedback = byId('danmaku-settings-feedback');
  const settingsStatus = byId('danmaku-settings-status');
  const settingsState = byId('danmaku-settings-state');
  const settingsReload = byId('danmaku-settings-reload');
  const settingsSave = byId('danmaku-settings-save');
  const effectiveStatus = byId('danmaku-effective');
  const effectiveText = byId('danmaku-effective-text');
  const masterEnabled = byId('danmaku-master-enabled');
  const scheduleEnabled = byId('danmaku-schedule-enabled');
  const scheduleTimes = byId('danmaku-schedule-times');
  const closeAt = byId('danmaku-close-at');
  const openAt = byId('danmaku-open-at');
  const schedulePreview = byId('danmaku-schedule-preview');
  const scheduleError = byId('danmaku-schedule-error');
  const communityVoteThreshold = byId('danmaku-community-vote-threshold');
  const communityVoteThresholdError = byId('danmaku-community-vote-threshold-error');
  const ratePerMinute = byId('danmaku-rate-per-minute');
  const ratePerMinuteError = byId('danmaku-rate-per-minute-error');
  const rateMinInterval = byId('danmaku-rate-min-interval');
  const rateMinIntervalError = byId('danmaku-rate-min-interval-error');
  const scheduledForm = byId('danmaku-scheduled-form');
  const scheduledFeedback = byId('danmaku-scheduled-feedback');
  const scheduledStatus = byId('danmaku-scheduled-status');
  const scheduledState = byId('danmaku-scheduled-state');
  const scheduledSummary = byId('danmaku-scheduled-summary');
  const scheduledEnabled = byId('danmaku-scheduled-enabled');
  const scheduledInterval = byId('danmaku-scheduled-interval');
  const scheduledMessages = byId('danmaku-scheduled-messages');
  const scheduledCount = byId('danmaku-scheduled-count');
  const scheduledError = byId('danmaku-scheduled-error');
  const scheduledReload = byId('danmaku-scheduled-reload');
  const scheduledSave = byId('danmaku-scheduled-save');
  const tablist = byId('danmaku-tabs');
  const views = Object.fromEntries([
    ['mutes', '禁言记录'], ['messages', '近期弹幕'], ['history', '历史弹幕'], ['words', '违禁词'],
  ].map(([key, label]) => [key, {
    key, label, button: byId(`danmaku-tab-${key}`),
    panel: byId(`danmaku-panel-${key}`), list: byId(`danmaku-${key}`),
  }]));
  const allViews = Object.values(views);
  const wordQuery = byId('danmaku-word-query');
  const wordScope = byId('danmaku-word-scope');
  const wordTerm = byId('danmaku-word-term');
  const searchButton = byId('danmaku-word-search-button');
  const addButton = byId('danmaku-word-add-button');
  const pager = byId('danmaku-word-pager');
  const pageLabel = byId('danmaku-word-page');
  const previousPage = byId('danmaku-word-prev');
  const nextPage = byId('danmaku-word-next');
  const durationLabels = new Map([
    ['10m', '10 分钟'], ['30m', '30 分钟'], ['24h', '24 小时'], ['3d', '3 天'], ['7d', '7 天'],
    ['30d', '30 天'], ['180d', '180 天'], ['permanent', '永久'],
  ]);
  const DEFAULT_RATE_LIMIT = Object.freeze({ perMinute: 2, minIntervalSeconds: 5 });
  const DEFAULT_COMMUNITY_VOTE_THRESHOLD = 6;
  const dateFormat = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });

  let active = views.mutes;
  let reading = null;
  let writing = false;
  let sessionExpired = false;
  let settingsSaved = null;
  let settingsDraft = null;
  let settingsActive = null;
  const rateErrorVersions = new WeakMap();
  let settingsLoading = false;
  let settingsSaving = false;
  let scheduleVisibilityVersion = 0;
  let scheduledSaved = null;
  let scheduledDraft = null;
  let scheduledLoading = false;
  let scheduledSaving = false;
  let wordFilter = { query: '', scope: 'all', offset: 0 };
  let wordPage = null;
  let historyCursor = null;
  let historyHasMore = false;
  let historyLoadingMore = false;
  let historyRetryFailed = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function actionButton(text, accessibleName, danger = false) {
    const button = element('button', danger ? 'button danger' : 'button', text);
    button.type = 'button';
    button.setAttribute('aria-label', accessibleName);
    button.setAttribute('data-moderation-action', '');
    return button;
  }

  function setStatus(tone, message) {
    feedback.dataset.tone = tone;
    status.textContent = message;
    loginLink.hidden = !sessionExpired;
    if (tone === 'error' && !danmakuView.hidden) feedback.scrollIntoView({ block: 'nearest' });
  }

  function showError(error, action, notice = '') {
    const lead = notice ? `${notice} ` : '';
    if (error.status === 401) {
      sessionExpired = true;
      allViews.forEach(({ list }) => list.replaceChildren());
      active.list.append(element('li', 'danmaku-empty', '重新登录后可刷新列表。'));
      wordPage = null;
      pager.hidden = true;
      setStatus('error', `${lead}登录已过期，请重新登录后刷新。`);
      return;
    }
    setStatus('error', `${lead}${action}失败。${error.message}`);
  }

  const clockTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

  function isClockTime(value) {
    return typeof value === 'string' && clockTimePattern.test(value);
  }

  function copySettings(settings) {
    return {
      enabled: settings.enabled,
      schedule: {
        enabled: settings.schedule.enabled,
        closeAt: settings.schedule.closeAt,
        openAt: settings.schedule.openAt,
      },
      communityVoteThreshold: settings.communityVoteThreshold,
      rateLimit: {
        perMinute: settings.rateLimit.perMinute,
        minIntervalSeconds: settings.rateLimit.minIntervalSeconds,
      },
    };
  }

  function parseSettings(data) {
    const schedule = data?.schedule;
    const rateLimit = data?.rateLimit;
    const hasRateLimit = rateLimit !== undefined;
    const hasRatePerMinute = Boolean(rateLimit)
      && Object.prototype.hasOwnProperty.call(rateLimit, 'perMinute');
    const hasRateMinInterval = Boolean(rateLimit)
      && Object.prototype.hasOwnProperty.call(rateLimit, 'minIntervalSeconds');
    const hasCommunityVoteThreshold = Object.prototype.hasOwnProperty.call(data ?? {}, 'communityVoteThreshold');
    const perMinute = hasRatePerMinute ? rateLimit.perMinute : DEFAULT_RATE_LIMIT.perMinute;
    const minIntervalSeconds = hasRateMinInterval
      ? rateLimit.minIntervalSeconds : DEFAULT_RATE_LIMIT.minIntervalSeconds;
    const voteThreshold = hasCommunityVoteThreshold
      ? data.communityVoteThreshold : DEFAULT_COMMUNITY_VOTE_THRESHOLD;
    if (typeof data?.enabled !== 'boolean' || typeof data?.active !== 'boolean'
      || !schedule || typeof schedule !== 'object' || Array.isArray(schedule)
      || typeof schedule.enabled !== 'boolean'
      || !isClockTime(schedule.closeAt) || !isClockTime(schedule.openAt)
      || (schedule.enabled && schedule.closeAt === schedule.openAt)
      || (hasRateLimit && (!rateLimit || typeof rateLimit !== 'object' || Array.isArray(rateLimit)))
      || !Number.isInteger(perMinute) || perMinute < 1 || perMinute > 60
      || !Number.isInteger(minIntervalSeconds) || minIntervalSeconds < 0 || minIntervalSeconds > 60
      || !Number.isInteger(voteThreshold) || voteThreshold < 2 || voteThreshold > 20) {
      throw new Error('弹幕设置格式有误，请重新读取或联系管理员。');
    }
    return {
      settings: {
        enabled: data.enabled,
        schedule: {
          enabled: schedule.enabled,
          closeAt: schedule.closeAt,
          openAt: schedule.openAt,
        },
        communityVoteThreshold: voteThreshold,
        rateLimit: { perMinute, minIntervalSeconds },
      },
      active: data.active,
    };
  }

  function isSettingsDirty() {
    return Boolean(settingsDraft && settingsSaved
      && JSON.stringify(settingsDraft) !== JSON.stringify(settingsSaved));
  }

  function isScheduledDirty() {
    return Boolean(scheduledDraft && scheduledSaved
      && JSON.stringify(scheduledDraft) !== JSON.stringify(scheduledSaved));
  }

  function warnBeforeLeaving(event) {
    if (window.AdminShell?.leaveConfirmed) return;
    event.preventDefault();
    event.returnValue = '';
  }

  function updateDraftWarning() {
    if (isSettingsDirty() || isScheduledDirty()) window.addEventListener('beforeunload', warnBeforeLeaving);
    else window.removeEventListener('beforeunload', warnBeforeLeaving);
  }

  function updateSettingsState() {
    const label = settingsLoading ? '正在读取设置…'
      : settingsSaving ? '正在保存设置…'
        : !settingsSaved ? '尚未读取'
          : isSettingsDirty() ? '有未保存的修改' : '已同步';
    settingsState.textContent = label;
    settingsState.dataset.state = isSettingsDirty() ? 'draft' : 'normal';
    updateDraftWarning();
  }

  function setSettingsMessage(tone, message) {
    settingsFeedback.dataset.tone = tone;
    settingsStatus.textContent = message;
  }

  function parseScheduledConfig(data) {
    if (typeof data?.enabled !== 'boolean'
      || !Number.isInteger(data.intervalMinutes) || data.intervalMinutes < 1 || data.intervalMinutes > 1440
      || !Array.isArray(data.messages) || data.messages.length > 20
      || !data.messages.every((message) => typeof message === 'string' && [...message].length <= 60)
      || (data.enabled && data.messages.length < 1)) {
      throw new Error('自动管理员消息配置格式有误，请重新读取或联系管理员。');
    }
    return {
      enabled: data.enabled,
      intervalMinutes: data.intervalMinutes,
      messages: [...data.messages],
    };
  }

  function scheduledLinesFromInput() {
    return scheduledMessages.value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  }

  function scheduledConfigSummary(config) {
    const enabled = config.enabled ? '已启用' : '已停用';
    return `当前已保存：自动管理员消息${enabled} · 每 ${config.intervalMinutes} 分钟 · ${config.messages.length} 条按顺序轮播。`;
  }

  function setScheduledMessage(tone, message) {
    scheduledFeedback.dataset.tone = tone;
    scheduledStatus.textContent = message;
  }

  function updateScheduledState() {
    const label = scheduledLoading ? '正在读取配置…'
      : scheduledSaving ? '正在保存配置…'
        : !scheduledSaved ? '尚未读取'
          : isScheduledDirty() ? '有未保存的修改' : '已同步';
    scheduledState.textContent = label;
    scheduledState.dataset.state = isScheduledDirty() ? 'draft' : 'normal';
    updateDraftWarning();
  }

  function updateScheduledCount() {
    const lines = scheduledLinesFromInput();
    const longest = lines.reduce((max, line) => Math.max(max, [...line].length), 0);
    scheduledCount.textContent = `${lines.length} / 20 条 · 最长 ${longest} / 60 字`;
    scheduledCount.dataset.invalid = String(lines.length > 20 || longest > 60);
  }

  function syncScheduledForm() {
    if (!scheduledDraft) return;
    scheduledEnabled.checked = scheduledDraft.enabled;
    scheduledInterval.value = String(scheduledDraft.intervalMinutes);
    scheduledMessages.value = scheduledDraft.messages.join('\n');
    updateScheduledCount();
  }

  function acceptScheduled(data) {
    const config = parseScheduledConfig(data);
    scheduledSaved = { ...config, messages: [...config.messages] };
    scheduledDraft = { ...config, messages: [...config.messages] };
    sessionExpired = false;
    scheduledError.hidden = true;
    scheduledError.textContent = '';
    syncScheduledForm();
    scheduledSummary.textContent = scheduledConfigSummary(config);
  }

  function updateEffectiveStatus() {
    if (!settingsSaved || typeof settingsActive !== 'boolean') {
      effectiveStatus.dataset.state = 'unknown';
      effectiveText.textContent = '当前生效状态尚未读取';
      return;
    }
    effectiveStatus.dataset.state = settingsActive ? 'on' : 'off';
    if (settingsActive) {
      effectiveText.textContent = '当前生效：弹幕已开启';
    } else if (!settingsSaved.enabled) {
      effectiveText.textContent = '当前生效：弹幕已关闭 · 手动总开关优先';
    } else if (settingsSaved.schedule.enabled) {
      effectiveText.textContent = '当前生效：弹幕已关闭 · 每日定时计划';
    } else {
      effectiveText.textContent = '当前生效：弹幕已关闭';
    }
  }

  function setScheduleFieldsVisible(visible) {
    const version = ++scheduleVisibilityVersion;
    if (visible) {
      scheduleTimes.hidden = false;
      scheduleTimes.classList.remove('is-leaving');
      return;
    }
    if (scheduleTimes.hidden) return;
    scheduleTimes.classList.add('is-leaving');
    const animations = scheduleTimes.getAnimations?.() || [];
    Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (version !== scheduleVisibilityVersion || settingsDraft?.schedule.enabled) return;
      scheduleTimes.hidden = true;
      scheduleTimes.classList.remove('is-leaving');
    });
  }

  function clearScheduleError() {
    scheduleError.hidden = true;
    scheduleError.textContent = '';
    closeAt.removeAttribute('aria-invalid');
    openAt.removeAttribute('aria-invalid');
  }

  function setScheduleError(message) {
    scheduleError.textContent = message;
    scheduleError.hidden = false;
    closeAt.setAttribute('aria-invalid', 'true');
    openAt.setAttribute('aria-invalid', 'true');
  }

  function setRateLimitError(input, error, message) {
    rateErrorVersions.set(error, (rateErrorVersions.get(error) || 0) + 1);
    error.classList.remove('is-leaving');
    error.textContent = message;
    error.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  }

  function clearRateLimitError(input, error) {
    input.removeAttribute('aria-invalid');
    const version = (rateErrorVersions.get(error) || 0) + 1;
    rateErrorVersions.set(error, version);
    if (error.hidden) {
      error.textContent = '';
      error.classList.remove('is-leaving');
      return;
    }
    error.classList.add('is-leaving');
    const animations = error.getAnimations?.() || [];
    Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (rateErrorVersions.get(error) !== version) return;
      error.hidden = true;
      error.textContent = '';
      error.classList.remove('is-leaving');
    });
  }

  function clearRateLimitErrors() {
    clearRateLimitError(communityVoteThreshold, communityVoteThresholdError);
    clearRateLimitError(ratePerMinute, ratePerMinuteError);
    clearRateLimitError(rateMinInterval, rateMinIntervalError);
  }

  function updateSchedulePreview() {
    if (!settingsDraft) {
      schedulePreview.textContent = '读取计划后显示每日执行时间。';
      return;
    }
    const { enabled, closeAt: closing, openAt: opening } = settingsDraft.schedule;
    if (!enabled) {
      schedulePreview.textContent = '每日计划已停用。重新启用后可编辑关闭和重开时刻。';
      return;
    }
    if (!isClockTime(closing) || !isClockTime(opening)) {
      schedulePreview.textContent = '请填写有效的 24 小时时间。';
      return;
    }
    if (closing === opening) {
      schedulePreview.textContent = '关闭与重新开启时间不能相同。';
      return;
    }
    const crossesMidnight = closing > opening;
    schedulePreview.textContent = crossesMidnight
      ? `每天 ${closing} 关闭，次日 ${opening} 重新开启（跨越午夜，北京时间）。`
      : `每天 ${closing} 关闭，并于 ${opening} 重新开启（北京时间）。`;
  }

  function syncSettingsForm() {
    if (!settingsDraft) return;
    masterEnabled.checked = settingsDraft.enabled;
    scheduleEnabled.checked = settingsDraft.schedule.enabled;
    closeAt.value = settingsDraft.schedule.closeAt;
    openAt.value = settingsDraft.schedule.openAt;
    communityVoteThreshold.value = String(settingsDraft.communityVoteThreshold);
    ratePerMinute.value = String(settingsDraft.rateLimit.perMinute);
    rateMinInterval.value = String(settingsDraft.rateLimit.minIntervalSeconds);
    setScheduleFieldsVisible(settingsDraft.schedule.enabled);
    updateSchedulePreview();
  }

  function acceptSettings(data) {
    const parsed = parseSettings(data);
    settingsSaved = copySettings(parsed.settings);
    settingsDraft = copySettings(parsed.settings);
    settingsActive = parsed.active;
    sessionExpired = false;
    clearScheduleError();
    clearRateLimitErrors();
    syncSettingsForm();
    updateEffectiveStatus();
  }

  function updateControls() {
    const busy = Boolean(reading || writing || settingsLoading || settingsSaving || scheduledLoading || scheduledSaving || historyLoadingMore);
    refreshButton.setAttribute('aria-disabled', String(busy));
    historyMoreButton.disabled = busy || sessionExpired;
    const mutationBusy = writing || settingsSaving || scheduledSaving;
    allViews.forEach(({ button }) => button.setAttribute('aria-disabled', String(mutationBusy)));
    searchButton.setAttribute('aria-disabled', String(mutationBusy));
    wordScope.disabled = mutationBusy;
    addButton.setAttribute('aria-disabled', String(busy || sessionExpired));
    previousPage.setAttribute('aria-disabled', String(busy || !wordPage?.offset));
    nextPage.setAttribute('aria-disabled', String(busy || !wordPage || wordPage.offset + wordPage.limit >= wordPage.total));
    for (const button of active.list.querySelectorAll('[data-moderation-action]')) {
      button.setAttribute('aria-disabled', String(busy || sessionExpired));
    }
    for (const list of [views.messages.list, views.history.list]) {
      for (const form of list.querySelectorAll('.danmaku-mute-form')) form.refreshMuteDuration?.();
    }
    masterEnabled.disabled = !settingsSaved || busy || sessionExpired;
    scheduleEnabled.disabled = !settingsSaved || busy || sessionExpired;
    closeAt.disabled = !settingsSaved || !settingsDraft?.schedule.enabled || busy || sessionExpired;
    openAt.disabled = !settingsSaved || !settingsDraft?.schedule.enabled || busy || sessionExpired;
    communityVoteThreshold.disabled = !settingsSaved || busy || sessionExpired;
    ratePerMinute.disabled = !settingsSaved || busy || sessionExpired;
    rateMinInterval.disabled = !settingsSaved || busy || sessionExpired;
    settingsReload.disabled = settingsLoading || settingsSaving;
    settingsSave.disabled = busy || !settingsSaved || !isSettingsDirty() || sessionExpired;
    scheduledEnabled.disabled = !scheduledSaved || busy || sessionExpired;
    scheduledInterval.disabled = !scheduledSaved || busy || sessionExpired;
    scheduledMessages.disabled = !scheduledSaved || busy || sessionExpired;
    scheduledReload.disabled = scheduledLoading || scheduledSaving;
    scheduledSave.disabled = busy || !scheduledSaved || !isScheduledDirty() || sessionExpired;
    updateSettingsState();
    updateScheduledState();
  }

  async function request(path, { method = 'GET', body, signal } = {}) {
    const headers = { Accept: 'application/json' };
    const options = { method, headers, signal, mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(`/api/admin/danmaku/${path}`, options);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('无法连接后台，请稍后重试。');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(typeof data?.error === 'string' ? data.error : `请求失败（HTTP ${response.status}）。`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function dateElement(value, prefix = '') {
    if (value === null) return element('span', '', `${prefix}永久`);
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(parsed)) return element('span', '', `${prefix}时间未知`);
    const time = element('time', '', `${prefix}${dateFormat.format(parsed)}（北京时间）`);
    time.dateTime = value;
    return time;
  }

  function messageText(text) {
    const message = element('p', 'danmaku-message', text);
    message.dir = 'auto';
    return message;
  }

  function hasId(record) {
    return typeof record?.id === 'string' || typeof record?.id === 'number';
  }

  function isMuteRecord(record) {
    return hasId(record) && typeof record.duration === 'string'
      && (typeof record.expiresAt === 'string' || record.expiresAt === null)
      && typeof record.message?.text === 'string';
  }

  function durationLabel(duration) {
    if (durationLabels.has(duration)) return durationLabels.get(duration);
    const hours = typeof duration === 'string' && /^(\d+)h$/u.exec(duration);
    if (hours && Number(hours[1]) >= 1 && Number(hours[1]) <= 4320) return `${hours[1]} 小时`;
    const days = typeof duration === 'string' && /^(\d+)d$/u.exec(duration);
    if (days && Number(days[1]) >= 1 && Number(days[1]) <= 180) return `${days[1]} 天`;
    return '期限未知';
  }

  function muteRow(record) {
    const item = element('li', 'danmaku-row');
    const meta = element('div', 'danmaku-meta');
    meta.append(
      element('span', 'danmaku-duration', durationLabel(record.duration)),
      dateElement(record.expiresAt, '解禁时间：'),
    );
    const unmute = actionButton('解除禁言', `解除禁言：${record.message.text.slice(0, 60)}`, true);
    unmute.classList.add('danmaku-unmute');
    unmute.addEventListener('click', () => save('解除禁言', unmute, item, async () => {
      const result = await request(`mutes/${encodeURIComponent(String(record.id))}`, { method: 'DELETE' });
      if (result?.removed !== true) throw new Error('服务器未确认解除禁言。');
      return '已解除禁言。';
    }, { removeRow: true }));
    item.append(element('p', 'danmaku-message-label', '被禁言的原消息'), messageText(record.message.text), meta, unmute);
    return item;
  }

  function messageRow(record) {
    const item = element('li', 'danmaku-row danmaku-recent-row');
    const content = element('div');
    const meta = element('div', 'danmaku-meta');
    meta.append(dateElement(record.createdAt));
    content.append(messageText(record.text), meta);
    item.append(content);
    if (record.kind === 'moderation') {
      item.classList.add('danmaku-moderation-row');
      meta.prepend(element('span', 'danmaku-moderation-badge', '管理事件'));
      return item;
    }
    if (Number.isInteger(record.groupTag) && record.groupTag >= 1 && record.groupTag <= 8) {
      const groupTag = element('span', 'danmaku-group-tag', `${record.groupTag}群`);
      groupTag.dataset.groupTag = String(record.groupTag);
      meta.prepend(groupTag);
    }
    if (record.admin === true) {
      item.dataset.admin = 'true';
      meta.prepend(element('span', 'danmaku-admin-badge', '管理员'));
      return item;
    }

    const form = element('form', 'danmaku-mute-form');
    const choices = element('fieldset', 'danmaku-mute-choices');
    choices.append(element('legend', '', '禁言时长'));
    const presetChoice = element('input');
    presetChoice.type = 'radio';
    presetChoice.name = `mute-duration-${record.id}`;
    presetChoice.value = 'preset';
    const durations = element('select');
    durations.setAttribute('aria-label', '预设禁言时长');
    const placeholder = element('option', '', '选择预设时长');
    placeholder.value = '';
    durations.append(placeholder);
    for (const [value, label] of durationLabels) {
      const option = element('option', '', label);
      option.value = value;
      durations.append(option);
    }
    const presetLabel = element('label', 'danmaku-mute-choice');
    presetLabel.append(presetChoice, element('span', '', '预设'), durations);

    const hoursChoice = element('input');
    hoursChoice.type = 'radio';
    hoursChoice.name = presetChoice.name;
    hoursChoice.value = 'hours';
    const hours = element('input');
    hours.type = 'number';
    hours.min = '1';
    hours.max = '4320';
    hours.step = '1';
    hours.inputMode = 'numeric';
    hours.setAttribute('aria-label', '自定义禁言小时数，1 到 4320 的整数');
    const hoursLabel = element('label', 'danmaku-mute-choice');
    hoursLabel.append(hoursChoice, element('span', '', '小时'), hours);

    const daysChoice = element('input');
    daysChoice.type = 'radio';
    daysChoice.name = presetChoice.name;
    daysChoice.value = 'days';
    const days = element('input');
    days.type = 'number';
    days.min = '1';
    days.max = '180';
    days.step = '1';
    days.inputMode = 'numeric';
    days.setAttribute('aria-label', '自定义禁言天数，1 到 180 的整数');
    const daysLabel = element('label', 'danmaku-mute-choice');
    daysLabel.append(daysChoice, element('span', '', '天'), days);

    const validation = element('p', 'danmaku-mute-validation', '请选择预设时长，或填写小时 / 天数。');
    validation.setAttribute('aria-live', 'polite');
    const mute = actionButton('确认', `确认禁言这条弹幕的发送者：${record.text.slice(0, 60)}`, true);
    mute.classList.add('danmaku-mute-confirm');
    const actions = element('div', 'danmaku-mute-actions');
    actions.append(mute);
    choices.append(presetLabel, hoursLabel, daysLabel);
    form.append(choices, validation, actions);

    function selectedDuration() {
      if (presetChoice.checked) return durationLabels.has(durations.value) ? durations.value : null;
      if (hoursChoice.checked) {
        const value = hours.value;
        return /^\d+$/u.test(value) && Number(value) >= 1 && Number(value) <= 4320 ? `${Number(value)}h` : null;
      }
      if (daysChoice.checked) {
        const value = days.value;
        return /^\d+$/u.test(value) && Number(value) >= 1 && Number(value) <= 180 ? `${Number(value)}d` : null;
      }
      return null;
    }

    function updateDurationChoice() {
      const duration = selectedDuration();
      mute.disabled = !duration || Boolean(writing || settingsSaving || scheduledSaving || sessionExpired);
      validation.textContent = duration ? `确认时长：${durationLabel(duration)}。` : presetChoice.checked
        ? '请选择预设时长。' : hoursChoice.checked
          ? '请输入 1–4320 之间的整数小时。' : daysChoice.checked
            ? '请输入 1–180 之间的整数天。' : '请选择预设时长，或填写小时 / 天数。';
      for (const input of [durations, hours, days, presetChoice, hoursChoice, daysChoice]) {
        input.disabled = Boolean(writing || settingsSaving || scheduledSaving || sessionExpired);
      }
    }

    form.refreshMuteDuration = updateDurationChoice;

    for (const input of [presetChoice, hoursChoice, daysChoice]) {
      input.addEventListener('change', updateDurationChoice);
    }
    durations.addEventListener('change', () => {
      presetChoice.checked = true;
      updateDurationChoice();
    });
    hours.addEventListener('input', () => {
      hoursChoice.checked = true;
      updateDurationChoice();
    });
    days.addEventListener('input', () => {
      daysChoice.checked = true;
      updateDurationChoice();
    });
    form.addEventListener('submit', (event) => event.preventDefault());
    mute.addEventListener('click', () => {
      const duration = selectedDuration();
      if (!duration || writing || mute.disabled) return;
      save('禁言', mute, item, async () => {
        const nonceResponse = await request('nonce?action=mute');
        if (typeof nonceResponse?.nonce !== 'string' || nonceResponse.nonce.length === 0) {
          throw new Error('服务器未提供禁言操作凭据。');
        }
        const data = await request('mutes', {
          method: 'POST',
          body: { nonce: nonceResponse.nonce, messageId: record.id, duration },
        });
        if (!isMuteRecord(data?.mute)) throw new Error('服务器未确认禁言。');
        return duration === 'permanent' ? '已永久禁言。' : `已禁言 ${durationLabel(duration)}。`;
      }, { removeRow: true });
    });
    item.append(form);
    updateDurationChoice();
    return item;
  }

  function historyRow(record) {
    const item = messageRow(record);
    const identity = element('span', 'danmaku-history-identity');
    if (record.member === true) {
      const nickname = typeof record.nickname === 'string' ? record.nickname.trim() : '';
      identity.textContent = nickname || '已注册用户';
    } else if (record.kind === 'moderation' || record.admin) {
      identity.textContent = record.nickname || '系统';
    } else {
      const ip = typeof record.ip === 'string' ? record.ip : '';
      identity.textContent = ip || '访客';
    }
    item.querySelector('.danmaku-meta')?.prepend(identity);
    return item;
  }

  function isHistoryPage(data) {
    return Array.isArray(data?.messages) && data.messages.length <= 100
      && data.messages.every((record) => hasId(record) && typeof record.text === 'string'
        && typeof record.createdAt === 'string')
      && (data.nextCursor === null || typeof data.nextCursor === 'string')
      && (!data.hasMore || typeof data.nextCursor === 'string')
      && typeof data.hasMore === 'boolean' && Number.isInteger(data.retentionDays);
  }

  async function getHistoryPage(cursor, signal) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const data = await request(`history${query}`, { signal });
    if (!isHistoryPage(data)) throw new Error('服务器返回的历史弹幕格式有误。');
    return data;
  }

  function isWord(entry) {
    return typeof entry?.term === 'string' && (entry.source === 'builtin' || entry.source === 'custom')
      && typeof entry.enabled === 'boolean';
  }

  async function addWord(term) {
    const entry = await request('words', { method: 'POST', body: { term } });
    if (!isWord(entry) || !entry.enabled) throw new Error('服务器未确认启用词条。');
    return `已${entry.source === 'builtin' ? '恢复' : '添加'}「${entry.term}」。`;
  }

  function wordRow(entry) {
    const item = element('li', 'danmaku-row danmaku-word-row');
    const builtin = entry.source === 'builtin';
    const name = builtin ? '内置' : '自定义';
    const content = element('div');
    content.append(element('bdi', 'danmaku-word-term', entry.term), element('p', 'danmaku-meta', `${name} · ${entry.enabled ? '启用中' : '已停用'}`));
    const verb = entry.enabled ? (builtin ? '停用' : '删除') : '恢复';
    const button = actionButton(verb, `${verb}词条：${entry.term}`, !builtin && entry.enabled);
    button.addEventListener('click', () => save(`${verb}词条`, button, item, async () => {
      if (!entry.enabled) return addWord(entry.term);
      const result = await request('words', { method: 'DELETE', body: { term: entry.term } });
      if (result?.removed !== true) throw new Error(`服务器未确认${verb}词条。`);
      return `已${verb}「${entry.term}」。`;
    }, { removeRow: !builtin || (!entry.enabled && wordFilter.scope === 'disabled') }));
    item.append(content, button);
    return item;
  }

  async function getWordPage(signal) {
    const params = new URLSearchParams({ ...wordFilter, offset: String(wordFilter.offset) });
    async function get() {
      const page = await request(`words?${params}`, { signal });
      if (!Array.isArray(page?.items) || !page.items.every(isWord)
        || !Number.isSafeInteger(page.total) || page.total < 0
        || !Number.isSafeInteger(page.offset) || page.offset < 0
        || !Number.isSafeInteger(page.limit) || page.limit < 1) {
        throw new Error('词库数据格式有误。');
      }
      return page;
    }
    const page = await get();
    if (page.offset === 0 || page.offset < page.total) return page;
    // Removing the last item on a page can make its offset fall outside the results.
    const lastOffset = Math.floor(Math.max(0, page.total - 1) / page.limit) * page.limit;
    params.set('offset', String(lastOffset));
    return get();
  }

  async function getRows(view, signal) {
    if (view === views.words) {
      const page = await getWordPage(signal);
      const last = Math.min(page.offset + page.items.length, page.total);
      const count = page.items.length ? `共 ${page.total} 条 · 第 ${page.offset + 1}–${last} 条` : `共 ${page.total} 条`;
      return { rows: page.items.map(wordRow), page, count, empty: '没有符合条件的词条。' };
    }
    if (view === views.history) {
      const page = await getHistoryPage(null, signal);
      return {
        rows: page.messages.map(historyRow), historyPage: page,
        count: `已读取 ${page.messages.length} 条历史弹幕；保留 ${page.retentionDays} 天。`,
        empty: '保留期内没有历史弹幕。',
      };
    }

    const data = await request(view.key, { signal });
    if (view === views.mutes && Array.isArray(data?.mutes) && data.mutes.every(isMuteRecord)) {
      return { rows: data.mutes.map(muteRow), count: `有 ${data.mutes.length} 条生效中的禁言。`, empty: '目前没有生效中的禁言。' };
    }
    if (view === views.messages && Array.isArray(data?.messages) && data.messages.every((record) => (
      hasId(record) && typeof record.text === 'string' && typeof record.createdAt === 'string'
    ))) {
      return { rows: data.messages.map(messageRow), count: `有 ${data.messages.length} 条近期弹幕。`, empty: '目前没有可管理的近期弹幕。' };
    }
    throw new Error('服务器返回的列表格式有误。');
  }

  // Reads only replace their own form and can overlap mutations in another panel.
  async function loadSettings() {
    if (settingsLoading || settingsSaving) return;
    settingsLoading = true;
    setSettingsMessage('neutral', '正在读取弹幕设置…');
    updateControls();
    try {
      acceptSettings(await request('settings'));
      setSettingsMessage('neutral', `设置已读取。${effectiveText.textContent}`);
    } catch (error) {
      setSettingsMessage('error', `读取设置失败。${error.message}`);
      showError(error, '读取弹幕设置');
    } finally {
      settingsLoading = false;
      updateControls();
    }
  }

  async function loadScheduledConfig() {
    if (scheduledLoading || scheduledSaving) return;
    scheduledLoading = true;
    setScheduledMessage('neutral', '正在读取自动管理员消息配置…');
    updateControls();
    try {
      acceptScheduled(await request('scheduled'));
      setScheduledMessage('neutral', `配置已读取。${scheduledConfigSummary(scheduledSaved)}`);
    } catch (error) {
      setScheduledMessage('error', `读取轮播配置失败。${error.message}`);
      showError(error, '读取自动管理员消息配置');
    } finally {
      scheduledLoading = false;
      updateControls();
    }
  }

  function clearScheduledError() {
    scheduledError.hidden = true;
    scheduledError.textContent = '';
  }

  function setScheduledError(message) {
    scheduledError.textContent = message;
    scheduledError.hidden = false;
  }

  function updateScheduledDraft() {
    if (!scheduledDraft || scheduledLoading || scheduledSaving) return;
    scheduledDraft.enabled = scheduledEnabled.checked;
    scheduledDraft.intervalMinutes = scheduledInterval.value === '' ? null : scheduledInterval.valueAsNumber;
    scheduledDraft.messages = scheduledLinesFromInput();
    clearScheduledError();
    updateScheduledCount();
    updateControls();
  }

  function scheduledPayloadFromForm() {
    const intervalMinutes = scheduledInterval.valueAsNumber;
    const messages = scheduledLinesFromInput();
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
      setScheduledError('发送间隔必须是 1 到 1440 之间的整数分钟。');
      scheduledInterval.focus();
      return null;
    }
    if (messages.length > 20) {
      setScheduledError('轮播消息最多 20 条，请调整后再保存。');
      scheduledMessages.focus();
      return null;
    }
    const tooLong = messages.findIndex((message) => [...message].length > 60);
    if (tooLong >= 0) {
      setScheduledError(`第 ${tooLong + 1} 条消息超过 60 个字符，请缩短后再保存。`);
      scheduledMessages.focus();
      return null;
    }
    if (scheduledEnabled.checked && messages.length === 0) {
      setScheduledError('启用自动轮播时至少需要一条消息。');
      scheduledMessages.focus();
      return null;
    }
    clearScheduledError();
    return { enabled: scheduledEnabled.checked, intervalMinutes, messages };
  }

  async function saveScheduledConfig(event) {
    event.preventDefault();
    if (reading || writing || settingsLoading || settingsSaving || scheduledLoading || scheduledSaving || sessionExpired || !scheduledDraft) return;

    scheduledDraft = {
      enabled: scheduledEnabled.checked,
      intervalMinutes: scheduledInterval.value === '' ? null : scheduledInterval.valueAsNumber,
      messages: scheduledLinesFromInput(),
    };
    const payload = scheduledPayloadFromForm();
    if (!payload) return;

    scheduledSaving = true;
    setScheduledMessage('neutral', '正在保存自动管理员消息配置…');
    updateControls();
    try {
      acceptScheduled(await request('scheduled', { method: 'PUT', body: payload }));
      const currentConfig = scheduledConfigSummary(scheduledSaved);
      setScheduledMessage('success', `轮播配置已保存并生效。${currentConfig}`);
      setStatus('success', '自动管理员消息轮播配置已保存。');
    } catch (error) {
      setScheduledMessage('error', `保存轮播配置失败。${error.message}`);
      showError(error, '保存自动管理员消息配置');
      if (error.status === 401 && scheduledForm.contains(document.activeElement) && !danmakuView.hidden) loginLink.focus();
    } finally {
      scheduledSaving = false;
      updateControls();
    }
  }

  function validateSettingsDraft() {
    clearScheduleError();
    clearRateLimitErrors();
    if (!settingsDraft || !isClockTime(settingsDraft.schedule.closeAt) || !isClockTime(settingsDraft.schedule.openAt)) {
      setScheduleError('请填写有效的 24 小时时间。');
      (isClockTime(settingsDraft?.schedule.closeAt) ? openAt : closeAt).focus();
      return false;
    }
    if (settingsDraft.schedule.enabled && settingsDraft.schedule.closeAt === settingsDraft.schedule.openAt) {
      setScheduleError('每日关闭时间和重新开启时间不能相同。');
      openAt.focus();
      return false;
    }
    let firstInvalid = null;
    if (!Number.isInteger(settingsDraft.rateLimit.perMinute)
      || settingsDraft.rateLimit.perMinute < 1 || settingsDraft.rateLimit.perMinute > 60) {
      setRateLimitError(ratePerMinute, ratePerMinuteError, '每 60 秒最多发送条数必须是 1–60 的整数。');
      firstInvalid = ratePerMinute;
    }
    if (!Number.isInteger(settingsDraft.rateLimit.minIntervalSeconds)
      || settingsDraft.rateLimit.minIntervalSeconds < 0 || settingsDraft.rateLimit.minIntervalSeconds > 60) {
      setRateLimitError(rateMinInterval, rateMinIntervalError, '两条访客消息的最少间隔必须是 0–60 的整数。');
      firstInvalid ||= rateMinInterval;
    }
    if (!Number.isInteger(settingsDraft.communityVoteThreshold)
      || settingsDraft.communityVoteThreshold < 2 || settingsDraft.communityVoteThreshold > 20) {
      setRateLimitError(communityVoteThreshold, communityVoteThresholdError, '社区禁言所需票数必须是 2–20 的整数。');
      firstInvalid ||= communityVoteThreshold;
    }
    if (firstInvalid) {
      firstInvalid.focus();
      return false;
    }
    return true;
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (reading || writing || settingsLoading || settingsSaving || scheduledLoading || scheduledSaving || sessionExpired || !settingsDraft) return;

    settingsDraft = {
      enabled: masterEnabled.checked,
      schedule: {
        enabled: scheduleEnabled.checked,
        closeAt: closeAt.value,
        openAt: openAt.value,
      },
      communityVoteThreshold: communityVoteThreshold.valueAsNumber,
      rateLimit: {
        perMinute: ratePerMinute.valueAsNumber,
        minIntervalSeconds: rateMinInterval.valueAsNumber,
      },
    };
    updateSchedulePreview();
    if (!validateSettingsDraft()) return;

    const payload = copySettings(settingsDraft);
    settingsSaving = true;
    setSettingsMessage('neutral', '正在保存弹幕设置…');
    updateControls();
    try {
      acceptSettings(await request('settings', { method: 'PUT', body: payload }));
      const currentStatus = effectiveText.textContent;
      setSettingsMessage('success', `设置已保存。${currentStatus}`);
      setStatus('success', '弹幕设置和访客发送限制已保存。');
    } catch (error) {
      setSettingsMessage('error', `保存设置失败。${error.message}`);
      showError(error, '保存弹幕设置');
      if (error.status === 401 && settingsForm.contains(document.activeElement) && !danmakuView.hidden) loginLink.focus();
    } finally {
      settingsSaving = false;
      updateControls();
    }
  }

  function updateSettingsDraft(event) {
    if (!settingsDraft || settingsLoading || settingsSaving) return;
    settingsDraft.enabled = masterEnabled.checked;
    settingsDraft.schedule.enabled = scheduleEnabled.checked;
    settingsDraft.schedule.closeAt = closeAt.value;
    settingsDraft.schedule.openAt = openAt.value;
    settingsDraft.communityVoteThreshold = communityVoteThreshold.valueAsNumber;
    settingsDraft.rateLimit.perMinute = ratePerMinute.valueAsNumber;
    settingsDraft.rateLimit.minIntervalSeconds = rateMinInterval.valueAsNumber;
    if (event?.target === masterEnabled || event?.target === scheduleEnabled
      || event?.target === closeAt || event?.target === openAt) clearScheduleError();
    if (event?.target === communityVoteThreshold) {
      clearRateLimitError(communityVoteThreshold, communityVoteThresholdError);
    }
    if (event?.target === ratePerMinute) clearRateLimitError(ratePerMinute, ratePerMinuteError);
    if (event?.target === rateMinInterval) clearRateLimitError(rateMinInterval, rateMinIntervalError);
    setScheduleFieldsVisible(settingsDraft.schedule.enabled);
    updateSchedulePreview();
    updateControls();
  }

  async function loadActive({ notice = '', row = null } = {}) {
    if (writing || settingsSaving || scheduledSaving || danmakuView.hidden) return;
    if (reading) {
      reading.controller.abort();
      reading.list.removeAttribute('aria-busy');
    }
    const view = active;
    const { label, list } = view;
    const current = { controller: new AbortController(), list };
    reading = current;
    list.setAttribute('aria-busy', 'true');
    if (!notice) {
      setStatus('neutral', `正在读取${label}…`);
      list.replaceChildren(element('li', 'danmaku-empty', '正在读取…'));
    }
    updateControls();

    try {
      const { rows, page, historyPage, empty, count } = await getRows(view, current.controller.signal);
      if (reading !== current) return;
      const moveFocus = row && row.contains(document.activeElement) && !danmakuView.hidden;
      const index = row ? [...list.children].indexOf(row) : -1;
      sessionExpired = false;
      if (page) {
        wordPage = page;
        wordFilter.offset = page.offset;
        pageLabel.textContent = count;
        pager.hidden = page.total === 0;
      }
      if (historyPage) {
        historyCursor = historyPage.nextCursor;
        historyHasMore = historyPage.hasMore;
        historyStatus.textContent = historyHasMore ? '还可继续加载更早记录。' : '已到历史记录末尾。';
        historyMoreButton.hidden = !historyHasMore;
        historyMoreButton.disabled = false;
        historyMoreButton.textContent = '加载更早弹幕';
      }
      list.replaceChildren(...(rows.length ? rows : [element('li', 'danmaku-empty', empty)]));
      setStatus(notice ? 'success' : 'neutral', notice || (rows.length ? count : empty));
      if (moveFocus) {
        const nextRow = rows[Math.min(index, rows.length - 1)];
        (nextRow?.querySelector('[data-moderation-action]') || (view === views.words ? wordQuery : refreshButton)).focus();
      }
    } catch (error) {
      if (reading !== current) return;
      const moveFocus = row && row.contains(document.activeElement) && !danmakuView.hidden;
      list.replaceChildren(element('li', 'danmaku-empty', `暂时无法显示${label}。`));
      if (view === views.words) {
        wordPage = null;
        pager.hidden = true;
      }
      if (view === views.history) {
        historyCursor = null;
        historyHasMore = false;
        historyStatus.textContent = '读取失败，可重试。';
        historyMoreButton.hidden = false;
        historyMoreButton.textContent = '重试读取历史弹幕';
        historyMoreButton.disabled = false;
      }
      showError(error, `读取${label}`, notice);
      if (moveFocus) (sessionExpired ? loginLink : refreshButton).focus();
    } finally {
      if (reading === current) {
        list.removeAttribute('aria-busy');
        reading = null;
        updateControls();
      }
    }
  }

  async function loadOlderHistory() {
    if (historyLoadingMore || reading || writing || sessionExpired || !historyHasMore || !historyCursor) return;
    historyLoadingMore = true;
    historyRetryFailed = false;
    historyMoreButton.disabled = true;
    historyMoreButton.textContent = '正在加载…';
    historyStatus.textContent = '正在读取更早弹幕…';
    views.history.list.setAttribute('aria-busy', 'true');
    try {
      const page = await getHistoryPage(historyCursor);
      const rows = page.messages.map(historyRow);
      views.history.list.append(...rows);
      historyCursor = page.nextCursor;
      historyHasMore = page.hasMore;
      historyStatus.textContent = historyHasMore ? '还可继续加载更早记录。' : '已到历史记录末尾。';
      historyMoreButton.hidden = !historyHasMore;
      setStatus('success', `已追加 ${rows.length} 条历史弹幕。`);
    } catch (error) {
      historyRetryFailed = true;
      historyStatus.textContent = '加载失败，可重试。';
      historyMoreButton.hidden = false;
      historyMoreButton.textContent = '重试加载更早弹幕';
      showError(error, '加载更早弹幕');
    } finally {
      historyLoadingMore = false;
      views.history.list.removeAttribute('aria-busy');
      if (!historyMoreButton.hidden) {
        historyMoreButton.disabled = sessionExpired;
        historyMoreButton.textContent = historyCursor
          ? (historyRetryFailed ? '重试加载更早弹幕' : '加载更早弹幕')
          : '重试读取历史弹幕';
      }
      updateControls();
    }
  }

  async function save(action, trigger, row, perform, { removeRow = false } = {}) {
    if (reading || writing || settingsLoading || settingsSaving || scheduledLoading || scheduledSaving || sessionExpired) return;
    writing = true;
    row?.setAttribute('aria-busy', 'true');
    setStatus('neutral', `正在${action}…`);
    updateControls();
    let notice;
    try {
      notice = await perform();
      if (removeRow && row) {
        row.classList.add('is-leaving');
        await Promise.allSettled((row.getAnimations?.() || []).map((animation) => animation.finished));
      }
    } catch (error) {
      const focused = document.activeElement === trigger || row?.contains(document.activeElement);
      showError(error, action);
      if (error.status === 401 && focused && !danmakuView.hidden) loginLink.focus();
    } finally {
      writing = false;
      row?.removeAttribute('aria-busy');
      updateControls();
    }
    if (notice) {
      setStatus('success', notice);
      await loadActive({ notice, row });
    }
  }

  function activate(view) {
    if (writing || settingsSaving || scheduledSaving) return false;
    if (active === view) return true;
    active = view;
    for (const tab of allViews) {
      const selected = tab === active;
      tab.button.setAttribute('aria-selected', String(selected));
      tab.button.tabIndex = selected ? 0 : -1;
      tab.panel.hidden = !selected;
    }
    refreshButton.setAttribute('aria-controls', active.list.id);
    loadActive();
    return true;
  }

  function applyWordFilter() {
    if (writing || settingsSaving || scheduledSaving) return;
    const query = wordQuery.value.trim();
    if ([...query].length > 60) {
      setStatus('error', '搜索词最多 60 个字符。');
      wordQuery.focus();
      return;
    }
    wordFilter = { query, scope: wordScope.value, offset: 0 };
    loadActive();
  }

  function pageBy(direction) {
    if (reading || writing || settingsSaving || scheduledSaving || !wordPage) return;
    const offset = wordPage.offset + direction * wordPage.limit;
    if (offset < 0 || offset >= wordPage.total) return;
    wordFilter.offset = offset;
    loadActive();
  }

  // 路由：/danmaku/settings、/danmaku/scheduled 和四个记录标签页（mutes、messages、history、words）。
  let currentPart = '';
  function enterPart(route) {
    const part = route.records ? 'records' : route.part;
    const fromElsewhere = currentPart !== part || danmakuView.dataset.entered !== 'true';
    danmakuView.dataset.part = part;
    danmakuView.dataset.entered = 'true';
    currentPart = part;
    if (part === 'settings' && canConfigure) {
      if (fromElsewhere && !settingsLoading && !settingsSaving && !isSettingsDirty()) loadSettings();
      return;
    }
    if (part === 'scheduled' && canConfigure) {
      if (fromElsewhere && !scheduledLoading && !scheduledSaving && !isScheduledDirty()) loadScheduledConfig();
      return;
    }
    const view = views[route.part] || views.mutes;
    if (active !== view) activate(view);
    else if (fromElsewhere) loadActive();
  }

  function openTab(view) {
    if (window.AdminShell) window.AdminShell.navigate(`/danmaku/${view.key}`);
    else activate(view);
  }

  window.AdminShell?.register('danmaku', {
    canEnter(route) {
      if ((writing || settingsSaving || scheduledSaving) && route.records && views[route.part] !== active) {
        return '正在保存弹幕操作，请稍候再切换。';
      }
      return true;
    },
    enter: enterPart,
    focusTarget(route) {
      return route.records && document.activeElement?.getAttribute('role') === 'tab' ? document.activeElement : null;
    },
    dirty(area) {
      if ((!area || area === 'danmaku-settings') && isSettingsDirty()) return '弹幕设置';
      if ((!area || area === 'danmaku-scheduled') && isScheduledDirty()) return '自动管理员消息';
      return '';
    },
  });

  refreshButton.addEventListener('click', () => { if (!reading && !historyLoadingMore) loadActive(); });
  settingsReload.addEventListener('click', () => {
    if (isSettingsDirty() && !window.confirm('重新读取会丢弃尚未保存的弹幕设置修改。要继续吗？')) return;
    loadSettings();
  });
  settingsForm.addEventListener('submit', saveSettings);
  scheduledReload.addEventListener('click', () => {
    if (isScheduledDirty() && !window.confirm('重新读取会丢弃尚未保存的轮播配置修改。要继续吗？')) return;
    loadScheduledConfig();
  });
  scheduledForm.addEventListener('submit', saveScheduledConfig);
  masterEnabled.addEventListener('change', updateSettingsDraft);
  scheduleEnabled.addEventListener('change', updateSettingsDraft);
  closeAt.addEventListener('input', updateSettingsDraft);
  openAt.addEventListener('input', updateSettingsDraft);
  ratePerMinute.addEventListener('input', updateSettingsDraft);
  rateMinInterval.addEventListener('input', updateSettingsDraft);
  communityVoteThreshold.addEventListener('input', updateSettingsDraft);
  scheduledEnabled.addEventListener('change', updateScheduledDraft);
  scheduledInterval.addEventListener('input', updateScheduledDraft);
  scheduledMessages.addEventListener('input', updateScheduledDraft);
  for (const view of allViews) view.button.addEventListener('click', () => openTab(view));
  tablist.addEventListener('keydown', (event) => {
    const index = allViews.findIndex(({ button }) => button === event.target);
    if (index < 0) return;
    const last = allViews.length - 1;
    let next;
    if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
    else if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else return;
    event.preventDefault();
    allViews[next].button.focus();
  });
  byId('danmaku-word-search').addEventListener('submit', (event) => {
    event.preventDefault();
    applyWordFilter();
  });
  wordScope.addEventListener('change', applyWordFilter);
  byId('danmaku-word-add').addEventListener('submit', (event) => {
    event.preventDefault();
    const original = wordTerm.value;
    const term = original.trim();
    if (!term) {
      setStatus('error', '请输入要添加的违禁词。');
      wordTerm.focus();
      return;
    }
    save('保存词条', addButton, null, async () => {
      const notice = await addWord(term);
      if (wordTerm.value === original) wordTerm.value = '';
      return notice;
    });
  });
  previousPage.addEventListener('click', () => pageBy(-1));
  nextPage.addEventListener('click', () => pageBy(1));
  historyMoreButton.addEventListener('click', () => {
    if (historyHasMore) loadOlderHistory();
    else loadActive();
  });
})();
