(() => {
  'use strict';

  const form = document.getElementById('login-form');
  const loginCard = document.getElementById('login-card');
  const registrationCard = document.getElementById('registration-card');
  const usernameField = document.getElementById('username-field');
  const username = document.getElementById('username');
  const password = document.getElementById('password');
  const passwordLabel = document.getElementById('password-label');
  const submit = document.getElementById('login-submit');
  const feedback = document.getElementById('login-feedback');
  const retryFeedback = document.getElementById('retry-feedback');
  const registrationForm = document.getElementById('registration-form');
  const registrationFeedback = document.getElementById('registration-feedback');
  const registrationSubmit = document.getElementById('registration-submit');
  const registrationUsername = document.getElementById('registration-username');
  const registrationPassword = document.getElementById('registration-password');
  const registrationConfirmation = document.getElementById('registration-confirm-password');
  const registrationEmail = document.getElementById('registration-email');
  const registrationNickname = document.getElementById('registration-nickname');
  const showRegistration = document.getElementById('show-registration');
  const endpoint = '/api/admin/session';
  const loopback = (hostname) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  const sameOrigin = { mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
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

  let accountMode = true;
  let ready = false;
  let pending = false;
  let cooldownUntil = 0;
  let cooldownTimer = 0;
  let avatarValue = '';
  let avatarCropper = null;

  function showFeedback(tone, message) {
    feedback.dataset.tone = tone;
    feedback.textContent = message;
  }

  function setRegistrationFeedback(tone, message) {
    registrationFeedback.dataset.tone = tone;
    registrationFeedback.textContent = message;
  }

  function showLogin(message = '') {
    registrationCard.hidden = true;
    loginCard.hidden = false;
    document.body.classList.remove('registration-active');
    if (message) showFeedback('success', message);
    username.focus();
  }

  function showRegistrationForm() {
    if (!ready || pending || !accountMode) return;
    loginCard.hidden = true;
    registrationCard.hidden = false;
    document.body.classList.add('registration-active');
    registrationSubmit.disabled = false;
    document.getElementById('registration-title').focus();
  }

  function finishCooldown() {
    if (cooldownTimer) window.clearInterval(cooldownTimer);
    cooldownTimer = 0;
    cooldownUntil = 0;
    retryFeedback.hidden = true;
    retryFeedback.textContent = '';
    password.disabled = false;
    submit.disabled = !ready || pending;
  }

  function beginCooldown(seconds) {
    finishCooldown();
    const duration = Math.max(1, Math.min(15 * 60, Math.floor(seconds)));
    cooldownUntil = Date.now() + duration * 1000;
    password.disabled = true;
    submit.disabled = true;
    retryFeedback.hidden = false;

    const update = () => {
      const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      retryFeedback.textContent = remaining ? `请在 ${remaining} 秒后重试。` : '';
      if (!remaining) {
        finishCooldown();
        showFeedback('neutral', '可以重试登录。');
      }
    };
    update();
    cooldownTimer = window.setInterval(update, 1000);
  }

  async function configureLogin() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(endpoint, {
        ...sameOrigin, headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      const session = await response.json().catch(() => null);
      if (typeof session?.accountMode === 'boolean') accountMode = session.accountMode;
      else if (response.status === 405 && /\bPOST\b/i.test(response.headers.get('Allow') || '')) accountMode = false;
      else if (response.ok) accountMode = true;
      else if ((response.ok || response.status === 401) && loopback(window.location.hostname) && !session?.account) accountMode = false;
    } catch {
      // Start with named sign-in when the server cannot confirm legacy mode.
    } finally {
      window.clearTimeout(timeout);
      usernameField.hidden = !accountMode;
      username.disabled = !accountMode;
      username.required = accountMode;
      passwordLabel.textContent = accountMode ? '密码' : '管理密码';
      showRegistration.hidden = !accountMode;
      ready = true;
      submit.disabled = false;
      registrationSubmit.disabled = !accountMode;
      if (document.activeElement === document.body) (accountMode ? username : password).focus();
      if (window.location.hash === '#password-changed') showFeedback('success', '密码已更改，请登录。');
      if (accountMode) {
        avatarCropper = window.AdminAvatar.create({
          fileInput: document.getElementById('registration-avatar-file'),
          canvas: document.getElementById('registration-avatar-canvas'),
          controls: document.getElementById('registration-avatar-controls'),
          xInput: document.getElementById('registration-avatar-x'),
          yInput: document.getElementById('registration-avatar-y'),
          zoomInput: document.getElementById('registration-avatar-zoom'),
          resetButton: document.getElementById('registration-avatar-reset'),
          removeButton: document.getElementById('registration-avatar-remove'),
          status: document.getElementById('registration-avatar-status'),
          onChange: value => { avatarValue = value; },
          onError: message => setRegistrationFeedback('error', message),
        });
      }
    }
  }

  function exchangeOrigin(value) {
    const url = new URL(value);
    const secure = url.protocol === 'https:';
    const local = url.protocol === 'http:' && window.location.protocol === 'http:'
      && loopback(window.location.hostname) && loopback(url.hostname);
    if ((!secure && !local) || (value !== url.origin && value !== `${url.origin}/`)) {
      throw new Error('Invalid console origin');
    }
    return url.origin;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
      if (!ready || pending || cooldownUntil > Date.now() || !form.reportValidity()) return;
    const name = username.value.trim();
    if (accountMode && !name) {
      username.setAttribute('aria-invalid', 'true');
      showFeedback('error', '请输入用户名。');
      username.focus();
      return;
    }

    pending = true;
    username.readOnly = password.readOnly = true;
    submit.disabled = true;
    showFeedback('neutral', '正在验证…');
    let exchanging = false;
    let navigating = false;
    let waitingForResponse = false;
    let diagnosticHost = window.location.host;
    let lastResponse = null;
    let lastResponseBody = null;

    try {
      waitingForResponse = true;
      const response = await fetch(endpoint, {
        ...sameOrigin,
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(accountMode ? { username: name, password: password.value } : { password: password.value }),
      });
      waitingForResponse = false;
      lastResponse = response;
      password.value = '';
      const session = await response.json().catch(() => null);
      lastResponseBody = session;
      if (response.ok) {
        if (session?.authenticated !== true) {
          showFeedback('error', withDiagnostic('管理服务未确认登录，请重试。', response, session));
          return;
        }
        // 保留后台路由（#/danmaku/history 等）和旧锚点 #danmaku-scheduled；其余由后台按角色选择首页。
        const returnHash = /^#(?:\/[a-z0-9/-]{1,64}|danmaku-scheduled)$/.test(window.location.hash) ? window.location.hash : '';
        let destination = `/admin/${returnHash}`;
        if (session.loginCode !== undefined || session.consoleOrigin !== undefined) {
          exchanging = true;
          if (typeof session.loginCode !== 'string' || !session.loginCode || typeof session.consoleOrigin !== 'string') {
            throw new Error('Incomplete console handoff');
          }
          const origin = exchangeOrigin(session.consoleOrigin);
          showFeedback('neutral', '正在进入后台…');
          diagnosticHost = new URL(origin).host;
          waitingForResponse = true;
          const exchange = await fetch(`${origin}${endpoint}/exchange`, {
            method: 'POST', mode: 'cors', credentials: 'include', cache: 'no-store', redirect: 'error',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: session.loginCode }),
          });
          waitingForResponse = false;
          const exchangeBody = await exchange.json().catch(() => null);
          lastResponse = exchange;
          lastResponseBody = exchangeBody;
          if (!exchange.ok) {
            const message = typeof exchangeBody?.error === 'string' ? exchangeBody.error : '无法进入后台，请重新登录。';
            showFeedback('error', withDiagnostic(message, exchange, exchangeBody));
            return;
          }
          destination = `${origin}${destination}`;
        } else if (session.account) {
          destination = session.account.needsPasswordChange ? '/admin/#/account/password' : destination;
        }
        window.location.replace(destination);
        navigating = true;
        return;
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
        showFeedback('error', withDiagnostic('尝试次数过多，请稍后再试。', response, session));
        beginCooldown(seconds);
      } else if (response.status === 401) {
        if (accountMode) username.setAttribute('aria-invalid', 'true');
        password.setAttribute('aria-invalid', 'true');
        showFeedback('error', withDiagnostic(accountMode ? '登录失败，请检查用户名和密码。' : '登录失败，请检查管理密码后重试。', response, session));
      } else {
        const message = typeof session?.error === 'string' ? session.error : '登录请求未能完成，请稍后重试。';
        showFeedback('error', withDiagnostic(message, response, session));
      }
    } catch {
      password.value = '';
      const message = exchanging ? '无法进入后台，请重新登录。' : '无法连接管理服务，请稍后重试。';
      showFeedback('error', waitingForResponse
        ? connectionFailure(message, diagnosticHost)
        : withDiagnostic(message, lastResponse, lastResponseBody));
    } finally {
      if (!navigating) {
        pending = false;
        username.readOnly = password.readOnly = false;
        submit.disabled = cooldownUntil > Date.now();
        if (!password.disabled && (form.contains(document.activeElement) || document.activeElement === document.body)) password.focus();
      }
    }
  });

  form.addEventListener('input', () => {
    username.removeAttribute('aria-invalid');
    password.removeAttribute('aria-invalid');
    if (feedback.dataset.tone === 'error') showFeedback('neutral', '');
  });

  document.getElementById('show-registration').addEventListener('click', showRegistrationForm);
  document.getElementById('show-login').addEventListener('click', () => showLogin());
  registrationForm.addEventListener('input', () => {
    registrationUsername.removeAttribute('aria-invalid');
    registrationPassword.removeAttribute('aria-invalid');
    registrationConfirmation.removeAttribute('aria-invalid');
    if (registrationFeedback.dataset.tone === 'error') setRegistrationFeedback('neutral', '');
  });
  registrationForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!accountMode || pending || !registrationForm.reportValidity()) return;

    const usernameValue = registrationUsername.value.trim();
    const emailValue = registrationEmail.value.trim();
    const passwordValue = registrationPassword.value;
    const confirmationValue = registrationConfirmation.value;
    const passwordLength = Array.from(passwordValue).length;
    if (passwordLength < 8 || passwordLength > 128 || !/[A-Za-z]/.test(passwordValue) || /[\uD800-\uDFFF]/u.test(passwordValue)) {
      registrationPassword.setAttribute('aria-invalid', 'true');
      setRegistrationFeedback('error', passwordLength > 128
        ? '密码最多 128 个字符，请缩短后重试。'
        : '密码至少 8 个字符，并包含至少 1 个英文字母。');
      registrationPassword.focus();
      return;
    }
    if (passwordValue !== confirmationValue) {
      registrationConfirmation.setAttribute('aria-invalid', 'true');
      setRegistrationFeedback('error', '确认密码与上方密码不一致，请重新输入确认密码。');
      registrationConfirmation.focus();
      return;
    }

    pending = true;
    registrationSubmit.disabled = true;
      setRegistrationFeedback('neutral', '正在创建账户…');
    const body = {
      nickname: registrationNickname.value.trim(),
      username: usernameValue,
      password: passwordValue,
      confirmPassword: confirmationValue,
    };
    if (emailValue) body.email = emailValue;
    if (avatarValue) body.avatar = avatarValue;

    let response = null;
    let result = null;
    try {
      response = await fetch('/api/admin/register', {
        ...sameOrigin,
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      result = await response.json().catch(() => null);
      if (response.status !== 201) {
        if (response.status === 409) registrationUsername.setAttribute('aria-invalid', 'true');
        const serverError = typeof result?.error === 'string' ? result.error : '注册未能完成，请稍后重试。';
        setRegistrationFeedback('error', withDiagnostic(serverError, response, result));
        return;
      }

      registrationPassword.value = '';
      registrationConfirmation.value = '';
      registrationUsername.value = '';
      registrationEmail.value = '';
      registrationNickname.value = '';
      avatarCropper?.clear();
      showLogin('账户已创建，请登录。');
      password.focus();
    } catch (error) {
      const message = error.message || '注册未能完成，请稍后重试。';
      setRegistrationFeedback('error', response
        ? withDiagnostic(message, response, result)
        : connectionFailure(message, window.location.host));
    } finally {
      pending = false;
      registrationSubmit.disabled = false;
      registrationPassword.value = '';
      registrationConfirmation.value = '';
    }
  });
  window.addEventListener('pagehide', () => avatarCropper?.dispose(), { once: true });
  configureLogin();
})();
