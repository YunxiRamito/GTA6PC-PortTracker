// 站长在控制台内管理手动发放的弹幕展示标签。
(async () => {
  'use strict';

  const shell = window.AdminShell;
  const access = window.AdminAccount;
  const byId = id => document.getElementById(id);
  const view = byId('rank-tags-view');
  if (!shell || !access || !view) return;
  await access.ready;
  if (access.capabilities?.canCreateAccounts !== true) return;

  const endpoint = '/api/admin/danmaku/rank-tags';
  const tags = Object.freeze({ owner: '站长', admin: '管理', moderator: '纪委', sponsor: '共创' });
  const roles = Object.freeze({ owner: '最高级别管理员', admin: '普通管理员', moderator: '弹幕风纪委员', user: '普通用户' });
  const search = byId('rank-tags-search');
  const input = byId('rank-tags-query');
  const submit = byId('rank-tags-submit');
  const clear = byId('rank-tags-clear');
  const title = byId('rank-tags-results-title');
  const status = byId('rank-tags-status');
  const notice = byId('rank-tags-notice');
  const retry = byId('rank-tags-retry');
  const list = byId('rank-tags-list');
  const pagination = byId('rank-tags-pagination');
  const previous = byId('rank-tags-prev');
  const next = byId('rank-tags-next');
  const template = byId('rank-tags-row-template');

  let query = '';
  let offset = 0;
  let page = null;
  let reading = null;
  let writing = false;
  const isActive = () => shell.current?.view === view.id;

  function setStatus(node, message, tone = 'neutral') {
    node.dataset.tone = tone;
    node.textContent = message;
  }

  function updateControls() {
    const busy = writing || Boolean(reading);
    submit.setAttribute('aria-disabled', String(writing));
    clear.disabled = writing || (!query && !input.value);
    previous.setAttribute('aria-disabled', String(busy || !page || page.offset === 0));
    next.setAttribute('aria-disabled', String(busy || !page || page.offset + page.limit >= page.total));
    list.setAttribute('aria-busy', String(Boolean(reading)));
    for (const button of list.querySelectorAll('button')) button.setAttribute('aria-disabled', String(busy));
  }

  async function request(url, { body, controller = new AbortController() } = {}) {
    const options = {
      method: body ? 'PUT' : 'GET', signal: controller.signal, mode: 'same-origin',
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' },
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, options);
      if (response.ok) return await response.json();
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function isAccount(account) {
    const validTags = values => Array.isArray(values) && values.every(tag => Object.hasOwn(tags, tag));
    return account && ((typeof account.id === 'string' && account.id !== '') || Number.isSafeInteger(account.id))
      && typeof account.username === 'string' && typeof account.role === 'string'
      && (account.nickname == null || typeof account.nickname === 'string')
      && validTags(account.builtinTags) && validTags(account.grantedTags);
  }

  async function getPage(q, start, controller) {
    const params = new URLSearchParams({ q, offset: String(start) });
    const data = await request(`${endpoint}?${params}`, { controller });
    if (!Array.isArray(data?.accounts) || !data.accounts.every(isAccount)
      || !Number.isSafeInteger(data.offset) || data.offset < 0 || !Number.isSafeInteger(data.total) || data.total < 0
      || !Number.isSafeInteger(data.limit) || data.limit < 1 || data.limit > 20 || data.accounts.length > data.limit) {
      throw new Error('Invalid rank tags page');
    }
    return data;
  }

  function uidOf(account) {
    return Number.isSafeInteger(account.uid) || typeof account.uid === 'string' ? `UID ${account.uid}` : account.username;
  }

  function paintAccount(entry, account) {
    const { row } = entry;
    entry.account = account;
    row.querySelector('[data-name]').textContent = account.nickname || account.username;
    row.querySelector('[data-username]').textContent = `@${account.username}`;
    row.querySelector('[data-uid]').textContent = uidOf(account);
    row.querySelector('[data-role]').textContent = `身份：${Object.hasOwn(roles, account.role) ? roles[account.role] : '未知'}`;
    const builtin = row.querySelector('[data-builtin]');
    const chips = Object.entries(tags).filter(([tag]) => account.builtinTags.includes(tag)).map(([, label]) => {
      const chip = document.createElement('li');
      chip.textContent = label;
      return chip;
    });
    builtin.replaceChildren(...chips);
    builtin.hidden = chips.length === 0;
    row.querySelector('[data-no-builtin]').hidden = chips.length !== 0;
    for (const button of entry.buttons) {
      const tag = button.dataset.tag;
      const granted = account.grantedTags.includes(tag);
      button.dataset.granted = String(granted);
      button.textContent = `${tags[tag]} ${granted ? '撤下' : '发放'}`;
      button.setAttribute('aria-label', `${button.textContent}（${uidOf(account)}）`);
    }
  }

  function makeRow(account) {
    const row = template.content.firstElementChild.cloneNode(true);
    const buttons = Object.keys(tags).map(tag => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button quiet';
      button.dataset.tag = tag;
      return button;
    });
    const entry = { row, buttons };
    for (const button of buttons) button.addEventListener('click', () => changeTag(entry, button.dataset.tag));
    paintAccount(entry, account);
    row.querySelector('[data-grants]').append(...buttons);
    return row;
  }

  function showPagination(visible) {
    if (!visible && pagination.contains(document.activeElement)) title.focus();
    pagination.hidden = !visible;
    pagination.inert = !visible;
  }

  async function load(q, start, message = '') {
    const pending = new AbortController();
    reading?.abort();
    reading = pending;
    query = q;
    offset = start;
    page = null;
    if (list.contains(document.activeElement) || document.activeElement === retry) title.focus();
    list.hidden = true;
    list.inert = true;
    retry.hidden = true;
    retry.inert = true;
    title.textContent = q ? '搜索结果' : '已发放账号';
    setStatus(notice, message, 'success');
    setStatus(status, q ? '正在搜索账号…' : '正在读取已发放账号…', 'loading');
    updateControls();
    try {
      let result = await getPage(q, start, pending);
      // 空查询撤下最后一枚手动标签后，原分页可能超出新范围。
      if (reading === pending && !result.accounts.length && result.total > 0 && start >= result.total) {
        result = await getPage(q, Math.floor((result.total - 1) / result.limit) * result.limit, pending);
      }
      if (reading !== pending) return;
      page = result;
      offset = result.total ? result.offset : 0;
      list.replaceChildren(...result.accounts.map(makeRow));
      list.hidden = !result.accounts.length;
      list.inert = list.hidden;
      showPagination(result.total > result.limit);
      const first = result.offset + 1;
      const last = result.offset + result.accounts.length;
      const range = first === last ? String(first) : `${first}–${last}`;
      const summary = result.accounts.length
        ? `共 ${result.total} 个账号，显示第 ${range} 个。`
        : q ? '未找到匹配的账号。请检查 UID、昵称或用户名。' : '暂无手动发放标签的账号。可搜索账号后发放。';
      setStatus(status, summary);
    } catch (error) {
      if (reading !== pending) return;
      list.replaceChildren();
      showPagination(false);
      retry.hidden = false;
      retry.inert = false;
      setStatus(status, error.status === 401 || error.status === 403
        ? '当前会话无法读取展示标签。请确认站长登录状态后重试。'
        : '暂时无法读取账号列表，请重新读取。', 'error');
    } finally {
      if (reading === pending) {
        reading = null;
        updateControls();
      }
    }
  }

  async function changeTag(entry, tag) {
    if (!isActive() || writing || reading || list.hidden || !list.contains(entry.row)) return;
    const { account, row } = entry;
    const rowStatus = row.querySelector('[data-row-status]');
    const enabled = !account.grantedTags.includes(tag);
    const action = enabled ? '发放' : '撤下';
    const label = tags[tag];
    let refreshNotice = '';
    writing = true;
    updateControls();
    setStatus(notice, '');
    setStatus(rowStatus, `正在${action}「${label}」…`, 'loading');
    try {
      const result = await request(endpoint, { body: { accountId: account.id, tag, enabled } });
      const updated = result?.account;
      if (!isAccount(updated) || updated.id !== account.id || updated.grantedTags.includes(tag) !== enabled) {
        throw new Error('Unconfirmed rank tag change');
      }
      const detail = !enabled && updated.builtinTags.includes(tag) ? '身份自带的同名标签仍会显示。' : '立即生效。';
      const message = `已${action}「${label}」手动标签。${detail}`;
      if (!query && !updated.grantedTags.length) {
        refreshNotice = `${uidOf(account)} ${message}`;
      } else {
        paintAccount(entry, updated);
        setStatus(rowStatus, message, 'success');
      }
    } catch (error) {
      const message = error.status === 401 || error.status === 403
        ? '当前会话无法更改标签。请确认站长登录状态后重试。'
        : `未能确认是否已${action}「${label}」。可重新搜索核对或重试本次操作。`;
      setStatus(rowStatus, message, 'error');
    } finally {
      writing = false;
      if (refreshNotice) load(query, offset, refreshNotice);
      else updateControls();
    }
  }

  search.addEventListener('submit', event => {
    event.preventDefault();
    if (!writing && isActive()) load(input.value.trim(), 0);
  });
  input.addEventListener('input', updateControls);
  clear.addEventListener('click', () => {
    if (writing || !isActive() || (!query && !input.value)) return;
    input.value = '';
    input.focus();
    load('', 0);
  });
  retry.addEventListener('click', () => {
    if (!reading && !writing && isActive()) load(query, offset, notice.textContent);
  });

  function turnPage(direction) {
    if (reading || writing || !isActive() || !page) return;
    const start = Math.max(0, page.offset + direction * page.limit);
    if (start !== page.offset && start < page.total) load(query, start);
  }
  previous.addEventListener('click', () => turnPage(-1));
  next.addEventListener('click', () => turnPage(1));

  shell.register('rank-tags', {
    enter(route, { previous: from }) {
      if (!writing && from?.path !== route.path) load(query, offset);
    },
  });
})();
