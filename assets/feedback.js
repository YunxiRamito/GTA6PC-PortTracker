(() => {
  'use strict';

  const CLIENT_KEY = 'port-tracker:feedback-client';
  const SEEN_NOTICE_PREFIX = 'port-tracker:site-notice-seen:';
  const MAX_TEXT = 1000;
  const MAX_READ_IDS = 1000;
  const EXIT_MS = 260;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const replyDate = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai',
  });
  const byId = id => document.getElementById(id);
  function syncSiteNoticeHeight() {
    const height = ['siteNoticeStrip']
      .map(id => byId(id))
      .filter(strip => strip && !strip.hidden)
      .reduce((sum, strip) => sum + strip.offsetHeight, 0);
    if (height) document.documentElement.style.setProperty('--feedback-site-notice-height', `${height}px`);
    else document.documentElement.style.removeProperty('--feedback-site-notice-height');
  }

  function getClientSecret() {
    try {
      const storage = window.localStorage;
      const existing = storage.getItem(CLIENT_KEY);
      if (existing && /^[a-f0-9]{64}$/.test(existing)) return existing;

      // Use browser-generated entropy for the local feedback identity.
      const random = window.crypto.getRandomValues(new Uint8Array(32));
      const secret = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
      storage.setItem(CLIENT_KEY, secret);
      return secret;
    } catch {
      return null;
    }
  }

  function request(path, { client, body, keepalive = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (client) headers['X-Feedback-Client'] = client;
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: body ? 'POST' : 'GET',
      body: body ? JSON.stringify(body) : undefined,
      headers,
      cache: 'no-store',
      mode: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout?.(6500),
      keepalive,
    });
  }

  async function readJson(path, client) {
    const response = await request(path, { client });
    if (!response.ok) return null;
    return response.json();
  }

  function createStripLink(link) {
    if (typeof link?.label !== 'string' || !link.label.trim() || typeof link.url !== 'string') return null;
    const url = link.url.trim();
    const relative = /^(?:\/(?!\/)|#)/.test(url);
    const https = /^https:\/\/[^/?#]/i.test(url);
    if ((!relative && !https) || /[\s\x00-\x1f\x7f\\]/.test(url)) return null;

    const publicHome = document.querySelector('.site-topbar .site-brand[data-site-path]')?.href;
    const base = publicHome || window.location.href;
    let destination;
    try { destination = new URL(url, base); } catch { return null; }
    if (relative ? destination.origin !== new URL(base).origin
      : destination.protocol !== 'https:' || destination.username || destination.password) return null;

    const anchor = document.createElement('a');
    anchor.className = 'feedback-site-notice-link';
    anchor.href = destination.href;
    const label = document.createElement('span');
    label.textContent = link.label;
    const svgNamespace = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(svgNamespace, 'svg');
    icon.setAttribute('class', 'ui-icon');
    icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(svgNamespace, 'use');
    use.setAttribute('href', '/assets/ui/fluent.svg#arrow-up-right');
    icon.append(use);
    anchor.append(label, icon);
    return anchor;
  }

  function showStrip(message, headerLink) {
    const strip = byId('siteNoticeStrip');
    const text = byId('siteNoticeText');
    const close = byId('siteNoticeClose');
    if (!strip || !text || !close || typeof message !== 'string' || !message.trim()) return;

    text.textContent = message;
    text.setAttribute('data-lenis-prevent', '');
    const link = createStripLink(headerLink);
    if (link) {
      close.before(link);
      strip.classList.add('has-link');
    }
    strip.classList.remove('is-leaving');
    strip.inert = false;
    strip.hidden = false;
    const observer = new ResizeObserver(syncSiteNoticeHeight);
    observer.observe(strip);
    syncSiteNoticeHeight();

    close.addEventListener('click', () => {
      strip.inert = true;
      strip.classList.add('is-leaving');
      document.querySelector('.site-brand')?.focus({ preventScroll: true });
      observer.disconnect();
      const hide = () => { strip.hidden = true; syncSiteNoticeHeight(); };
      if (reducedMotion.matches) hide();
      else window.setTimeout(hide, EXIT_MS);
    }, { once: true });
  }

  function showDialog(heading, content, dismissLabel) {
    const dialog = document.createElement('dialog');
    dialog.className = 'feedback-notice-dialog';
    dialog.setAttribute('aria-labelledby', 'feedbackNoticeTitle');
    dialog.setAttribute('data-lenis-prevent', '');

    const frame = document.createElement('div');
    frame.className = 'feedback-notice-frame';
    const title = document.createElement('h2');
    title.className = 'feedback-notice-title';
    title.id = 'feedbackNoticeTitle';
    title.tabIndex = -1;
    title.setAttribute('autofocus', '');
    title.textContent = heading;
    const body = document.createElement('div');
    body.className = 'feedback-notice-body';
    body.append(content);
    const close = document.createElement('button');
    close.className = 'feedback-notice-dismiss';
    close.type = 'button';
    close.textContent = dismissLabel;
    frame.append(title, body, close);
    dialog.append(frame);

    function dismiss() {
      if (dialog.classList.contains('is-leaving')) return;
      dialog.classList.add('is-leaving');
      if (reducedMotion.matches) dialog.close();
      else window.setTimeout(() => dialog.close(), EXIT_MS);
    }

    close.addEventListener('click', dismiss);
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      dismiss();
    });
    const closed = new Promise(resolve => {
      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve();
      }, { once: true });
    });
    document.body.append(dialog);
    dialog.showModal();
    if (body.scrollHeight > body.clientHeight) body.tabIndex = 0;
    return closed;
  }

  function replyList(replies) {
    const list = document.createElement('ol');
    list.className = 'feedback-notice-replies';
    for (const [index, reply] of replies.entries()) {
      const item = document.createElement('li');
      item.className = 'feedback-notice-reply';
      item.style.setProperty('--reply-delay', `${Math.min(index, 5) * 40}ms`);
      const content = document.createElement('p');
      content.textContent = reply.text;
      item.append(content);
      const timestamp = typeof reply.repliedAt === 'string' ? Date.parse(reply.repliedAt) : NaN;
      if (Number.isFinite(timestamp)) {
        const time = document.createElement('time');
        time.dateTime = reply.repliedAt;
        time.textContent = replyDate.format(timestamp);
        item.append(time);
      }
      list.append(item);
    }
    return list;
  }

  async function markRepliesRead(client, replies) {
    const ids = [...new Set(replies.map(reply => reply.id))];
    for (let start = 0; start < ids.length; start += MAX_READ_IDS) {
      const response = await request('/api/feedback/replies/read', {
        client,
        body: { ids: ids.slice(start, start + MAX_READ_IDS) },
        keepalive: true,
      });
      if (!response.ok) break;
    }
  }

  function showPopup(popup) {
    if (!popup || !(typeof popup.id === 'string' || typeof popup.id === 'number') ||
        !String(popup.id).trim() || typeof popup.text !== 'string' || !popup.text.trim()) return;
    const key = SEEN_NOTICE_PREFIX + popup.id;
    try {
      if (window.localStorage.getItem(key) === '1') return;
    } catch { /* Still show a notice when storage is blocked. */ }
    const content = document.createElement('p');
    content.className = 'feedback-notice-copy';
    content.textContent = popup.text;
    showDialog('网站通知', content, '知道了');
    try { window.localStorage.setItem(key, '1'); } catch { /* Dedupe is unavailable without storage. */ }
  }

  async function loadNotifications() {
    const notices = readJson('/api/site-notices').then(payload => {
      showStrip(payload?.header, payload?.headerLink);
      return payload;
    }).catch(() => null);
    // Reply mailboxes belong to the public flow. Shared headers only need public notices.
    if (!document.querySelector('.site-topbar-home') && !byId('feedbackForm')) return;
    const client = getClientSecret();
    if (client) {
      const payload = await readJson('/api/feedback/replies', client).catch(() => null);
      const replies = Array.isArray(payload?.replies) ? payload.replies.filter(reply => reply &&
        (typeof reply.id === 'string' && reply.id.trim() || typeof reply.id === 'number') &&
        typeof reply.text === 'string' && reply.text.trim()) : [];
      if (replies.length) {
        const heading = replies.length === 1 ? '收到一条反馈回复' : `收到 ${replies.length} 条反馈回复`;
        await showDialog(heading, replyList(replies), '知道了');
        void markRepliesRead(client, replies).catch(() => {});
      }
    }
    showPopup((await notices)?.popup);
  }

  function initForm() {
    const form = byId('feedbackForm');
    if (!form) return;
    const field = byId('feedbackText');
    const count = byId('feedbackCount');
    const status = byId('feedbackStatus');
    const submit = byId('feedbackSubmit');
    const setStatus = (message, tone = '') => {
      status.textContent = message;
      status.dataset.tone = tone;
    };
    const syncCount = () => {
      const length = Array.from(field.value).length;
      count.textContent = `${length} / ${MAX_TEXT}`;
      count.toggleAttribute('data-over-limit', length > MAX_TEXT);
    };

    field.addEventListener('input', syncCount);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submit.disabled) return;
      const draft = field.value;
      const text = draft.trim();
      if (!text || Array.from(text).length > MAX_TEXT) {
        setStatus(text ? '反馈最多 1000 个字符。' : '请先填写反馈。', 'error');
        field.focus();
        return;
      }
      const client = getClientSecret();
      if (!client) {
        setStatus('无法保存反馈标识。请允许此站点使用本地存储后重试。', 'error');
        return;
      }

      submit.disabled = true;
      setStatus('正在发送…');
      try {
        const response = await request('/api/feedback', { client, body: { text } });
        if (response.ok) {
          if (field.value === draft) field.value = '';
          syncCount();
          setStatus('已收到反馈，谢谢！', 'success');
        } else if (response.status === 429) {
          setStatus('提交太频繁了，请稍后再试。', 'error');
        } else if (response.status === 400 || response.status === 413) {
          setStatus('请检查反馈内容后再试。', 'error');
        } else {
          setStatus('暂时无法发送，请稍后再试。', 'error');
        }
      } catch {
        setStatus('暂时无法发送，请检查网络后重试。', 'error');
      } finally {
        submit.disabled = false;
      }
    });
    syncCount();
    submit.disabled = false;
  }

  initForm();
  void loadNotifications().catch(() => {});
})();
