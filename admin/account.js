(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const endpoint = '/api/admin/session';
  const profileEndpoint = '/api/admin/account/profile';

  function diagnosticId(response, body) {
    const candidates = [response?.headers?.get('X-Request-ID'), body?.requestId];
    return candidates.find(value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)) || '';
  }

  function withDiagnostic(message, response, body) {
    const id = diagnosticId(response, body);
    return id ? `${message} 排查编号：${id}` : message;
  }

  function connectionFailure(message, host) {
    const occurredAt = new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Shanghai',
    }).format(new Date());
    const safeHost = typeof host === 'string' && host.length <= 255 ? host : window.location.host;
    return `${message} 本次没有收到服务器响应，因此没有服务器排查编号。请记录发生时间（北京时间 ${occurredAt}）和所用网址的域名或 IP（${safeHost}），并反馈；不要发送密码、Cookie 或请求内容。`;
  }

  const roleNames = Object.freeze({
    owner: '最高级别管理员', admin: '普通管理员', moderator: '弹幕风纪委员', user: '普通用户',
  });
  const roleValues = Object.keys(roleNames);
  const passwordMinCharacters = 8;
  const passwordMaxCharacters = 128;
  const noMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let account = null;
  let accountMode = true;
  let canEdit = false;
  let canModerate = false;
  let canManageAccounts = false;
  let canCreateAccounts = false;
  let capabilities = null;
  let avatarCropper = null;
  let savedProfile = null;
  let profileBusy = false;
  let passwordBusy = false;
  let accountsBusy = false;
  let accountsLoaded = false;
  let accountRows = [];
  let pendingAccountAction = null;
  let initialized = false;

  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  function roleLabel(role) {
    return roleNames[role] || '未知角色';
  }

  // 权限规则只在 router.js 定义一次；界面据此隐藏入口，接口仍由服务器校验。
  function updateCapabilities() {
    capabilities = window.AdminRouter.capabilities(account, accountMode);
    ({ canEdit, canModerate, canManageAccounts, canCreateAccounts } = capabilities);
  }

  async function request(url, { method = 'GET', body } = {}) {
    const options = {
      method, mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json' },
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(url, options);
    } catch {
      throw new Error(connectionFailure('无法连接账户服务，请稍后重试。', window.location.host));
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof data?.error === 'string' ? data.error : `请求未完成（HTTP ${response.status}）。`;
      const error = new Error(withDiagnostic(message, response, data));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function setStatus(target, tone, text) {
    if (!target) return;
    target.dataset.tone = tone;
    target.textContent = text;
  }

  function announceError(target, error, fallback) {
    if (error.status === 401) {
      setStatus(target, 'error', '登录状态已失效，正在返回登录页…');
      window.location.replace('/admin/login');
      return;
    }
    setStatus(target, 'error', error.message || fallback);
  }

  function validNewPassword(value) {
    if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value)) return false;
    const characterCount = Array.from(value).length;
    return characterCount >= passwordMinCharacters && characterCount <= passwordMaxCharacters
      && /[A-Za-z]/.test(value);
  }

  function projectProfile(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.id !== 'string' || typeof value.username !== 'string'
      || !Object.hasOwn(roleNames, value.role) || typeof value.nickname !== 'string'
      || (value.email !== null && typeof value.email !== 'string')
      || (value.avatar !== null && typeof value.avatar !== 'string')) {
      throw new Error('服务器返回的账户资料格式有误。');
    }
    return {
      id: value.id, uid: Number.isSafeInteger(value.uid) && value.uid > 0 ? value.uid : null,
      username: value.username, role: value.role, nickname: value.nickname,
      email: value.email || '', avatar: value.avatar || '',
      needsPasswordChange: value.needsPasswordChange === true,
    };
  }

  function applyProfile(profile, { changed = false } = {}) {
    const value = projectProfile(profile);
    byId('profile-username').value = value.username;
    const uid = byId('account-uid');
    uid.hidden = value.uid === null;
    uid.textContent = value.uid === null ? '' : `UID ${value.uid}`;
    byId('profile-nickname').value = value.nickname;
    byId('profile-email').value = value.email;
    byId('account-role').textContent = roleLabel(value.role);
    byId('account-role').dataset.role = value.role;
    avatarCropper?.setValue(value.avatar);
    savedProfile = { nickname: value.nickname, email: value.email, avatar: value.avatar };
    byId('profile-save').disabled = true;
    account = { ...account, ...value };
    updateCapabilities();
    revealRoleNavigation();
    if (changed) setStatus(byId('profile-status'), 'success', '个人资料已保存。');
  }

  function renderRoleSelect(current, editable) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${current.username}的角色`);
    const availableRoles = editable
      ? account.role === 'owner' ? roleValues : ['moderator', 'user']
      : [current.role];
    for (const role of availableRoles) {
      const option = document.createElement('option');
      option.value = role;
      option.textContent = roleLabel(role);
      option.selected = role === current.role;
      select.append(option);
    }
    select.disabled = !editable;
    return select;
  }

  function accountMatches(row, rawQuery) {
    const query = rawQuery.trim();
    if (!query) return true;
    const uidQuery = /^(?:#\s*(\d+)|uid\s+(\d+))$/i.exec(query);
    if (uidQuery) return String(row.uid ?? '') === (uidQuery[1] || uidQuery[2]);
    const normalized = query.toLocaleLowerCase();
    const uidMatches = /^\d+$/.test(query) && String(row.uid ?? '') === query;
    const textMatches = [row.username, row.nickname].some(value => String(value || '').toLocaleLowerCase().includes(normalized));
    return uidMatches || textMatches;
  }

  function renderAccountRows() {
    const table = byId('accounts-list');
    if (!table) return;
    const query = byId('accounts-search')?.value || '';
    const matchingRows = accountRows.filter(row => accountMatches(row, query));
    const rows = matchingRows.map(createAccountRow);
    if (!rows.length) {
      const empty = document.createElement('tr');
      empty.className = 'account-empty-row';
      const cell = document.createElement('td');
      cell.colSpan = 4;
      cell.textContent = accountRows.length ? '没有匹配的账户。' : '暂时没有账户。';
      empty.append(cell);
      rows.push(empty);
    }
    table.replaceChildren(...rows);
    setStatus(byId('accounts-status'), 'neutral', `${matchingRows.length} / ${accountRows.length} 个账户`);
  }

  function openAccountDialog({ title, description, confirmText, account: target, action }) {
    const dialog = byId('account-action-dialog');
    pendingAccountAction = { target, action };
    byId('account-dialog-title').textContent = title;
    byId('account-dialog-description').textContent = description;
    byId('account-dialog-secret').textContent = '';
    byId('account-dialog-secret').hidden = true;
    byId('account-dialog-confirm-field').hidden = action !== 'delete';
    byId('account-dialog-confirm').value = '';
    byId('account-dialog-confirm-action').textContent = confirmText;
    byId('account-dialog-confirm-action').hidden = !action;
    byId('account-dialog-confirm-action').disabled = false;
    byId('account-dialog-copy').hidden = true;
    byId('account-dialog-copy').disabled = false;
    byId('account-dialog-cancel').textContent = '取消';
    byId('account-dialog-status').textContent = '';
    setStatus(byId('account-dialog-status'), 'neutral', '');
    dialog.showModal();
    if (action === 'delete') byId('account-dialog-confirm').focus();
    else byId('account-dialog-confirm-action').focus();
  }

  function finishAccountDialog(message, secret) {
    pendingAccountAction = null;
    byId('account-dialog-title').textContent = '临时密码已生成';
    byId('account-dialog-description').textContent = message;
    byId('account-dialog-secret').textContent = secret;
    byId('account-dialog-secret').hidden = false;
    byId('account-dialog-confirm-field').hidden = true;
    byId('account-dialog-confirm-action').hidden = true;
    byId('account-dialog-copy').hidden = false;
    byId('account-dialog-cancel').textContent = '关闭';
    setStatus(byId('account-dialog-status'), 'success', '密码仅在此对话框中显示一次。');
  }

  async function performAccountAction() {
    const pending = pendingAccountAction;
    if (!pending || accountsBusy) return;
    const { target, action } = pending;
    const confirmButton = byId('account-dialog-confirm-action');
    if (action === 'delete' && byId('account-dialog-confirm').value !== target.username) {
      setStatus(byId('account-dialog-status'), 'error', '输入的用户名必须与账户用户名完全一致。');
      byId('account-dialog-confirm').focus();
      return;
    }
    accountsBusy = true;
    confirmButton.disabled = true;
    byId('accounts-reload').disabled = true;
    setStatus(byId('account-dialog-status'), 'neutral', action === 'reset' ? '正在重置密码…' : '正在删除账户…');
    try {
      if (action === 'reset') {
        const result = await request(`/api/admin/accounts/${encodeURIComponent(target.id)}/reset-password`, { method: 'POST' });
        if (result?.account?.id !== target.id || typeof result.temporaryPassword !== 'string' || !result.temporaryPassword) {
          throw new Error('服务器未返回有效的临时密码。');
        }
        target.needsPasswordChange = result.account.needsPasswordChange === true;
        finishAccountDialog(`已为 ${target.username} 重置密码。`, result.temporaryPassword);
      } else {
        const result = await request(`/api/admin/accounts/${encodeURIComponent(target.id)}`, {
          method: 'DELETE', body: { confirmUsername: target.username },
        });
        if (result?.deleted !== true || result.uid !== target.uid) throw new Error('服务器未确认账户删除。');
        accountRows = accountRows.filter(row => row.id !== target.id);
        renderAccountRows();
        pendingAccountAction = null;
        byId('account-action-dialog').close();
        setStatus(byId('accounts-status'), 'success', `已删除 UID ${result.uid}（${target.username}）。`);
      }
    } catch (error) {
      announceError(byId('account-dialog-status'), error, action === 'reset' ? '重置密码失败，请重试。' : '删除账户失败，请重试。');
      confirmButton.disabled = false;
    } finally {
      accountsBusy = false;
      byId('accounts-reload').disabled = false;
      renderAccountRows();
    }
  }

  function createAccountRow(row) {
    const tr = document.createElement('tr');
    const usernameCell = document.createElement('th');
    usernameCell.scope = 'row';
    usernameCell.textContent = '';
    const username = document.createElement('span');
    username.className = 'account-username';
    username.textContent = row.nickname || row.username;
    const loginName = document.createElement('span');
    loginName.className = 'account-row-login';
    loginName.textContent = row.nickname ? row.username : '';
    const uid = document.createElement('span');
    uid.className = 'account-row-uid';
    uid.textContent = `UID ${row.uid ?? '—'}`;
    usernameCell.append(username, loginName, uid);
    const roleCell = document.createElement('td');
    const statusCell = document.createElement('td');
    const actionCell = document.createElement('td');
    const status = document.createElement('span');
    const actions = document.createElement('form');
    const assignable = row.id !== account.id && (
      account.role === 'owner' || (['moderator', 'user'].includes(row.role) && account.role === 'admin')
    );
    const select = renderRoleSelect(row, assignable);
    const save = document.createElement('button');
    status.className = 'account-role-status';
    status.setAttribute('role', 'status');
    status.dataset.tone = 'neutral';
    if (!row.id && !row.username) {
      status.textContent = '账户信息不完整';
    } else if (row.needsPasswordChange) {
      status.textContent = '等待首次设置密码';
    } else {
      status.textContent = '正常';
    }
    actions.className = 'account-role-form';
    actions.noValidate = true;
    save.type = 'submit';
    save.className = 'button account-role-save';
    save.textContent = '保存角色';
    save.disabled = true;
    save.hidden = !assignable;
    select.addEventListener('change', () => { save.disabled = accountsBusy || select.value === row.role; });
    actions.addEventListener('submit', async event => {
      event.preventDefault();
      if (!assignable || accountsBusy || select.value === row.role) return;
      const nextRole = select.value;
      accountsBusy = true;
      save.disabled = true;
      select.disabled = true;
      setStatus(status, 'neutral', '正在保存…');
      try {
        const result = await request(`/api/admin/accounts/${encodeURIComponent(row.id)}`, {
          method: 'PATCH', body: { role: nextRole },
        });
        if (result?.account?.id !== row.id || result.account.role !== nextRole) {
          throw new Error('服务器未确认角色变更。');
        }
        row.role = result.account.role;
        setStatus(status, 'success', '角色已保存。');
        setStatus(byId('accounts-status'), 'success', `已更新 ${row.username} 的角色。`);
      } catch (error) {
        select.value = row.role;
        announceError(status, error, '角色保存失败，请重试。');
      } finally {
        accountsBusy = false;
        select.disabled = !assignable;
        save.disabled = !assignable || select.value === row.role;
        renderAccountRows();
      }
    });
    roleCell.append(select);
    statusCell.append(status);
    actions.append(save);
    actionCell.append(actions);
    if (account.role === 'owner' && row.id !== account.id) {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'button account-action-button';
      reset.textContent = '重置密码';
      reset.disabled = accountsBusy;
      reset.setAttribute('aria-label', `重置 ${row.username} 的密码`);
      reset.addEventListener('click', () => openAccountDialog({
        title: '重置账户密码？', description: `将为 ${row.username} 生成临时密码，并要求其下次登录时更改。`,
        confirmText: '确认重置', account: row, action: 'reset',
      }));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button danger account-action-button';
      remove.textContent = '删除';
      remove.disabled = accountsBusy;
      remove.setAttribute('aria-label', `删除 ${row.username}`);
      remove.addEventListener('click', () => openAccountDialog({
        title: '删除账户？', description: `此操作无法撤销。确认删除 ${row.username}（UID ${row.uid ?? '—'}）？`,
        confirmText: '确认删除', account: row, action: 'delete',
      }));
      actionCell.append(reset, remove);
    }
    tr.append(usernameCell, roleCell, statusCell, actionCell);
    return tr;
  }

  async function loadAccounts() {
    if (!canManageAccounts || accountsBusy) return;
    accountsBusy = true;
    byId('accounts-reload').disabled = true;
    byId('create-account-submit').disabled = true;
    setStatus(byId('accounts-status'), 'neutral', '正在读取账户…');
    try {
      const result = await request('/api/admin/accounts');
      if (!Array.isArray(result?.accounts)
        || !result.accounts.every(row => row && typeof row.id === 'string' && typeof row.username === 'string' && Object.hasOwn(roleNames, row.role))) {
        throw new Error('服务器返回的账户列表格式有误。');
      }
      accountRows = result.accounts.map(row => ({
        id: row.id, uid: Number.isSafeInteger(row.uid) && row.uid > 0 ? row.uid : null,
        username: row.username, nickname: typeof row.nickname === 'string' ? row.nickname : '',
        role: row.role, needsPasswordChange: row.needsPasswordChange === true,
      }));
      renderAccountRows();
      accountsLoaded = true;
      setStatus(byId('accounts-status'), 'success', `已读取 ${accountRows.length} 个账户。`);
    } catch (error) {
      announceError(byId('accounts-status'), error, '读取账户失败，请重试。');
    } finally {
      accountsBusy = false;
      byId('accounts-reload').disabled = false;
      byId('create-account-submit').disabled = false;
      renderAccountRows();
    }
  }

  async function loadProfile() {
    setStatus(byId('profile-status'), 'neutral', '正在读取个人资料…');
    try {
      const result = await request(profileEndpoint);
      applyProfile(result?.account);
      setStatus(byId('profile-status'), 'neutral', '资料已读取。');
    } catch (error) {
      announceError(byId('profile-status'), error, '读取个人资料失败。');
      byId('profile-retry').hidden = false;
    }
  }

  function syncProfileForm() {
    if (!savedProfile) return false;
    const nickname = byId('profile-nickname').value.trim();
    const email = byId('profile-email').value.trim();
    const dirty = nickname !== savedProfile.nickname || email !== savedProfile.email || avatarCropper.value !== savedProfile.avatar;
    byId('profile-save').disabled = profileBusy || !dirty || !nickname || !byId('profile-email').checkValidity();
    if (dirty && byId('profile-status').dataset.tone !== 'error') setStatus(byId('profile-status'), 'neutral', '资料有未保存的修改。');
    return dirty;
  }

  async function saveProfile(event) {
    event?.preventDefault();
    if (!savedProfile || profileBusy || !syncProfileForm() || !byId('profile-form').reportValidity()) return;
    const nickname = byId('profile-nickname').value.trim();
    const email = byId('profile-email').value.trim();
    const nextAvatar = avatarCropper.value;
    const body = {};
    if (nickname !== savedProfile.nickname) body.nickname = nickname;
    if (email !== savedProfile.email) body.email = email;
    if (nextAvatar !== savedProfile.avatar) body.avatar = nextAvatar || null;
    profileBusy = true;
    byId('profile-save').disabled = true;
    setStatus(byId('profile-status'), 'neutral', '正在保存个人资料…');
    try {
      const result = await request(profileEndpoint, { method: 'PATCH', body });
      applyProfile(result?.account, { changed: true });
    } catch (error) {
      announceError(byId('profile-status'), error, '保存个人资料失败。');
    } finally {
      profileBusy = false;
      syncProfileForm();
    }
  }

  function showPasswordFeedback(target, tone, message) {
    setStatus(target, tone, message);
  }

  async function changePassword({ current, next, confirmation, button, status, forced }) {
    if (passwordBusy) return;
    const currentValue = byId(current).value;
    const nextValue = byId(next).value;
    const confirmValue = byId(confirmation).value;
    if (!byId(current).value || !byId(next).value || !byId(confirmation).value) {
      showPasswordFeedback(status, 'error', '请填写当前密码、新密码和确认密码。');
      [current, next, confirmation].map(byId).find(id => !id.value)?.focus();
      return;
    }
    if (!validNewPassword(nextValue)) {
      showPasswordFeedback(status, 'error', '新密码须为 8–128 个字符，且至少包含 1 个英文字母。');
      byId(next).focus();
      return;
    }
    if (nextValue !== confirmValue) {
      showPasswordFeedback(status, 'error', '两次输入的新密码不一致。');
      byId(confirmation).focus();
      return;
    }
    passwordBusy = true;
    button.disabled = true;
    showPasswordFeedback(status, 'neutral', '正在更改密码…');
    try {
      const result = await request('/api/admin/account/password', {
        method: 'POST',
        body: { currentPassword: currentValue, newPassword: nextValue, confirmPassword: confirmValue },
      });
      if (result?.authenticated !== true || !result.account) {
        throw new Error('密码接口尚未返回已刷新的登录状态，请稍后重试。');
      }
      const refreshedAccount = result.account;
      if (typeof refreshedAccount.id !== 'string' || typeof refreshedAccount.username !== 'string'
        || !Object.hasOwn(roleNames, refreshedAccount.role) || refreshedAccount.needsPasswordChange === true) {
        throw new Error('服务器返回的登录状态无效，请重新登录。');
      }
      account = { ...account, ...refreshedAccount, needsPasswordChange: false };
      updateCapabilities();
      for (const id of [current, next, confirmation]) byId(id).value = '';
      showPasswordFeedback(status, 'success', '密码已更改，登录状态已安全刷新。');
      if (forced) {
        // 重新载入，让导航和各模块按刷新后的会话权限初始化。
        history.replaceState(history.state, '', '#/account/profile');
        window.location.reload();
        return;
      }
    } catch (error) {
      announceError(status, error, '更改密码失败，请检查当前密码后重试。');
    } finally {
      passwordBusy = false;
      button.disabled = false;
    }
  }

  async function createAccount(event) {
    event.preventDefault();
    const form = byId('create-account-form');
    if (!canCreateAccounts || accountsBusy || !form.reportValidity()) return;
    const usernameField = byId('create-account-username');
    const passwordField = byId('create-account-password');
    const roleField = byId('create-account-role');
    const username = usernameField.value.trim();
    const password = passwordField.value;
    if (!validNewPassword(password)) {
      setStatus(byId('create-account-status'), 'error', '初始密码须为 8–128 个字符，且至少包含 1 个英文字母。');
      passwordField.focus();
      return;
    }
    accountsBusy = true;
    byId('create-account-submit').disabled = true;
    byId('accounts-reload').disabled = true;
    form.inert = true;
    setStatus(byId('create-account-status'), 'neutral', '正在创建账号…');
    try {
      const response = await request('/api/admin/accounts', {
        method: 'POST',
        body: { username, password, role: roleField.value },
      });
      if (!response?.account?.id || response.account.username !== username) throw new Error('服务器未确认账户已创建。');
      usernameField.value = '';
      passwordField.value = '';
      roleField.value = 'user';
      accountsLoaded = false;
      setStatus(byId('create-account-status'), 'success', '账号已创建。首次登录时需要设置新密码。');
    } catch (error) {
      announceError(byId('create-account-status'), error, '创建账号失败，请重试。');
    } finally {
      accountsBusy = false;
      form.inert = false;
      byId('create-account-submit').disabled = false;
      byId('accounts-reload').disabled = false;
      if (!byId('accounts-view').hidden && !byId('account-list-panel').hidden && !accountsLoaded) loadAccounts();
    }
  }

  async function logout() {
    const button = byId('logout');
    if (!button || button.disabled) return;
    if (window.AdminShell && !window.AdminShell.confirmLeave('退出登录')) return;
    button.disabled = true;
    try {
      const response = await fetch(endpoint, {
        method: 'DELETE', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('退出登录未能完成。');
      window.location.replace('/admin/login');
    } catch (error) {
      button.disabled = false;
      const status = byId('shell-status');
      setStatus(status, 'error', error.message || '无法确认退出，请检查连接后重试。');
    }
  }

  function revealRoleNavigation() {
    const summary = byId('account-summary');
    if (summary) {
      summary.hidden = !accountMode || !account;
      summary.replaceChildren();
      if (accountMode && account) {
        const name = document.createElement('strong');
        name.textContent = account.nickname || account.username;
        const role = document.createElement('span');
        role.textContent = roleLabel(account.role);
        summary.append(name, role);
      }
    }
    if (!byId('admin-layout')) return;
    byId('password-only').hidden = !capabilities.forced;
    byId('account-regular').hidden = !capabilities.canUseProfile;
    byId('profile-fields').disabled = !capabilities.canUseProfile || !savedProfile;
    if (!canCreateAccounts) byId('create-account-panel').hidden = true;
    if (!canManageAccounts) byId('account-list-panel').hidden = true;
    byId('admin-layout').hidden = false;
    byId('admin-loading').hidden = true;
  }

  function passwordDraftLabel() {
    const prefix = capabilities.forced ? 'password' : 'regular-password';
    const dirty = ['current', 'new', 'confirm'].some(field => byId(`${prefix}-${field}`).value !== '');
    return dirty ? (capabilities.forced ? '设置新密码表单' : '更改密码表单') : '';
  }

  function creationDraftLabel() {
    if (!canCreateAccounts) return '';
    const role = byId('create-account-role').value;
    const dirty = byId('create-account-username').value || byId('create-account-password').value || (role && role !== 'user');
    return dirty ? '创建账号表单' : '';
  }

  function registerViews() {
    const shell = window.AdminShell;
    if (!shell || !byId('admin-layout')) return;
    shell.register('account', {
      enter(route, { initial }) {
        // 两张表单留在 DOM 中，切换设置页面时保留草稿。
        byId('profile-panel').hidden = route.part !== 'profile';
        byId('regular-password-panel').hidden = route.part !== 'password';
        if (initial && capabilities.forced) byId('password-title').focus({ preventScroll: true });
      },
      focusTarget() {
        return capabilities.forced ? byId('password-title') : null;
      },
      dirty() {
        const profileDirty = Boolean(savedProfile) && (byId('profile-nickname').value.trim() !== savedProfile.nickname
          || byId('profile-email').value.trim() !== savedProfile.email || avatarCropper?.value !== savedProfile.avatar);
        return profileDirty ? '个人资料' : passwordDraftLabel();
      },
    });
    shell.register('accounts', {
      enter(route) {
        const showList = route.part === 'accounts' && canManageAccounts;
        byId('account-list-panel').hidden = !showList;
        byId('create-account-panel').hidden = route.part !== 'create' || !canCreateAccounts;
        if (showList && !accountsLoaded && !accountsBusy) loadAccounts();
      },
      dirty: creationDraftLabel,
    });
  }

  function installAvatarCropper() {
    if (!byId('admin-layout')) return;
    avatarCropper = window.AdminAvatar.create({
      fileInput: byId('profile-avatar-file'),
      canvas: byId('profile-avatar-canvas'),
      controls: byId('profile-avatar-controls'),
      xInput: byId('profile-avatar-x'),
      yInput: byId('profile-avatar-y'),
      zoomInput: byId('profile-avatar-zoom'),
      resetButton: byId('profile-avatar-reset'),
      removeButton: byId('profile-avatar-remove'),
      status: byId('profile-avatar-status'),
      onChange: () => { if (savedProfile) syncProfileForm(); },
      onError: message => setStatus(byId('profile-status'), 'error', message),
    });
  }

  function bindConsole() {
    byId('logout')?.addEventListener('click', logout);
    if (!byId('admin-layout')) return;
    byId('accounts-reload').addEventListener('click', () => loadAccounts());
    byId('accounts-search').addEventListener('input', renderAccountRows);
    byId('account-dialog-confirm-action').addEventListener('click', performAccountAction);
    byId('account-dialog-copy').addEventListener('click', async () => {
      const secret = byId('account-dialog-secret').textContent;
      if (!secret) return;
      try {
        await navigator.clipboard.writeText(secret);
        setStatus(byId('account-dialog-status'), 'success', '临时密码已复制。');
      } catch {
        setStatus(byId('account-dialog-status'), 'error', '无法访问剪贴板；请在对话框关闭前手动选择并复制。');
      }
    });
    byId('account-action-dialog').addEventListener('close', () => {
      pendingAccountAction = null;
      byId('account-dialog-secret').textContent = '';
      byId('account-dialog-description').textContent = '';
      byId('account-dialog-confirm').value = '';
      byId('account-dialog-status').textContent = '';
    });
    byId('account-action-dialog').addEventListener('cancel', event => {
      if (accountsBusy) event.preventDefault();
    });
    byId('create-account-form').addEventListener('submit', createAccount);
    byId('profile-form').addEventListener('input', syncProfileForm);
    byId('profile-form').addEventListener('submit', saveProfile);
    byId('profile-email').addEventListener('change', () => { if (savedProfile) syncProfileForm(); });
    byId('profile-retry').addEventListener('click', () => {
      byId('profile-retry').hidden = true;
      loadProfile();
    });
    byId('password-form').addEventListener('submit', event => {
      event.preventDefault();
      changePassword({
        current: 'password-current', next: 'password-new', confirmation: 'password-confirm',
        button: byId('password-submit'), status: byId('account-password-status'), forced: true,
      });
    });
    byId('regular-password-form').addEventListener('submit', event => {
      event.preventDefault();
      changePassword({
        current: 'regular-password-current', next: 'regular-password-new', confirmation: 'regular-password-confirm',
        button: byId('regular-password-submit'), status: byId('regular-password-status'), forced: false,
      });
    });
    window.addEventListener('beforeunload', event => {
      if (window.AdminShell?.leaveConfirmed || !(passwordDraftLabel() || creationDraftLabel())) return;
      event.preventDefault();
      event.returnValue = '';
    });
    window.addEventListener('pagehide', () => avatarCropper?.dispose(), { once: true });
  }

  async function initialize() {
    const isIndex = Boolean(byId('admin-layout'));
    if (isIndex) byId('admin-retry').addEventListener('click', () => window.location.reload());
    try {
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'GET', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: { Accept: 'application/json' },
        });
      } catch {
        throw new Error(connectionFailure('无法连接后台服务，请稍后重试。', window.location.host));
      }
      const data = await response.json().catch(() => null);
      if (response.status === 405) {
        accountMode = false;
        account = { role: 'admin', username: '', nickname: '', needsPasswordChange: false };
      } else if (!response.ok) {
        const message = typeof data?.error === 'string' ? data.error : '无法读取登录状态。';
        const error = new Error(withDiagnostic(message, response, data));
        error.status = response.status;
        throw error;
      } else if (data?.authenticated !== true) {
        window.location.replace('/admin/login');
        return;
      } else if (data.account && typeof data.account.username === 'string' && Object.hasOwn(roleNames, data.account.role)) {
        accountMode = true;
        account = {
          id: data.account.id,
          username: data.account.username,
          role: data.account.role,
          nickname: typeof data.account.nickname === 'string' ? data.account.nickname : data.account.username,
          needsPasswordChange: data.account.needsPasswordChange === true,
        };
      } else {
        accountMode = false;
        account = { role: 'admin', username: '', nickname: '', needsPasswordChange: false };
      }

      updateCapabilities();
      initialized = true;
      bindConsole();
      installAvatarCropper();
      revealRoleNavigation();
      registerViews();
      if (isIndex && accountMode && !capabilities.forced) await loadProfile();
    } catch (error) {
      if (error.status === 401) {
        window.location.replace('/admin/login');
        return;
      }
      if (isIndex) {
        byId('admin-loading').querySelector('p').textContent = error.message || '无法验证登录状态。';
        byId('admin-retry').hidden = false;
      }
    } finally {
      resolveReady();
    }
  }

  // 独立页（反馈、鸣谢）只对站长和管理员开放；服务器同样拦截。
  function initializeStandalone() {
    if (byId('admin-layout') || !initialized) return;
    if (!canEdit) window.location.replace('/admin/#/account/profile');
  }

  const accountApi = {
    ready, get initialized() { return initialized; }, get accountMode() { return accountMode; }, get account() { return account; },
    get capabilities() { return capabilities; }, get canEdit() { return canEdit; },
    get canModerate() { return canModerate; }, get canManageAccounts() { return canManageAccounts; },
    get canCreateAccounts() { return canCreateAccounts; }, refreshAccount: loadProfile, logout,
  };
  window.AdminAccount = accountApi;
  initialize().then(initializeStandalone);
})();
