(async () => {
  'use strict';

  if (window.AdminAccount) {
    await window.AdminAccount.ready;
    if (!window.AdminAccount.canEdit) return;
  }

  const inboxEndpoint = '/api/admin/feedback';
  const noticesEndpoint = '/api/admin/site-notices';
  const textLimit = 1000;
  const popupTitleLimit = 80;
  const maxRetryAfterSeconds = 3600;
  const noticeRevision = /^"[a-f0-9]{64}"$/;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  const unknownResponse = '服务返回的数据格式不正确，请重试。';
  const beijingTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });

  const byId = id => document.getElementById(id);
  const sessionBanners = ['feedback-session', 'site-notices-session'].map(byId).filter(Boolean);
  const inboxList = byId('inbox-list');
  const inboxStatus = byId('inbox-status');
  const refresh = byId('inbox-refresh');
  const more = byId('inbox-more');
  const cardTemplate = byId('feedback-card-template');
  const noticesForm = byId('notices-form');
  const noticesFields = byId('notices-fields');
  const noticesStatus = byId('notices-status');
  const noticesRetry = byId('notices-retry');
  const noticesSave = byId('notices-save');
  const headerInput = byId('notice-header');
  const headerCount = byId('notice-header-count');
  const linkUrlInput = byId('notice-link-url');
  const linkLabelInput = byId('notice-link-label');
  const linkLabelHint = byId('notice-link-label-hint');
  const popupTitleInput = byId('notice-popup-title');
  const popupTitleCount = byId('notice-popup-title-count');
  const popupInput = byId('notice-popup');
  const popupCount = byId('notice-popup-count');

  const replyDrafts = new Map();
  let renderedCards = new Map();
  let nextOffset = null;
  let inboxLoading = false;
  let pendingReplies = 0;
  let savedNotices = null;
  let noticesEtag = null;
  let noticesStale = false;
  let noticesBusy = false;
  let sessionFailures = 0;

  function setStatus(element, tone, message) {
    element.dataset.tone = tone;
    if (element.textContent !== message) element.textContent = message;
  }

  async function request(url, body, ifMatch) {
    const recovery = sessionBanners.some(banner => !banner.hidden) ? sessionFailures : 0;
    const options = {
      method: body === undefined ? 'GET' : 'PUT',
      mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json' },
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      if (ifMatch !== undefined) options.headers['If-Match'] = ifMatch;
      options.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, options);
    } catch {
      throw new Error('无法连接管理服务，请重试。');
    }
    if (response.status === 401) {
      sessionFailures += 1;
      for (const banner of sessionBanners) banner.hidden = false;
      throw new Error('请重新登录。');
    }
    if (response.status === 429) {
      // A proxy can rate-limit the request before it reaches the JSON API.
      const retryAfter = response.headers.get('retry-after') ?? '';
      const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : 0;
      const error = new Error(seconds > 0 && seconds <= maxRetryAfterSeconds
        ? `请求过于频繁，请在 ${seconds} 秒后重试。`
        : '请求过于频繁，请稍后重试。');
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const data = response.status < 500 ? await response.json().catch(() => null) : null;
      const error = new Error(typeof data?.error === 'string' ? data.error : '管理服务暂时无法完成请求，请重试。');
      error.status = response.status;
      throw error;
    }
    const data = await response.json().catch(() => { throw new Error(unknownResponse); });
    if (recovery && recovery === sessionFailures) {
      for (const banner of sessionBanners) banner.hidden = true;
    }
    return url === noticesEndpoint ? { data, etag: response.headers.get('etag') } : data;
  }

  function readText(input, count, limit = textLimit) {
    const value = input.value.trim();
    // The API counts Unicode code points. HTML maxlength counts UTF-16 units.
    const length = Array.from(value).length;
    const invalid = length > limit;
    input.setAttribute('aria-invalid', String(invalid));
    count.dataset.invalid = String(invalid);
    count.textContent = `${length} / ${limit} 字符${invalid ? '，超出上限' : ''}`;
    return { value, invalid };
  }

  function sameTextareaText(value, saved) {
    return value === saved.replace(/\r\n?/g, '\n');
  }

  function setTime(element, value) {
    const time = new Date(value);
    if (!Number.isFinite(time.getTime())) {
      element.removeAttribute('datetime');
      element.textContent = '时间未知';
      return;
    }
    element.dateTime = time.toISOString();
    element.textContent = beijingTime.format(time);
  }

  function isFeedback(row) {
    return typeof row?.id === 'string' && uuid.test(row.id)
      && typeof row.text === 'string' && typeof row.createdAt === 'string'
      && (row.reply === null || (typeof row.reply?.text === 'string' && typeof row.reply.repliedAt === 'string'));
  }

  function syncInbox() {
    const busy = inboxLoading || pendingReplies > 0;
    refresh.disabled = busy;
    more.disabled = busy || nextOffset === null;
    more.hidden = nextOffset === null;
    inboxList.setAttribute('aria-busy', String(inboxLoading));
    for (const card of renderedCards.values()) card.sync();
  }

  function createCard(record) {
    let row = record;
    const card = cardTemplate.content.firstElementChild.cloneNode(true);
    const details = card.querySelector('details');
    const summary = details.querySelector('summary');
    const form = details.querySelector('form');
    const input = form.querySelector('textarea');
    const count = form.querySelector('.feedback-count');
    const submit = form.querySelector('button');
    const status = card.querySelector('.feedback-row-status');
    const replyState = card.querySelector('.feedback-reply-state');
    const sent = card.querySelector('.feedback-sent');
    let saving = false;
    let draft;

    input.id = `feedback-reply-${row.id}`;
    count.id = `${input.id}-count`;
    form.querySelector('label').htmlFor = input.id;
    input.setAttribute('aria-describedby', count.id);

    function sync() {
      input.readOnly = saving;
      submit.disabled = inboxLoading || saving || draft.invalid || !draft.value
        || sameTextareaText(draft.value, row.reply?.text ?? '');
    }

    function paint() {
      setTime(card.querySelector('.feedback-created'), row.createdAt);
      card.querySelector('.feedback-message').textContent = row.text;
      replyState.textContent = row.reply ? '已回复' : '待回复';
      replyState.dataset.replied = String(Boolean(row.reply));
      summary.textContent = row.reply ? '编辑回复' : '写回复';
      submit.textContent = row.reply ? '保存并发送' : '发送回复';
      sent.hidden = !row.reply;
      if (row.reply) {
        setTime(sent.querySelector('time'), row.reply.repliedAt);
        sent.querySelector('.feedback-message').textContent = row.reply.text;
      }
      input.value = replyDrafts.get(row.id) ?? row.reply?.text ?? '';
      draft = readText(input, count);
      sync();
    }

    input.addEventListener('input', () => {
      draft = readText(input, count);
      if (sameTextareaText(input.value, row.reply?.text ?? '')) replyDrafts.delete(row.id);
      else replyDrafts.set(row.id, input.value);
      setStatus(status, 'neutral', '');
      sync();
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      draft = readText(input, count);
      sync();
      if (submit.disabled) return;

      const returnFocus = form.contains(document.activeElement);
      saving = true;
      pendingReplies += 1;
      syncInbox();
      setStatus(status, 'neutral', '正在发送回复…');
      try {
        const data = await request(`${inboxEndpoint}/${encodeURIComponent(row.id)}/reply`, { text: draft.value });
        if (!isFeedback(data?.feedback) || data.feedback.id !== row.id || !data.feedback.reply) {
          throw new Error(unknownResponse);
        }
        row = data.feedback;
        replyDrafts.delete(row.id);
        if (form.contains(document.activeElement) || (returnFocus && document.activeElement === document.body)) {
          summary.focus();
        }
        details.open = false;
        paint();
        setStatus(status, 'success', '回复已发送。');
      } catch (error) {
        setStatus(status, 'error', `发送回复失败。${error.message}`);
        if (returnFocus && details.open && document.activeElement === document.body) input.focus();
      } finally {
        saving = false;
        pendingReplies -= 1;
        syncInbox();
      }
    });

    paint();
    details.open = replyDrafts.has(row.id);
    return { element: card, sync };
  }

  async function loadInbox(offset = 0) {
    if (inboxLoading || pendingReplies) return;
    const appending = offset > 0;
    const trigger = appending ? more : refresh;
    const returnFocus = document.activeElement === trigger;
    let firstNewCard = null;
    inboxLoading = true;
    syncInbox();
    setStatus(inboxStatus, 'neutral', appending ? '正在读取更多反馈…' : '正在读取反馈…');

    try {
      const page = await request(`${inboxEndpoint}?offset=${offset}`);
      if (!Array.isArray(page?.feedback) || !page.feedback.every(isFeedback) || page.offset !== offset
        || !Number.isSafeInteger(page.total) || page.total < 0) {
        throw new Error(unknownResponse);
      }
      if (!appending && inboxList.childElementCount && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const exit = inboxList.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-.25rem)' }], {
          duration: 145, easing: 'cubic-bezier(.22, 1, .36, 1)',
        });
        await exit.finished.catch(() => {});
      }

      const cards = appending ? renderedCards : new Map();
      const fragment = document.createDocumentFragment();
      for (const row of page.feedback) {
        if (cards.has(row.id)) continue;
        const card = createCard(row);
        cards.set(row.id, card);
        fragment.append(card.element);
        firstNewCard ??= card.element;
      }
      if (appending) inboxList.append(fragment);
      else inboxList.replaceChildren(fragment);
      renderedCards = cards;

      const next = offset + page.feedback.length;
      nextOffset = page.feedback.length && next < page.total ? next : null;
      const message = cards.size ? `已显示 ${cards.size} 条，共 ${page.total} 条。` : '暂时没有收到反馈。';
      setStatus(inboxStatus, 'neutral', message);
    } catch (error) {
      setStatus(inboxStatus, 'error', `读取反馈失败。${error.message}`);
    } finally {
      inboxLoading = false;
      syncInbox();
      if (returnFocus && (document.activeElement === document.body || document.activeElement === trigger)) {
        const target = appending ? firstNewCard ?? (more.hidden ? refresh : more) : refresh;
        target.focus();
      }
    }
  }

  function syncNotices() {
    const header = readText(headerInput, headerCount);
    const popup = readText(popupInput, popupCount);
    const title = readText(popupTitleInput, popupTitleCount, popupTitleLimit);
    const emptyPopup = Boolean(title.value && !popup.value);
    const titleInvalid = title.invalid || emptyPopup || /[\u2028\u2029]/.test(title.value);
    if (titleInvalid && !title.invalid) {
      popupTitleInput.setAttribute('aria-invalid', 'true');
      popupTitleCount.dataset.invalid = 'true';
      popupTitleCount.textContent += emptyPopup ? '，请填写正文或清空标题' : '，标题须写在同一行';
    }
    const headerChanged = savedNotices && !sameTextareaText(header.value, savedNotices.header);
    const popupChanged = savedNotices && !sameTextareaText(popup.value, savedNotices.popup);
    const titleChanged = savedNotices && title.value !== savedNotices.popupTitle;
    const label = linkLabelInput.value.trim();
    const url = linkUrlInput.value.trim();
    const headerLink = header.value && url ? { label, url } : null;
    const savedLink = savedNotices?.headerLink;
    const linkChanged = (headerLink?.label ?? '') !== (savedLink?.label ?? '')
      || (headerLink?.url ?? '') !== (savedLink?.url ?? '');
    const changed = Boolean(headerChanged || popupChanged || titleChanged || linkChanged);
    const labelInvalid = Boolean(headerLink && (!label || Array.from(label).length > 80));
    linkLabelInput.setAttribute('aria-invalid', String(labelInvalid));
    linkLabelHint.dataset.invalid = String(labelInvalid);
    linkLabelHint.textContent = labelInvalid ? '请输入 1–80 个字符作为链接显示文字。' : '填写链接地址后，显示文字最多 80 个字符。';
    noticesFields.disabled = !savedNotices;
    noticesSave.disabled = noticesBusy || !noticesEtag || noticesStale || !changed || header.invalid || popup.invalid || titleInvalid || labelInvalid;
    for (const input of [headerInput, popupInput, popupTitleInput, linkUrlInput, linkLabelInput]) input.readOnly = noticesBusy;
    noticesRetry.hidden = Boolean(savedNotices && !noticesStale && noticesEtag);
    noticesRetry.textContent = noticesStale && changed ? '放弃草稿并重新读取' : '重新读取公告';
    // An unchanged body keeps its line endings and its delivery ID.
    const titleOnly = titleChanged && !headerChanged && !popupChanged && !linkChanged;
    return {
      changed,
      payload: titleOnly ? { popupTitle: title.value } : {
        header: headerChanged ? header.value : savedNotices?.header ?? '',
        popup: popupChanged ? popup.value : savedNotices?.popup ?? '',
        popupTitle: title.value,
        ...(linkChanged && { headerLink }),
      },
    };
  }

  function applyNotices({ data, etag }) {
    const link = data?.headerLink;
    if (!noticeRevision.test(etag ?? '')) throw new Error('未取得公告版本，无法安全保存。');
    if (typeof data?.header !== 'string' || (data.popup !== null && typeof data.popup?.text !== 'string')
      || (data.popup?.title !== undefined && typeof data.popup.title !== 'string')
      || (link != null && (typeof link.label !== 'string' || typeof link.url !== 'string'))) {
      throw new Error(unknownResponse);
    }
    savedNotices = { header: data.header, popup: data.popup?.text ?? '', popupTitle: data.popup?.title ?? '', headerLink: link ?? null };
    noticesEtag = etag;
    noticesStale = false;
    headerInput.value = savedNotices.header;
    linkUrlInput.value = link?.url ?? '';
    linkLabelInput.value = link?.label ?? '';
    popupInput.value = savedNotices.popup;
    popupTitleInput.value = savedNotices.popupTitle;
  }

  async function loadNotices() {
    if (noticesBusy) return;
    const returnFocus = document.activeElement === noticesRetry;
    noticesBusy = true;
    noticesRetry.disabled = true;
    setStatus(noticesStatus, 'neutral', '正在读取公告…');
    try {
      applyNotices(await request(noticesEndpoint));
      setStatus(noticesStatus, 'neutral', '公告已读取。');
    } catch (error) {
      setStatus(noticesStatus, 'error', `读取公告失败。${error.message}`);
    } finally {
      noticesBusy = false;
      syncNotices();
      noticesRetry.disabled = false;
      if (returnFocus && document.activeElement === document.body) (savedNotices ? headerInput : noticesRetry).focus();
    }
  }

  noticesForm.addEventListener('input', () => {
    const { changed } = syncNotices();
    if (noticesStale) return;
    setStatus(noticesStatus, 'neutral', changed ? '公告有未保存的修改。' : '没有未保存的修改。');
  });
  noticesForm.addEventListener('submit', async event => {
    event.preventDefault();
    const { payload } = syncNotices();
    if (noticesSave.disabled) return;

    const returnFocus = noticesForm.contains(document.activeElement);
    noticesBusy = true;
    syncNotices();
    setStatus(noticesStatus, 'neutral', '正在保存公告…');
    try {
      const result = await request(noticesEndpoint, payload, noticesEtag);
      noticesEtag = null;
      applyNotices(result);
      setStatus(noticesStatus, 'success', '公告已保存。');
    } catch (error) {
      if (error.status === 412 || !noticesEtag) noticesStale = true;
      setStatus(noticesStatus, 'error', `保存公告失败。${error.message}`);
    } finally {
      noticesBusy = false;
      syncNotices();
      if (returnFocus && document.activeElement === document.body) noticesStatus.focus({ preventScroll: true });
    }
  });

  // 公告修改和未发送的回复草稿只在本页保留；离开前提示。
  function draftLabel(area) {
    if ((!area || area === 'site-notices') && savedNotices && syncNotices().changed) return '站点公告';
    return (!area || area === 'feedback') && replyDrafts.size ? '反馈回复' : '';
  }
  let inboxEntered = false;
  const shell = window.AdminShell;
  shell?.register('feedback', {
    dirty: draftLabel,
    enter(route) {
      if (route.part === 'notices') {
        if (!savedNotices) void loadNotices();
      } else if (!inboxEntered) {
        inboxEntered = true;
        void loadInbox();
      }
    },
  });
  window.addEventListener('beforeunload', event => {
    if (window.AdminShell?.leaveConfirmed || !draftLabel()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  refresh.addEventListener('click', () => loadInbox());
  more.addEventListener('click', () => { if (nextOffset !== null) loadInbox(nextOffset); });
  noticesRetry.addEventListener('click', loadNotices);
  if (shell?.page !== 'console') {
    void loadInbox();
    void loadNotices();
  }
})();
