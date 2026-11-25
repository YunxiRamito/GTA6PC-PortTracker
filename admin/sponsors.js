(async () => {
  'use strict';

  if (window.AdminAccount) {
    await window.AdminAccount.ready;
    if (!window.AdminAccount.canEdit) return;
  }

  const endpoint = '/api/admin/sponsors';
  const messageLimit = 240;
  const sponsorLimit = 250;
  const byId = id => document.getElementById(id);
  const searchForm = byId('account-search-form');
  const search = byId('account-search');
  const searchSubmit = byId('search-submit');
  const results = byId('account-results');
  const searchStatus = byId('search-status');
  const resultTemplate = byId('account-result-template');
  const list = byId('sponsor-list');
  const empty = byId('sponsor-empty');
  const count = byId('sponsor-count');
  const sponsorTemplate = byId('sponsor-item-template');
  const status = byId('manager-status');
  const reload = byId('reload-sponsors');
  const save = byId('save-sponsors');
  const conflictPanel = byId('conflict-panel');
  const conflictReload = byId('conflict-reload');
  const sessionMessage = byId('session-message');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let draft = new Map();
  let savedMessages = null;
  let etag = '';
  let operation = '';
  let needsReload = false;
  let nextInputId = 0;
  let searchTimer = 0;
  let searchRequest = null;

  const GET_RETRY_DELAY_MS = 1000;
  const GET_RETRY_MAX_DELAY_MS = 5000;

  function tell(node, tone, message) {
    node.dataset.tone = tone;
    if (node.textContent !== message) node.textContent = message;
  }

  function editable() {
    return Boolean(etag) && !operation && !needsReload;
  }

  function dirty() {
    if (!savedMessages) return false;
    if (savedMessages.size !== draft.size) return true;
    return [...draft].some(([id, person]) => savedMessages.get(id) !== person.message.trim());
  }

  function warnUnsaved(event) {
    if (window.AdminShell?.leaveConfirmed) return;
    event.preventDefault();
    event.returnValue = true;
  }

  function syncControls() {
    const canEdit = editable();
    const hasChanges = dirty();
    const busy = Boolean(operation);
    reload.disabled = conflictReload.disabled = busy;
    save.disabled = !canEdit || !hasChanges || Boolean(list.querySelector('[aria-invalid="true"]:not(.is-leaving *)'));
    search.disabled = !canEdit;
    searchSubmit.disabled = !canEdit || !search.value.trim();
    conflictPanel.hidden = !needsReload;
    status.dataset.busy = String(busy);
    list.setAttribute('aria-busy', String(busy));

    for (const input of list.querySelectorAll('.message-input')) input.readOnly = !canEdit;
    for (const button of list.querySelectorAll('.remove-sponsor')) button.disabled = !canEdit;
    for (const button of results.querySelectorAll('.add-account')) {
      const added = draft.has(button.dataset.accountId);
      const full = draft.size >= sponsorLimit;
      button.disabled = !canEdit || added || full;
      button.textContent = added ? '已添加' : '添加';
      button.setAttribute('aria-label', `${button.textContent} ${button.dataset.name}`);
    }

    if (hasChanges) window.addEventListener('beforeunload', warnUnsaved);
    else window.removeEventListener('beforeunload', warnUnsaved);
  }

  function syncListSummary() {
    count.textContent = savedMessages ? `已点亮 ${draft.size} 颗星` : '名单尚未读取';
    empty.hidden = !savedMessages || draft.size > 0 || Boolean(list.querySelector('.is-leaving'));
  }

  function tellDraftStatus() {
    if (list.querySelector('.sponsor-item:not(.is-leaving) [aria-invalid="true"]')) {
      tell(status, 'error', `请将超长短句缩短至 ${messageLimit} 字后保存。`);
    } else if (draft.size >= sponsorLimit) {
      tell(status, 'notice', `鸣谢名单最多可添加 ${sponsorLimit} 位。${dirty() ? '当前更改尚未保存。' : ''}`);
    } else {
      tell(status, dirty() ? 'notice' : 'success', dirty() ? '有未保存的更改。' : '名单已同步。');
    }
  }

  function personInfo(row) {
    return {
      uid: typeof row.uid === 'number' || typeof row.uid === 'string' ? String(row.uid) : '',
      username: typeof row.username === 'string' ? row.username : '',
      nickname: typeof row.nickname === 'string' ? row.nickname : '',
      avatar: typeof row.avatar === 'string' ? row.avatar : '',
    };
  }

  function displayName(person) {
    return person.nickname.trim() || person.username || (person.uid ? `UID ${person.uid}` : '未设置昵称');
  }

  function avatarURL(value) {
    if (!value || value.length > 120_000) return '';
    if (/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i.test(value)) return value;
    try {
      const url = new URL(value, window.location.origin);
      return /^https?:$/.test(url.protocol) && url.origin === window.location.origin ? url.href : '';
    } catch {
      return '';
    }
  }

  function fillPerson(row, person) {
    const name = displayName(person);
    row.querySelector('.person-name').textContent = name;
    row.querySelector('.person-meta').textContent = [
      person.uid && `UID ${person.uid}`,
      person.username && `用户名 ${person.username}`,
    ].filter(Boolean).join(' · ');
    const fallback = row.querySelector('.person-avatar-fallback');
    fallback.textContent = [...name][0] || '✦';
    const source = avatarURL(person.avatar);
    if (source) {
      const image = row.querySelector('.person-avatar-image');
      image.addEventListener('error', () => { image.hidden = true; }, { once: true });
      image.src = source;
      image.hidden = false;
    }
  }

  function updateMessageCount(input, caption) {
    const length = [...input.value.trim()].length;
    input.setAttribute('aria-invalid', String(length > messageLimit));
    caption.textContent = `${length} / ${messageLimit} 字${length > messageLimit ? ' · 超出上限' : ''}`;
  }

  function removeSponsor(accountId, item, button, person) {
    if (!editable() || !draft.has(accountId)) return;
    if (!window.confirm(`从鸣谢名单移除「${displayName(person)}」？该账号会保留。`)) return;
    if (item.contains(document.activeElement)) {
      const buttons = [...list.querySelectorAll('.remove-sponsor:not(.is-leaving *)')];
      const index = buttons.indexOf(button);
      (buttons[index + 1] || buttons[index - 1] || search).focus();
    }
    draft.delete(accountId);
    if (reducedMotion.matches) item.remove();
    else {
      item.inert = true;
      item.classList.add('is-leaving');
      const finish = () => {
        item.remove();
        syncListSummary();
      };
      const fallback = window.setTimeout(finish, 280);
      item.addEventListener('animationend', () => {
        window.clearTimeout(fallback);
        finish();
      }, { once: true });
    }
    syncListSummary();
    syncControls();
    tellDraftStatus();
  }

  function sponsorRow(accountId, person) {
    const item = sponsorTemplate.content.firstElementChild.cloneNode(true);
    fillPerson(item, person);
    const input = item.querySelector('.message-input');
    const caption = item.querySelector('.message-count');
    const remove = item.querySelector('.remove-sponsor');
    input.id = `sponsor-message-${++nextInputId}`;
    caption.id = `${input.id}-count`;
    input.setAttribute('aria-describedby', caption.id);
    item.querySelector('.message-label').htmlFor = input.id;
    input.value = person.message;
    updateMessageCount(input, caption);
    input.addEventListener('input', () => {
      person.message = input.value;
      updateMessageCount(input, caption);
      syncControls();
      tellDraftStatus();
    });
    remove.setAttribute('aria-label', `移除 ${displayName(person)}`);
    remove.addEventListener('click', () => removeSponsor(accountId, item, remove, person));
    return item;
  }

  function addSponsor(id, account) {
    if (!editable() || draft.has(id) || draft.size >= sponsorLimit) return;
    const person = { ...account, message: '' };
    const row = sponsorRow(id, person);
    // Keep the existing order intact while making the newest acknowledgement
    // visible first. Map iteration order is also the order sent to the API.
    draft = new Map([[id, person], ...draft]);
    list.prepend(row);
    syncListSummary();
    syncControls();
    tellDraftStatus();
    row.querySelector('.message-input').focus();
  }

  function acceptList({ data, version }) {
    if (!version) throw new Error('响应缺少名单版本（ETag）。');
    if (!Array.isArray(data?.sponsors)) throw new Error('服务器返回的鸣谢名单格式不正确。');
    const next = new Map();
    for (const row of data.sponsors) {
      if (typeof row?.accountId !== 'string' || !row.accountId || next.has(row.accountId) || typeof row.message !== 'string') {
        throw new Error('服务器返回的鸣谢条目不正确。');
      }
      next.set(row.accountId, { ...personInfo(row), message: row.message });
    }
    list.replaceChildren(...[...next].map(([id, person]) => sponsorRow(id, person)));
    draft = next;
    savedMessages = new Map([...next].map(([id, person]) => [id, person.message.trim()]));
    etag = version;
    needsReload = false;
    syncListSummary();
  }

  function abortError(signal) {
    return signal?.reason || Object.assign(new Error('请求已取消'), { name: 'AbortError' });
  }

  function waitForRetry(delay, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      let timer;
      const cancel = () => {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        reject(abortError(signal));
      };
      const finish = () => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      };
      signal?.addEventListener('abort', cancel, { once: true });
      timer = window.setTimeout(finish, delay);
    });
  }

  function retryDelay(response) {
    const retryAfter = response.headers.get('Retry-After');
    if (!retryAfter) return GET_RETRY_DELAY_MS;
    if (!/^\d+$/.test(retryAfter)) return null;
    const delay = Number(retryAfter) * 1000;
    return delay <= GET_RETRY_MAX_DELAY_MS ? delay : null;
  }

  async function request(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const retryable = method === 'GET';
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, {
        credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', ...options,
        headers: { Accept: 'application/json', ...options.headers },
      });
      const data = await response.json().catch(() => null);
      if (response.ok) return { data, version: response.headers.get('ETag') };
      if (retryable && response.status === 503 && attempt === 0) {
        const delay = retryDelay(response);
        if (delay !== null) {
          await waitForRetry(delay, options.signal);
          continue;
        }
      }
      const error = new Error(typeof data?.error === 'string' && data.error ? data.error : `请求失败（HTTP ${response.status}）。`);
      error.status = response.status;
      throw error;
    }
  }

  function reportError(node, action, error) {
    let message = error.message || '请稍后重试。';
    if (error.status === 401) {
      sessionMessage.hidden = false;
      message = '请重新登录。';
    } else if (error.status === 403) message = '当前账号没有鸣谢管理权限。';
    else if (error instanceof TypeError) message = '无法连接管理服务，请重试。';
    tell(node, 'error', `${action}失败。${message}`);
  }

  function focusAfterAction(trigger, target) {
    if (trigger && (document.activeElement === trigger || document.activeElement === document.body)) target.focus();
  }

  async function loadList(trigger) {
    if (operation || (dirty() && !window.confirm('读取成功后会替换当前未保存的草稿。继续读取吗？'))) return;
    operation = 'loading';
    syncControls();
    tell(status, 'neutral', '正在读取鸣谢名单…');
    try {
      acceptList(await request(endpoint));
      sessionMessage.hidden = true;
      tell(status, 'success', `名单已读取，共 ${draft.size} 位鸣谢者。`);
    } catch (error) {
      reportError(status, '读取名单', error);
    } finally {
      operation = '';
      syncListSummary();
      syncControls();
      focusAfterAction(trigger, status);
    }
  }

  async function saveList() {
    if (save.disabled || !editable() || !dirty()) return;
    const trigger = document.activeElement === save ? save : null;
    const sponsors = [...draft].map(([accountId, person]) => ({ accountId, message: person.message.trim() }));
    operation = 'saving';
    syncControls();
    tell(status, 'neutral', '正在保存鸣谢名单…');
    try {
      const next = await request(endpoint, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag },
        body: JSON.stringify({ sponsors }),
      });
      sessionMessage.hidden = true;
      try {
        acceptList(next);
        tell(status, 'success', `鸣谢名单已保存，共 ${draft.size} 位。`);
      } catch (error) {
        needsReload = true;
        tell(status, 'error', `保存结果需要核对。${error.message}`);
      }
    } catch (error) {
      if ([409, 412, 428].includes(error.status)) {
        needsReload = true;
        tell(status, 'conflict', '名单版本冲突。请先读取最新名单，再提交更改。');
      } else {
        reportError(status, '保存名单', error);
      }
    } finally {
      operation = '';
      syncControls();
      focusAfterAction(trigger, needsReload ? conflictReload : status);
    }
  }

  function renderResults(accounts) {
    if (!Array.isArray(accounts)) throw new Error('服务器返回的账号列表格式不正确。');
    const rows = [];
    const ids = new Set();
    for (const account of accounts) {
      if (typeof account?.id !== 'string' || !account.id || ids.has(account.id)) continue;
      const person = personInfo(account);
      const item = resultTemplate.content.firstElementChild.cloneNode(true);
      fillPerson(item, person);
      const button = item.querySelector('.add-account');
      button.dataset.accountId = account.id;
      button.dataset.name = displayName(person);
      button.addEventListener('click', () => addSponsor(account.id, person));
      rows.push(item);
      ids.add(account.id);
    }
    results.replaceChildren(...rows);
    syncControls();
    tell(searchStatus, 'neutral', rows.length ? `找到 ${rows.length} 个账号。` : '没有匹配的账号。');
  }

  async function findAccounts(query) {
    const pending = new AbortController();
    searchRequest = pending;
    try {
      const params = new URLSearchParams({ q: query });
      const { data } = await request(`${endpoint}/accounts?${params}`, { signal: pending.signal });
      if (searchRequest !== pending) return;
      sessionMessage.hidden = true;
      renderResults(data?.accounts);
    } catch (error) {
      if (searchRequest === pending) reportError(searchStatus, '搜索账号', error);
    } finally {
      if (searchRequest === pending) {
        searchRequest = null;
        results.setAttribute('aria-busy', 'false');
      }
    }
  }

  function queueSearch(delay, composing = false) {
    window.clearTimeout(searchTimer);
    searchRequest?.abort();
    searchRequest = null;
    results.replaceChildren();
    const query = search.value.trim();
    const searching = editable() && query && !composing;
    results.setAttribute('aria-busy', String(Boolean(searching)));
    tell(searchStatus, 'neutral', searching ? '正在搜索账号…' : '');
    syncControls();
    if (searching) searchTimer = window.setTimeout(() => findAccounts(query), delay);
  }

  search.addEventListener('input', event => queueSearch(260, event.isComposing));
  search.addEventListener('compositionend', () => queueSearch(260));
  searchForm.addEventListener('submit', event => {
    event.preventDefault();
    queueSearch(0);
  });
  reload.addEventListener('click', () => loadList(reload));
  conflictReload.addEventListener('click', () => loadList(conflictReload));
  save.addEventListener('click', saveList);
  const shell = window.AdminShell;
  shell?.register('sponsors', {
    dirty: () => (dirty() ? '鸣谢名单' : ''),
    enter() { if (!savedMessages && !operation) void loadList(); },
  });
  if (shell?.page !== 'console') void loadList();
})();
