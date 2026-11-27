 (async () => {
  'use strict';

  if (window.AdminAccount) {
    await window.AdminAccount.ready;
    if (!window.AdminAccount.canEdit) return;
  }

  const endpoint = '/api/admin/content';
  const byId = (id) => document.getElementById(id);
  const workspace = byId('workspace');
  const form = byId('form-editor');
  const jsonView = byId('json-view');
  const raw = byId('raw-editor');
  const jsonError = byId('json-error');
  const save = byId('save');
  const logout = byId('logout');
  const reload = byId('reload');
  const formMode = byId('form-mode');
  const jsonMode = byId('json-mode');
  const feedback = byId('feedback');
  const status = byId('status');
  const detailList = byId('error-details');
  const draftState = byId('draft-state');
  const conflict = byId('conflict');
  const intro = byId('editorial-intro');

  let draft = null;
  let savedContent = null;
  let baseline = '';
  let etag = '';
  let section = 'home';
  let mode = 'form';
  let pending = '';
  let stale = false;
  let projectQuery = '';
  let savedPrivateIds = new Set();

  const format = (content) => JSON.stringify(content, null, 2);
  const draftText = () => mode === 'json' ? raw.value : format(draft);
  const isDirty = () => draft !== null && draftText() !== baseline;
  const text = (value) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const MAX_PRIVATE_REPOSITORIES = 160;
  const PRIVATE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function button(label, className = 'button') {
    const node = element('button', className, label);
    node.type = 'button';
    return node;
  }

  function warnBeforeLeaving(event) {
    if (window.AdminShell?.leaveConfirmed) return;
    event.preventDefault();
    event.returnValue = '';
  }

  function updateControls() {
    const dirty = isDirty();
    const busy = pending !== '';
    workspace.inert = busy;
    reload.disabled = busy;
    logout.disabled = busy;
    save.disabled = busy || !dirty || stale;
    formMode.disabled = jsonMode.disabled = busy || !draft;
    conflict.hidden = !stale;

    const label = pending || (stale ? '版本冲突' : dirty ? '未保存' : draft ? '已同步' : '尚未读取');
    if (draftState.textContent !== label) draftState.textContent = label;
    draftState.dataset.state = stale || dirty ? 'draft' : 'normal';
    if (dirty) window.addEventListener('beforeunload', warnBeforeLeaving);
    else window.removeEventListener('beforeunload', warnBeforeLeaving);
  }

  function setStatus(tone, message, details = []) {
    feedback.dataset.tone = tone;
    detailList.replaceChildren(...details.map((detail) => element('li', '', detail)));
    detailList.hidden = details.length === 0;
    status.textContent = message;
    if (tone === 'error' || tone === 'conflict') feedback.scrollIntoView({ block: 'nearest' });
  }

  function assertShape(content) {
    const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!object(content)) throw new Error('内容必须是一个 JSON 对象。');
    for (const name of ['home', 'countdown', 'roadmap', 'announcements', 'downloads', 'community']) {
      if (!object(content[name])) throw new Error(`缺少 ${name} 对象。`);
    }
    if (Object.hasOwn(content.countdown, 'enabled') && typeof content.countdown.enabled !== 'boolean') {
      throw new Error('countdown.enabled 必须是 true 或 false。');
    }
    const lists = [
      ['announcements.items', content.announcements.items],
      ['downloads.items', content.downloads.items],
      ['news', content.news],
      ['projects', content.projects],
      ['community.groups', content.community.groups],
    ];
    for (const [name, items] of lists) {
      if (!Array.isArray(items) || !items.every(object)) throw new Error(`${name} 必须是对象列表。`);
    }
    if (Object.keys(content.community).length !== 1 || content.community.groups.length !== 0) {
      throw new Error('community.groups 必须为空列表。');
    }
    return content;
  }

  const gameplayStatuses = {
    planned: '计划中', unknown: '待核实', reported: '项目方自述', completed: '已核实', blocked: '受阻',
  };

  async function request(method, { part, content, version } = {}) {
    const headers = new Headers({ Accept: 'application/json' });
    const options = { method, headers, mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
    if (method === 'PUT') {
      headers.set('Content-Type', 'application/json');
      headers.set('If-Match', version);
      options.body = JSON.stringify(content);
    }
    let response;
    try {
      response = await fetch(part ? `${endpoint}/${part}` : endpoint, options);
    } catch {
      throw new Error('无法连接本机内容服务，请检查服务是否运行后重试。');
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(typeof body?.error === 'string' ? body.error : `请求失败（HTTP ${response.status}）。`);
      error.status = response.status;
      error.retryAfter = response.headers.get('Retry-After');
      error.details = Array.isArray(body?.details) ? body.details.filter((detail) => typeof detail === 'string') : [];
      throw error;
    }
    const responseVersion = response.headers.get('ETag');
    if (!responseVersion) throw new Error('响应缺少 ETag，无法确认内容版本。');
    const result = body?.content;
    if (part === 'roadmap' ? !isRecord(result) : part === 'projects' && (!Array.isArray(result) || !result.every(isRecord))) {
      throw new Error('服务器返回的分区内容格式有误。');
    }
    return { content: part ? result : assertShape(result), version: responseVersion };
  }

  function reportError(error, action, savedParts = []) {
    const prefix = savedParts.length ? `${savedParts.join('、')}已保存。` : '';
    if (error.status === 412) {
      stale = true;
      setStatus('conflict', `${prefix}${action}遇到版本冲突。草稿已保留。`, error.details);
    } else if (error.status === 401) {
      setStatus('error', `${prefix}登录状态已失效，正在前往登录页。`);
      window.location.replace('/admin/login');
    } else if (error.status === 429) {
      const seconds = Number(error.retryAfter);
      const wait = Number.isFinite(seconds) && seconds > 0 ? `请在约 ${Math.ceil(seconds)} 秒后重试。` : '请稍后重试。';
      setStatus('error', `${prefix}尝试次数过多，${wait}`);
    } else {
      setStatus('error', `${prefix}${action}失败：${error.message}`, error.details);
    }
  }

  function clearJsonError() {
    jsonError.hidden = true;
    jsonError.textContent = '';
    raw.removeAttribute('aria-invalid');
  }

  function readRaw() {
    try {
      const parsed = canonicalizePrivateRepositories(assertShape(JSON.parse(raw.value)), draft.roadmap.privateRepositories);
      clearJsonError();
      return parsed;
    } catch (error) {
      jsonError.hidden = false;
      jsonError.textContent = error instanceof SyntaxError ? `JSON 格式有误：${error.message}` : error.message;
      raw.setAttribute('aria-invalid', 'true');
      raw.focus();
      return null;
    }
  }

  function showMode(next) {
    mode = next;
    form.hidden = form.inert = next !== 'form';
    jsonView.hidden = jsonView.inert = next !== 'json';
    formMode.setAttribute('aria-pressed', String(next === 'form'));
    jsonMode.setAttribute('aria-pressed', String(next === 'json'));
  }

  function openForm(key) {
    if (!draft || pending) return;
    if (mode === 'json') {
      const parsed = readRaw();
      if (!parsed) return;
      draft = parsed;
    }
    section = key;
    showMode('form');
    renderSection(true);
    updateControls();
  }

  function updateBaseline() {
    const savedDraft = canonicalizePrivateRepositories(structuredClone(savedContent));
    baseline = format(savedDraft);
    const privateRepositories = savedDraft.roadmap.privateRepositories;
    savedPrivateIds = new Set(Array.isArray(privateRepositories) ? privateRepositories.map(item => item?.id) : []);
    return savedDraft;
  }

  function accept({ content, version }) {
    savedContent = content;
    draft = updateBaseline();
    etag = version;
    stale = false;
    raw.value = baseline;
    clearJsonError();
    workspace.hidden = false;
    if (mode === 'form') renderSection();
  }

  function retainDraft(value) {
    const backups = byId('backups');
    const label = element('label', '', `草稿备份 ${backups.children.length + 1}`);
    const snapshot = element('textarea', 'raw-editor backup-editor');
    snapshot.id = `backup-${backups.children.length + 1}`;
    snapshot.readOnly = true;
    snapshot.spellcheck = false;
    snapshot.value = value;
    label.htmlFor = snapshot.id;
    const block = element('div', 'field');
    block.append(label, snapshot);
    backups.append(block);
    const recovery = byId('recovery');
    recovery.hidden = false;
    recovery.open = true;
  }

  async function loadContent() {
    if (pending) return;
    const backup = stale && isDirty() ? draftText() : null;
    if (backup === null && isDirty() && !window.confirm('重新读取会放弃本页未保存的修改。继续吗？')) return;
    pending = '正在读取';
    updateControls();
    setStatus('neutral', '正在读取本机内容…');
    let focusTarget;
    try {
      const next = await request('GET');
      if (backup !== null) {
        retainDraft(backup);
        showMode('json');
      }
      accept(next);
      setStatus('success', backup === null ? '已读取服务器内容。' : '已读取最新内容。旧草稿已在下方备份，可对照合并。');
      if (backup !== null) focusTarget = byId('json-title');
    } catch (error) {
      focusTarget = reportError(error, '读取');
    } finally {
      pending = '';
      updateControls();
      focusTarget?.focus();
    }
  }

  async function savePartition(part) {
    // 分区接口各自读取 ETag。服务器当前共用版本号，前一分区保存后要重新读取后一分区。
    const current = await request('GET', { part });
    if (format(current.content) !== format(savedContent[part])) {
      const error = new Error('服务器分区内容已更新。');
      error.status = 412;
      throw error;
    }
    const next = await request('PUT', { part, content: draft[part], version: current.version });
    savedContent[part] = next.content;
    draft[part] = updateBaseline()[part];
    // 只有服务器此前与完整快照一致时，才能推进全文 ETag。
    if (etag === current.version) etag = next.version;
  }

  async function saveContent() {
    if (!draft || pending || stale || !isDirty()) return;
    const content = mode === 'json' ? readRaw() : canonicalizePrivateRepositories(draft);
    if (!content) return;
    const repositoryErrors = validatePrivateRepositories(content.roadmap);
    if (repositoryErrors.length) {
      setStatus('error', '请先修正私有仓库资料，草稿已保留。', repositoryErrors);
      return;
    }
    const { roadmap, projects, ...other } = content;
    const { roadmap: savedRoadmap, projects: savedProjects, ...savedOther } = JSON.parse(baseline);
    const partitions = [];
    if (format(roadmap) !== format(savedRoadmap)) partitions.push(['roadmap', '移植路线']);
    if (format(projects) !== format(savedProjects)) partitions.push(['projects', '公开仓库']);
    const saveOther = format(other) !== format(savedOther);

    draft = content;
    pending = '正在保存';
    updateControls();
    setStatus('neutral', '正在保存内容…');
    const savedParts = [];
    let action = '保存内容';
    let acceptedFull = false;
    try {
      for (const [part, label] of partitions) {
        action = `保存「${label}」`;
        await savePartition(part);
        savedParts.push(label);
      }
      if (saveOther) {
        action = '保存其他内容';
        // 全文保存仅应用其余字段，保留两个分区的服务器版本和兼容字段。
        accept(await request('PUT', { content: { ...draft, roadmap: savedContent.roadmap, projects: savedContent.projects }, version: etag }));
        acceptedFull = true;
      } else raw.value = format(draft);
      setStatus('success', '全部内容已保存。');
    } catch (error) {
      if (savedParts.length) raw.value = format(draft);
      reportError(error, action, savedParts);
    } finally {
      if (!acceptedFull && savedParts.length && mode === 'form') renderSection();
      pending = '';
      updateControls();
    }
  }

  let fieldId = 0;

  function fields(record, definitions, onEdit) {
    const grid = element('div', 'field-grid');
    for (const [key, name, options = {}] of definitions) {
      const { kind = 'text', hint, placeholder, wide, optional, choices, maxLength, defaultChecked = false,
        valueType, min, max, step, readOnly } = options;
      const wrapper = element('div', `field${wide ? ' field-wide' : ''}${kind === 'check' ? ' field-check' : ''}`);
      const id = `field-${++fieldId}`;
      const label = element('label', '', name);
      label.htmlFor = id;
      const multiline = kind === 'area' || kind === 'tags';
      const input = element(choices ? 'select' : multiline ? 'textarea' : 'input');
      input.id = id;
      if (placeholder) input.placeholder = placeholder;
      if (choices) {
        const initial = text(record[key]);
        const empty = new Option(optional ? '不设置' : '请选择', '');
        empty.disabled = !optional;
        input.append(empty, ...Object.entries(choices).map(([value, caption]) => new Option(caption, value)));
        if (initial && !Object.hasOwn(choices, initial)) input.append(new Option(`当前值：${initial}`, initial));
        input.value = initial;
      } else if (kind === 'check') {
        input.type = 'checkbox';
        input.checked = Object.hasOwn(record, key) ? record[key] === true : defaultChecked;
      } else {
        if (multiline) input.rows = kind === 'tags' ? 2 : 3;
        else input.type = valueType === 'number' ? 'number' : kind === 'date' ? 'date' : 'text';
        if (maxLength !== undefined) input.maxLength = maxLength;
        if (readOnly) input.readOnly = true;
        if (valueType === 'number') {
          if (min !== undefined) input.min = min;
          if (max !== undefined) input.max = max;
          input.step = step ?? 'any';
        }
        if (kind === 'url' || kind === 'number') input.inputMode = kind === 'url' ? 'url' : 'numeric';
        if (['url', 'number', 'date', 'literal'].includes(kind)) {
          input.spellcheck = false;
          input.autocapitalize = 'off';
        }
        input.value = kind === 'tags' && Array.isArray(record[key]) ? record[key].join('\n') : text(record[key]);
      }
      input.addEventListener(choices || kind === 'check' || kind === 'date' ? 'change' : 'input', () => {
        if (readOnly) return;
        if (kind === 'check') record[key] = input.checked;
        else if (valueType === 'number') {
          if (input.value === '') delete record[key];
          else record[key] = input.valueAsNumber;
        }
        else if (optional && input.value === '') delete record[key];
        else if (kind === 'tags') record[key] = input.value.split('\n').map((tag) => tag.trim()).filter(Boolean);
        else record[key] = input.value;
        onEdit?.();
        updateControls();
      });
      wrapper.append(...(kind === 'check' ? [input, label] : [label, input]));
      if (hint) {
        const help = element('p', 'hint', hint);
        help.id = `${id}-help`;
        input.setAttribute('aria-describedby', help.id);
        wrapper.append(help);
      }
      grid.append(wrapper);
    }
    return grid;
  }

  function dismiss(node) {
    node.inert = true;
    node.classList.add('is-leaving');
    Promise.allSettled(node.getAnimations().map((animation) => animation.finished)).then(() => node.remove());
  }

  function optionalFields(record, key, name, definitions, initial, hint, onEdit) {
    const group = element('div', 'extra');
    const id = 'field-' + ++fieldId;
    const toggleField = element('div', 'field field-check');
    const toggle = element('input');
    toggle.type = 'checkbox';
    toggle.id = id;
    toggle.setAttribute('aria-controls', id + '-fields');
    const label = element('label', '', name);
    label.htmlFor = id;
    toggleField.append(toggle, label);
    group.append(toggleField);
    if (hint) {
      const help = element('p', 'hint', hint);
      help.id = id + '-help';
      toggle.setAttribute('aria-describedby', help.id);
      group.append(help);
    }

    let value = record[key] && typeof record[key] === 'object' && !Array.isArray(record[key]) ? record[key] : null;
    let panel;
    const mount = () => {
      panel = fields(value, definitions, onEdit);
      panel.id = id + '-fields';
      panel.classList.add('section-content');
      group.append(panel);
    };
    toggle.checked = Boolean(value);
    if (toggle.checked) mount();
    toggle.addEventListener('change', () => {
      if (toggle.checked) {
        value ??= { ...initial };
        record[key] = value;
        mount();
      } else {
        delete record[key];
        panel.removeAttribute('id');
        dismiss(panel);
        panel = null;
      }
      onEdit?.();
      updateControls();
    });
    return group;
  }

  function moveControls(noun, onMove) {
    const group = element('div', 'order-controls');
    const up = button('上移', 'button');
    const down = button('下移', 'button');
    group.append(up, down);
    up.addEventListener('click', () => onMove(-1));
    down.addEventListener('click', () => onMove(1));
    return {
      group,
      refresh(index, length) {
        up.disabled = index === 0;
        down.disabled = index === length - 1;
        up.setAttribute('aria-label', `上移第 ${index + 1} 个${noun}`);
        down.setAttribute('aria-label', `下移第 ${index + 1} 个${noun}`);
      },
      focus(direction) {
        const order = direction < 0 ? [up, down] : [down, up];
        order.find(control => !control.disabled)?.focus({ preventScroll: true });
      },
    };
  }

  function moveEntry(models, model, direction, container) {
    const from = models.indexOf(model);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= models.length) return;
    const animate = model.node.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const affected = [model.node, models[to].node];
    const positions = animate ? affected.map(node => node.getBoundingClientRect().top) : [];
    models.splice(from, 1);
    models.splice(to, 0, model);
    container.insertBefore(model.node, models[to + 1]?.node || null);
    if (animate) affected.forEach((node, index) => {
      const offset = positions[index] - node.getBoundingClientRect().top;
      node.animate([{ transform: `translateY(${offset}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
    return { from, to };
  }

  function list(entries, config) {
    const group = element('div', 'list-group');
    const listHeader = element('div', 'list-header');
    const listInfo = element('div', 'list-info');
    const count = element('p', 'hint list-count');
    count.setAttribute('role', 'status');
    listInfo.append(element('h3', '', config.label), count);
    const add = button(`添加${config.noun}`);
    listHeader.append(listInfo, add);
    group.append(listHeader);

    const cards = [];
    const items = element('div', 'entries');
    const empty = element('p', 'empty-state');
    let search;
    if (config.search) {
      const searchBox = element('div', 'field search-box');
      const searchLabel = element('label', '', '搜索公开仓库');
      searchLabel.htmlFor = 'project-search';
      search = element('input');
      search.type = 'search';
      search.id = searchLabel.htmlFor;
      search.placeholder = '输入标题、仓库名、标签或状态';
      search.value = projectQuery;
      search.addEventListener('input', () => {
        projectQuery = search.value;
        refresh();
      });
      searchBox.append(searchLabel, search);
      group.append(searchBox);
    }
    group.append(items, empty);

    function refresh() {
      const query = search?.value.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      let shown = 0;
      cards.forEach((card, index) => {
        card.number.textContent = String(index + 1).padStart(2, '0');
        card.order?.refresh(index, cards.length);
        const matches = !query.length || query.every((word) => config.search(card.item).includes(word));
        card.node.hidden = !matches;
        if (matches) shown += 1;
      });
      const limit = Number.isInteger(config.maximum) ? ` · 最多 ${config.maximum} 项` : '';
      count.textContent = query.length ? `显示 ${shown} / ${cards.length} 项${limit}` : `共 ${cards.length} 项${limit} · 展开条目即可编辑`;
      add.disabled = Number.isInteger(config.maximum) && entries.length >= config.maximum;
      empty.textContent = query.length ? '没有符合条件的条目。' : `还没有${config.noun}。`;
      empty.hidden = shown !== 0;
    }

    function addCard(item) {
      const node = element('details', 'entry');
      const summary = element('summary', 'entry-summary');
      const number = element('span', 'entry-number');
      number.setAttribute('aria-hidden', 'true');
      const title = element('span', 'entry-title');
      const subtitle = element('span', 'entry-meta');
      const name = () => text(item[config.titleKey ?? 'title']) || `未命名${config.noun}`;
      function refreshLabel() {
        title.textContent = name();
        subtitle.textContent = config.meta?.(item) ?? '';
        subtitle.hidden = !subtitle.textContent;
      }
      const summaryContent = element('span', 'entry-label');
      summaryContent.append(number, title, subtitle);
      summary.append(summaryContent);
      node.append(summary);
      const card = { node, summary, number, item, expand };
      refreshLabel();
      cards.push(card);
      items.append(node);

      let body;
      function hydrate() {
        if (body) return body;
        body = element('div', 'entry-body');
        const onEdit = () => {
          refreshLabel();
          config.onChange?.();
        };
        const definitions = typeof config.fields === 'function' ? config.fields(item) : config.fields;
        body.append(fields(item, definitions, onEdit));
        if (config.buildExtra) body.append(config.buildExtra(item, onEdit));
        if (config.extra) {
          const extra = element('details', 'extra');
          extra.append(element('summary', '', config.extraLabel ?? '更多资料（可选）'), fields(item, config.extra, onEdit));
          body.append(extra);
        }
        const remove = button(`移除${config.noun}`, 'button danger');
        remove.addEventListener('click', () => {
          const index = cards.indexOf(card);
          if (index < 0) return;
          if (config.minimum && entries.length <= config.minimum) {
            setStatus('error', `请至少保留 ${config.minimum} 个${config.noun}。`);
            return;
          }
          if (!window.confirm(`移除「${name().slice(0, 80)}」？保存前不会改动服务器。`)) return;
          entries.splice(index, 1);
          cards.splice(index, 1);
          config.onRemove?.(index, item);
          config.onChange?.();
          dismiss(node);
          refresh();
          const next = [cards[index], cards[index - 1]].find((entry) => entry && !entry.node.hidden);
          (next?.summary ?? add).focus();
          updateControls();
        });
        const actions = element('div', 'entry-actions');
        if (config.reorder) {
          card.order = moveControls(config.noun, direction => {
            const position = moveEntry(cards, card, direction, items);
            if (!position) return;
            const [moved] = entries.splice(position.from, 1);
            entries.splice(position.to, 0, moved);
            refresh();
            card.order.focus(direction);
            updateControls();
          });
          card.order.refresh(cards.indexOf(card), cards.length);
          actions.append(card.order.group);
        }
        actions.append(remove);
        body.append(actions);
        node.append(body);
        return body;
      }

      function expand() {
        node.open = true;
        hydrate().querySelector('input:not([readonly]), textarea:not([readonly]), select')?.focus();
      }
      node.addEventListener('toggle', () => { if (node.open) hydrate(); });
      return card;
    }

    for (const item of entries) addCard(item);
    refresh();
    add.addEventListener('click', () => {
      if (Number.isInteger(config.maximum) && entries.length >= config.maximum) {
        setStatus('error', `${config.noun}最多可添加 ${config.maximum} 个。`);
        return;
      }
      if (search) search.value = projectQuery = '';
      const item = config.blank();
      entries.push(item);
      const card = addCard(item);
      config.onChange?.();
      refresh();
      card.expand();
      updateControls();
    });
    return group;
  }

  function linkListEditor(record, key, config, onEdit) {
    const editor = element('div', 'link-editor');
    const heading = element('div', 'link-editor-heading');
    const name = element('p', 'link-editor-title', config.title);
    name.id = `field-${++fieldId}`;
    editor.setAttribute('role', 'group');
    editor.setAttribute('aria-labelledby', name.id);
    const count = element('p', 'hint');
    count.setAttribute('role', 'status');
    const info = element('div');
    info.append(name, count);
    const add = button(`添加${config.noun}`);
    heading.append(info, add);
    const entries = element('div', 'link-editor-rows');
    editor.append(heading, element('p', 'hint', config.hint), entries);

    const rows = [];
    const initial = Array.isArray(record[key]) ? record[key] : config.legacy ? [config.legacy] : [];
    const min = config.min ?? 0;
    const commit = () => {
      record[key] = rows.map(({ value }) => ({ ...value, label: text(value.label).trim(), url: text(value.url).trim() }));
      onEdit?.();
    };

    function refresh() {
      count.textContent = `${rows.length} / ${config.max} 个${config.noun}`;
      add.disabled = rows.length >= config.max;
      rows.forEach(({ remove, order }, index) => {
        order?.refresh(index, rows.length);
        remove.disabled = rows.length <= min;
        remove.setAttribute('aria-label', `移除第 ${index + 1} 个${config.noun}`);
      });
    }

    function addRow(value) {
      const node = element('div', 'link-editor-row');
      const inputs = fields(value, [
        ['label', '按钮文字', { maxLength: config.maxLabel, placeholder: config.placeholder }],
        ['url', '链接', { ...link, maxLength: 2048, placeholder: config.urlPlaceholder ?? 'https://…' }],
      ], commit);
      const remove = button('移除', 'button danger');
      const row = { node, value, remove, input: inputs.querySelector('input') };
      remove.addEventListener('click', () => {
        const index = rows.indexOf(row);
        if (index < 0 || rows.length <= min) return;
        rows.splice(index, 1);
        dismiss(node);
        commit();
        refresh();
        (rows[index]?.input ?? rows[index - 1]?.input ?? add).focus();
        updateControls();
      });
      if (config.reorder) {
        row.order = moveControls(config.noun, direction => {
          if (!moveEntry(rows, row, direction, entries)) return;
          commit();
          refresh();
          row.order.focus(direction);
          updateControls();
        });
        const actions = element('div', 'link-row-actions');
        actions.append(row.order.group, remove);
        node.append(inputs, actions);
      } else node.append(inputs, remove);
      entries.append(node);
      rows.push(row);
      return row;
    }

    for (const value of initial) addRow({ ...value });
    refresh();
    add.addEventListener('click', () => {
      if (rows.length >= config.max) return;
      const row = addRow({ label: '', url: '' });
      commit();
      refresh();
      row.input.focus();
      updateControls();
    });
    return editor;
  }

  const projectTypes = { runner: '运行器 / 兼容层', tool: '工具层', resource: '配套资源', adjacent: '其他代际（参考）' };
  const projectStatuses = { progress: '活跃开发中', early: '早期 / 停滞', tool: '工具（不运行游戏）', reference: '资料 / 参考' };
  const caption = (map, key) => Object.hasOwn(map, key) ? map[key] : text(key);
  const dateHelp = { kind: 'literal', hint: '填 YYYY-MM-DD；有确切时分时，可填带时区的 ISO 时间。' };
  const link = { kind: 'url' };
  const paragraph = { kind: 'area', wide: true };

  const evidenceLevels = {
    unverified: '有待核对',
    'self-reported': '项目方自述',
    demonstrated: '有公开演示',
    reproduced: '已有独立复现',
  };

  function homeNewsFields(home, news) {
    const group = element('div', 'section-body');
    const choices = news.filter(item => text(item.id) && text(item.title))
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    const sourceField = element('div', 'field field-wide');
    const source = element('select');
    source.id = 'home-news-source';
    const sourceLabel = element('label', '', '下方新闻链接');
    sourceLabel.htmlFor = source.id;
    const autoMode = home.autoNewsCount === 1 ? 'auto-one' : 'auto-two';
    source.append(
      new Option('自动显示最新 1 条', 'auto-one'),
      new Option('自动显示最新 2 条', 'auto-two'),
      new Option('手动选一到两条', 'manual'),
      new Option('隐藏', 'hidden'),
    );
    source.value = Array.isArray(home.newsIds) ? (home.newsIds.length ? 'manual' : 'hidden') : autoMode;
    sourceField.append(sourceLabel, source);
    const selection = element('div', 'field-grid section-content');
    selection.id = 'home-news-selection';
    source.setAttribute('aria-controls', selection.id);
    const selects = [0, 1].map((index) => {
      const field = element('div', 'field');
      const input = element('select');
      input.id = 'home-news-' + (index + 1);
      const label = element('label', '', '第 ' + (index + 1) + ' 条');
      label.htmlFor = input.id;
      field.append(label, input);
      selection.append(field);
      return input;
    });
    const help = element('p', 'hint field-wide', '只会显示仍在新闻时间线里的条目。新增新闻后也可以在这里选择。');
    selection.append(help);

    let manual = Array.isArray(home.newsIds) && home.newsIds.length ? [...home.newsIds] : choices.slice(0, 2).map(item => item.id);
    function refresh() {
      const visible = source.value === 'manual';
      selection.hidden = !visible;
      if (!visible) return;
      selects.forEach((input, index) => {
        const value = manual[index] || '';
        input.replaceChildren(new Option('不显示这一条', ''), ...choices.map(item => {
          const option = new Option([text(item.date), item.title].filter(Boolean).join(' · '), item.id);
          option.disabled = manual[1 - index] === item.id;
          return option;
        }));
        if (value && !choices.some(item => item.id === value)) input.append(new Option('所选新闻已移除', value));
        input.value = value;
      });
    }
    selects.forEach((input, index) => input.addEventListener('change', () => {
      manual[index] = input.value;
      home.newsIds = manual.filter(Boolean);
      refresh();
      updateControls();
    }));
    source.addEventListener('change', () => {
      if (source.value === 'auto-one' || source.value === 'auto-two') {
        delete home.newsIds;
        home.autoNewsCount = source.value === 'auto-one' ? 1 : 2;
      } else {
        home.newsIds = source.value === 'manual' ? manual.filter(Boolean) : [];
      }
      refresh();
      updateControls();
    });
    group.append(sourceField, selection);
    refresh();
    return group;
  }

  function gameplayProgressEditor(route) {
    const group = element('div', 'extra gameplay-progress');
    group.append(
      element('h3', '', '游戏进度（可选）'),
      element('p', 'hint', '记录游戏内达到的阶段。项目方自述和已核实的阶段需要附上依据。')
    );
    const content = element('div', 'gameplay-progress-content');
    group.append(content);

    function showIssue(message) {
      content.append(element('p', 'field-error', message));
    }

    function render() {
      content.replaceChildren();
      if (!Object.hasOwn(route, 'gameplayProgress')) {
        const add = button('添加游戏进度');
        add.addEventListener('click', () => {
          route.gameplayProgress = { milestones: [] };
          updateControls();
          render();
          content.querySelector('.list-header .button')?.focus();
        });
        content.append(add);
        return;
      }

      const progress = route.gameplayProgress;
      const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
      if (!object(progress)) {
        showIssue('游戏进度格式不符，未修改数据。请在 JSON 模式检查 roadmap.gameplayProgress。');
        return;
      }
      if (!Array.isArray(progress.milestones) || !progress.milestones.every(object)) {
        showIssue('里程碑列表格式不符，未修改数据。请在 JSON 模式检查 milestones。');
        return;
      }

      content.append(fields(progress, [
        ['title', '进度标题', { optional: true, maxLength: 24, hint: '最多 24 个字符。' }],
        ['note', '进度说明', { kind: 'area', optional: true, wide: true, maxLength: 240, hint: '最多 240 个字符。' }],
      ]));
      content.append(list(progress.milestones, {
        label: '游戏进度里程碑',
        noun: '里程碑',
        titleKey: 'label',
        minimum: 1,
        maximum: 12,
        reorder: true,
        extraLabel: '依据与来源',
        fields: [
          ['id', '稳定 ID', { kind: 'literal', wide: true, hint: '仅在需要时修改；必须唯一并使用小写字母、数字和连字符。' }],
          ['label', '显示名称', { maxLength: 24 }],
          ['status', '状态', { choices: gameplayStatuses, hint: '「项目方自述」和「已核实」需补充依据及 HTTPS 链接。' }],
        ],
        extra: [
          ['evidence', '依据说明', { optional: true, maxLength: 160, wide: true, hint: '自述和已核实的阶段必填，最多 160 字。' }],
          ['sourceUrl', 'HTTPS 来源', { kind: 'url', optional: true, maxLength: 2048, wide: true, placeholder: 'https://…', hint: '自述和已核实的阶段必填。' }],
        ],
        blank: () => ({ id: `milestone-${crypto.randomUUID()}`, label: '', status: '' }),
        meta: (item) => Object.hasOwn(gameplayStatuses, item.status) ? gameplayStatuses[item.status] : text(item.status),
      }));

      const actions = element('div', 'entry-actions gameplay-progress-actions');
      const remove = button('移除游戏进度', 'button danger');
      remove.addEventListener('click', async () => {
        if (!window.confirm('移除整个游戏进度？保存后会删除其中的标题、说明和全部里程碑。')) return;
        pending = '正在移除游戏进度';
        updateControls();
        content.inert = true;
        content.classList.add('is-leaving');
        try {
          await Promise.allSettled(content.getAnimations().map((animation) => animation.finished));
          delete route.gameplayProgress;
        } finally {
          content.inert = false;
          content.classList.remove('is-leaving');
          pending = '';
          updateControls();
          render();
          content.querySelector('button')?.focus();
        }
      });
      actions.append(remove);
      content.append(actions);
    }

    render();
    return group;
  }

  function canonicalizePrivateRepositories(content, draftEntries) {
    const route = content.roadmap;
    if (!Object.hasOwn(route, 'privateRepositories')) {
      const legacy = route.communityBuild;
      if (Array.isArray(draftEntries)) {
        // Omitting the list while editing another field is not a request to clear it.
        route.privateRepositories = draftEntries;
      } else if (isRecord(legacy)) {
        const { title, summary, sourceLabel, sourceUrl, portProgress } = legacy;
        const id = 'legacy';
        route.privateRepositories = [{ id, title, summary, sourceLabel, sourceUrl, portProgress }];
      }
    }
    if (Array.isArray(route.privateRepositories)) delete route.communityBuild;
    return content;
  }

  const privateRepositoryTextFields = [
    ['title', '公开标题', { maxLength: 120 }],
    ['summary', '项目简介', { kind: 'area', wide: true, maxLength: 800 }],
    ['sourceLabel', '公开依据名称', { maxLength: 80 }],
  ];

  function validatePrivateRepositories(route) {
    if (!Object.hasOwn(route, 'privateRepositories')) return [];
    const entries = route.privateRepositories;
    if (!Array.isArray(entries) || entries.length > MAX_PRIVATE_REPOSITORIES) {
      return [`私有仓库需要 0–${MAX_PRIVATE_REPOSITORIES} 条记录。`];
    }
    const errors = [];
    const ids = new Set();
    entries.forEach((item, index) => {
      const label = `私有仓库第 ${index + 1} 条`;
      if (!isRecord(item)) { errors.push(`${label}必须是对象。`); return; }
      const { id, sourceUrl } = item;
      if (typeof id !== 'string' || id.length > 48 || id.trim() !== id || !PRIVATE_ID.test(id)) {
        errors.push(`${label}：标识必须是 1–48 位小写字母、数字或分隔用的短横线。`);
      } else if (ids.has(id)) errors.push(`${label}：标识「${id}」重复。`);
      else ids.add(id);
      for (const [key, name, { maxLength }] of privateRepositoryTextFields) {
        const value = item[key];
        if (typeof value !== 'string' || !value.trim() || value.length > maxLength || value.includes('\0')) {
          errors.push(`${label}：${name}需要 1–${maxLength} 个字符。`);
        }
      }
      let evidence;
      if (typeof sourceUrl === 'string' && sourceUrl.length <= 2048 && /^https:\/\/[^/?#]/i.test(sourceUrl) &&
          !/[\u0000-\u0020\u007f\\]/.test(sourceUrl)) {
        try { evidence = new URL(sourceUrl); } catch { /* Invalid URL. */ }
      }
      if (!evidence?.hostname || evidence.protocol !== 'https:' || evidence.username || evidence.password) {
        errors.push(`${label}：请填写不带登录凭据的公开 HTTPS 依据链接。`);
      }
      if (!isRecord(item.portProgress)) errors.push(`${label}：缺少移植评分记录。`);
    });
    return errors;
  }

  function privateRepositoriesEditor(route) {
    const entries = route.privateRepositories ?? [];
    if ((Object.hasOwn(route, 'privateRepositories') && !Array.isArray(route.privateRepositories)) || !entries.every(isRecord)) {
      const group = element('div', 'list-group');
      const header = element('div', 'list-header');
      header.append(element('h3', '', '私有仓库'));
      group.append(header,
        element('p', 'field-error', '私有仓库列表格式不符，数据已保留。请在原始 JSON 中检查 roadmap.privateRepositories。'));
      return group;
    }
    return list(entries, {
      label: '私有仓库', noun: '私有仓库', maximum: MAX_PRIVATE_REPOSITORIES,
      fields: item => {
        const readOnly = savedPrivateIds.has(item.id) && entries.find(entry => entry.id === item.id) === item;
        return [
          ['id', '稳定标识', { kind: 'literal', maxLength: 48, readOnly, placeholder: '例如 sample-launch',
            hint: readOnly ? undefined : '小写字母、数字与短横线。保存后固定。' }],
          ...privateRepositoryTextFields,
          ['sourceUrl', '公开 HTTPS 依据', { ...link, maxLength: 2048, placeholder: 'https://…',
            hint: '只填无需登录即可查看的证据，不填私有仓库地址。' }],
        ];
      },
      blank: () => ({ id: '', title: '', summary: '', sourceLabel: '', sourceUrl: '', portProgress: {} }),
      meta: item => text(item.id),
      onChange: () => { route.privateRepositories = entries; },
      buildExtra: item => {
        const progress = element('details', 'private-repository-progress');
        const summary = '移植评分';
        progress.append(element('summary', '', summary), portProgressEditor(item, undefined, { required: true }));
        return progress;
      },
    });
  }

  function portProgressEditor(project, onEdit, { required = false } = {}) {
    const ppVerifications = { verified: '已独立复测', 'self-reported': '项目方自述', unverified: '待核实' };
    const ppStabilities = { unknown: '未知', constant: '频繁崩溃', often: '经常崩溃', sometimes: '偶尔崩溃', rarely: '很少崩溃', stable: '稳定' };
    const group = element('div', required ? 'port-progress' : 'extra port-progress');
    const id = 'field-' + ++fieldId;
    const toggleField = element('div', 'field field-check');
    const toggle = element('input');
    toggle.type = 'checkbox';
    toggle.id = id;
    toggle.setAttribute('aria-controls', id + '-fields');
    const label = element('label', '', '移植进度评分（portProgress）');
    label.htmlFor = id;
    toggleField.append(toggle, label);
    if (!required) group.append(toggleField, element('p', 'hint', '填写基础准备各项进度、GTA VI 运行状态和评估信息。评分由系统计算，不需要手填。'));

    let pp = isRecord(project.portProgress) ? project.portProgress : null;
    toggle.checked = Boolean(pp);

    let panel;
    const mount = () => {
      pp ??= {};
      const groundwork = isRecord(pp.groundwork) ? pp.groundwork : {};
      const gta = isRecord(pp.gta) ? pp.gta : {};
      const edited = () => {
        project.portProgress = pp;
        onEdit?.();
        updateControls();
      };

      panel = element('div', 'section-content');
      panel.id = id + '-fields';

      // groundwork sub-fields
      const gwHead = element('p', 'hint', '基础准备（各项 0–1，系统自动加权）');
      panel.append(gwHead);
      panel.append(fields(groundwork, [
        ['loader',   '加载器与系统库',   { kind: 'number', maxLength: 4, placeholder: '0–1', hint: '权重 0.20' }],
        ['shaders',  '着色器翻译',       { kind: 'number', maxLength: 4, placeholder: '0–1', hint: '权重 0.28' }],
        ['graphics', '图形层',           { kind: 'number', maxLength: 4, placeholder: '0–1', hint: '权重 0.32' }],
        ['proven',   '其他游戏已验证',   { kind: 'number', maxLength: 4, placeholder: '0–1', hint: '权重 0.20' }],
      ], () => {
        for (const key of ['loader', 'shaders', 'graphics', 'proven']) {
          const value = parseFloat(groundwork[key]);
          if (Number.isFinite(value)) groundwork[key] = Math.min(1, Math.max(0, value));
          else delete groundwork[key];
        }
        pp.groundwork = groundwork;
        edited();
      }));

      // gta ladder
      const gtaHead = element('p', 'hint field-wide', 'GTA VI 运行进度（0 未达到，小数表示部分达到，1 达到）');
      gtaHead.id = id + '-gta-help';
      panel.append(gtaHead);
      const gtaGrid = element('div', 'field-grid');
      for (const [k, lbl] of [['loads','程序运行（15%）'],['boots','首帧画面（30%）'],['menu','主菜单（35%）'],['ingame','进入游戏（40%）'],['prison','进入监狱序章（50%）']]) {
        const fid = 'field-' + ++fieldId;
        const fwrap = element('div', 'field');
        const flabel = element('label', '', lbl); flabel.htmlFor = fid;
        const input = element('input');
        input.id = fid;
        input.type = 'number';
        input.inputMode = 'decimal';
        input.min = '0'; input.max = '1'; input.step = 'any';
        input.placeholder = '0–1';
        input.setAttribute('aria-describedby', gtaHead.id);
        input.value = typeof gta[k] === 'boolean' ? String(Number(gta[k])) : text(gta[k]);
        input.addEventListener('input', () => {
          if (input.validity.badInput) gta[k] = null; // Reject malformed input on save rather than clearing the field.
          else if (input.value === '') delete gta[k];
          else gta[k] = input.valueAsNumber;
          pp.gta = gta;
          edited();
        });
        fwrap.append(flabel, input); gtaGrid.append(fwrap);
      }
      // fps and stability
      const fpsFid = 'field-' + ++fieldId;
      const fpsWrap = element('div', 'field'); const fpsLabel = element('label', '', '帧率（旧记录）'); fpsLabel.htmlFor = fpsFid;
      const fpsInput = element('input'); fpsInput.id = fpsFid; fpsInput.type = 'text'; fpsInput.inputMode = 'numeric';
      fpsInput.placeholder = '0–240'; fpsInput.value = text(gta.fps);
      fpsInput.addEventListener('input', () => {
        const value = parseFloat(fpsInput.value);
        if (Number.isFinite(value) && value >= 0 && value <= 240) gta.fps = value;
        else delete gta.fps;
        pp.gta = gta;
        edited();
      });
      fpsWrap.append(fpsLabel, fpsInput); gtaGrid.append(fpsWrap);

      const stabFid = 'field-' + ++fieldId;
      const stabWrap = element('div', 'field'); const stabLabel = element('label', '', '稳定性（旧记录）'); stabLabel.htmlFor = stabFid;
      const stabSel = element('select'); stabSel.id = stabFid;
      stabSel.append(new Option('未填', ''), ...Object.entries(ppStabilities).map(([v,cap]) => new Option(cap, v)));
      stabSel.value = gta.stability || '';
      stabSel.addEventListener('change', () => {
        if (stabSel.value) gta.stability = stabSel.value;
        else delete gta.stability;
        pp.gta = gta;
        edited();
      });
      stabWrap.append(stabLabel, stabSel); gtaGrid.append(stabWrap);
      panel.append(gtaGrid, element('p', 'hint', 'V5 在「原始 JSON」填 portProgress.gta.qualityV5。旧帧率和稳定性字段保留作历史，不计入 V5。'));

      // other fields
      panel.append(fields(pp, [
        ['provenOn', '在哪款游戏上验证过（可选）', { optional: true, maxLength: 100, placeholder: '例如 Halo Infinite' }],
        ['verification', '核验状态', { choices: ppVerifications }],
        ['assessedAt', '评估日期', { kind: 'date', optional: true }],
      ], edited));

      // works / blocking lists
      for (const [listKey, listTitle] of [['works','已经能做到（每行一条，最多 6 条）'],['blocking','卡在哪里（每行一条，最多 6 条）']]) {
        const lid = 'field-' + ++fieldId;
        const lwrap = element('div', 'field field-wide');
        const llabel = element('label', '', listTitle); llabel.htmlFor = lid;
        const ta = element('textarea'); ta.id = lid; ta.rows = 3;
        ta.value = Array.isArray(pp[listKey]) ? pp[listKey].join('\n') : '';
        ta.addEventListener('input', () => {
          const lines = ta.value.split('\n').map(s=>s.trim()).filter(Boolean).slice(0, 6);
          if (lines.length) pp[listKey] = lines; else delete pp[listKey];
          edited();
        });
        lwrap.append(llabel, ta); panel.append(lwrap);
      }

      group.append(panel);
    };

    if (required || toggle.checked) mount();

    toggle.addEventListener('change', () => {
      if (toggle.checked) {
        project.portProgress = pp ??= {};
        mount();
        onEdit?.();
        updateControls();
      } else {
        delete project.portProgress;
        pp = null;
        if (panel) { panel.removeAttribute('id'); dismiss(panel); panel = null; }
        onEdit?.();
        updateControls();
      }
    });
    return group;
  }

  const editors = {
    home: {
      title: '首页动态',
      intro: '写一句话放在「即将进入雷奥奈达」下面。社区说法请注明是谁说的。',
      build() {
        const body = element('div', 'section-body');
        body.append(fields(draft.home, [['latestUpdate', '最新动态', { wide: true, maxLength: 130 }]]), homeNewsFields(draft.home, draft.news));
        return body;
      },
    },
    countdown: {
      title: '社区倒计时',
      intro: '关闭只会隐藏首页倒计时，时间和出处仍会保留。社区给出的时间不是 Rockstar 的发售承诺。',
      build() {
        const countdown = draft.countdown;
        const body = element('div', 'section-body');
        body.append(fields(countdown, [
          ['enabled', '在首页显示倒计时', { kind: 'check', wide: true, defaultChecked: true }],
          ['label', '倒计时标题', { wide: true, hint: '倒计时结束前显示在首页。' }],
          ['target', '目标时间（含时区）', { kind: 'literal', wide: true, hint: '保留时区偏移，例如 2026-11-24T01:00:00+08:00。' }],
          ['source', '时间来源', { wide: true }],
        ]), linkListEditor(countdown, 'buttons', {
          title: '倒计时按钮', noun: '按钮', max: 3, maxLabel: 25,
          hint: '使用 HTTPS 链接。移除所有按钮后，首页只显示倒计时信息。',
          placeholder: '例如 查看公告',
          legacy: countdown.officialUrl ? { label: '活动来源', url: countdown.officialUrl } : null,
        }));
        return body;
      },
    },
    playability: {
      intro: '更新首页「现在能玩吗？」展示的结论和依据。',
      build() {
        return optionalFields(draft.roadmap, 'playability', '填写可玩情况', [
          ['status', '当前可玩状态', { choices: {
            unplayable: '红·不能玩',
            unstable: '黄·能进入游戏，运行不稳定',
            playable: '绿·可以畅玩',
          }, optional: true, wide: true }],
          ['summary', '当前结论', { wide: true, maxLength: 110 }],
          ['sourceUrl', '依据链接（可选）', { ...link, optional: true, wide: true }],
        ], { summary: '' }, '只填写能核对的运行结果。未填写时，前台仍会显示默认判断。');
      },
    },
    roadmap: {
      intro: '维护有公开依据的游戏内阶段。',
      build: () => gameplayProgressEditor(draft.roadmap),
    },
    news: {
      title: '新闻时间线',
      intro: '一条新闻只讲一件事。分清已核实的进展、项目自述和传闻。',
      build: () => list(draft.news, {
        label: '时间线条目', noun: '新闻',
        fields: [
          ['title', '新闻标题', { wide: true }], ['date', '日期 / 时间', dateHelp],
          ['repo', '关联仓库（可选）', { kind: 'literal', placeholder: 'owner/name' }],
          ['sourceUrl', '原文链接（可选）', { ...link, optional: true, wide: true }],
          ['correction', '标记为更正', { kind: 'check', wide: true }],
        ],
        blank: () => ({ id: 'item-' + crypto.randomUUID(), title: '', date: '', repo: '' }),
        meta: (item) => [item.correction === true ? '更正' : '', text(item.date), text(item.repo)].filter(Boolean).join(' · '),
      }),
    },
    announcements: {
      title: '站公告',
      intro: '保留原文入口。核对来源后再更新日期；中文摘要不要加入未核实的下载链接。',
      build() {
        const body = element('div', 'section-body');
        body.append(fields(draft.announcements, [['source', '公告原文链接', link], ['checkedOn', '最后核对日期', { kind: 'date' }]]));
        body.append(list(draft.announcements.items, {
          label: '公告条目', noun: '公告',
          fields: [['title', '公告标题'], ['datetime', '公告日期 / 时间', dateHelp], ['summary', '中文摘要', paragraph]],
          buildExtra: (item, onEdit) => linkListEditor(item, 'buttons', {
            title: '跳转按钮', noun: '按钮', max: 3, maxLabel: 35,
            hint: '站内可填 #downloads（下载分区）或 #timeline（新闻时间线）。外站填写完整网址。',
            placeholder: '例如 前往下载分区', urlPlaceholder: '#downloads 或 https://…',
          }, onEdit),
          blank: () => ({ title: '', datetime: '', summary: '' }),
          meta: (item) => text(item.datetime),
        }));
        return body;
      },
    },
    downloads: {
      title: '下载分区',
      intro: '说明条目的用途及限制。本页不会打开链接或下载文件。',
      build() {
        const body = element('div', 'section-body');
        body.append(fields(draft.downloads, [['note', '分区说明', paragraph]]));
        body.append(list(draft.downloads.items, {
          label: '下载条目', noun: '下载项', reorder: true,
          fields: [['title', '下载项名称', { wide: true }], ['description', '用途说明', paragraph]],
          buildExtra: (item, onEdit) => linkListEditor(item, 'channels', {
            title: '下载渠道', noun: '渠道', min: 1, max: 12, maxLabel: 35, reorder: true,
            hint: '支持 HTTPS 链接。每个下载项至少保留一个渠道。下架时请移除整个下载项。',
            placeholder: '例如 项目文档',
            legacy: { label: '下载资源', url: text(item.url) },
          }, onEdit),
          blank: () => ({ title: '', description: '', channels: [{ label: '', url: '' }] }),
        }));
        return body;
      },
    },
    projects: {
      title: '工程档案',
      intro: '分别维护私有和公开仓库的进展。用短标题和一句摘要说清项目能做什么。',
      build() {
        const body = element('div', 'section-body');
        const publicRepositories = list(draft.projects, {
          label: '公开仓库', noun: '公开仓库',
          fields: [
            ['title', '公开标题'], ['repo', 'GitHub 仓库', { kind: 'literal', placeholder: 'owner/name' }],
            ['type', '类型', { choices: projectTypes }], ['status', '状态', { choices: projectStatuses }],
            ['progress', '最新进度', { wide: true, maxLength: 250, hint: '一句话说明最新进展，最多 250 个字符。' }],
            ['summary', '简短摘要', paragraph],
          ],
          buildExtra: (item, onEdit) => {
            const extras = document.createDocumentFragment();
            extras.append(optionalFields(item, 'evidence', '显示测试记录', [
              ['tested', '测试了什么，结果如何', { wide: true, maxLength: 80, placeholder: '例如：自带的示例程序已显示画面' }],
              ['level', '证据级别', { choices: evidenceLevels }],
              ['sourceUrl', '依据链接', { ...link, optional: true, hint: '公开演示或独立复现必须有 HTTPS 链接。' }],
              ['blocker', '还卡在哪（可选）', { wide: true, optional: true, maxLength: 150 }],
            ], { tested: '', level: 'unverified' }, '写清测试对象和结果。关闭后清除测试记录。', onEdit),
            portProgressEditor(item, onEdit));
            return extras;
          },
          extra: [
            ['url', '项目原文链接', { ...link, optional: true, wide: true }],
            ['id', '项目标识', { kind: 'literal', optional: true }], ['logo', '图标路径（不加载预览）', { ...link, optional: true }],
            ['game', '涉及游戏', { optional: true }], ['highlight', '亮点标签', { optional: true }],
            ['tags', '标签', { kind: 'tags', hint: '每行一个标签。', optional: true, wide: true }],
            ['headline', '项目进展标题', { optional: true, wide: true }],
            ['state', '详细进展', { ...paragraph, optional: true }], ['approach', '实现方式', { ...paragraph, optional: true }],
            ['licenseNote', '许可说明', { optional: true }], ['authorNote', '作者说明', { ...paragraph, optional: true }],
          ],
          blank: () => ({ title: '', repo: '', type: '', status: '', progress: '', summary: '' }),
          meta: (item) => [text(item.repo), caption(projectStatuses, item.status)].filter(Boolean).join(' · '),
          search: (item) => [item.title, item.repo, item.type, item.status, item.game, item.highlight,
            caption(projectTypes, item.type), caption(projectStatuses, item.status), ...(Array.isArray(item.tags) ? item.tags : [])]
            .map(text).join(' ').toLowerCase(),
        });
        body.append(privateRepositoriesEditor(draft.roadmap), publicRepositories);
        return body;
      },
    },
  };

  // 页头标题和导航高亮由 shell.js 按路由更新；这里只渲染分区说明和表单。
  function renderSection(focus = false) {
    const editor = editors[section];
    intro.textContent = editor.intro;
    const panel = element('div', 'section-content');
    panel.append(editor.build());
    form.replaceChildren(panel);
    if (focus) byId('editorial-title').focus({ preventScroll: true });
  }

  function enterSection(key) {
    if (!Object.hasOwn(editors, key)) return;
    if (!draft) {
      section = key;
      intro.textContent = editors[key].intro;
      return;
    }
    if (mode === 'json' && key === section) return;
    openForm(key);
  }

  window.AdminShell?.register('content', {
    canEnter(route) {
      if (pending) return `${pending}，请稍候再切换分区。`;
      if (draft && mode === 'json' && route.part !== section && !readRaw()) return '原始 JSON 有误，修正后才能切换分区。';
      return true;
    },
    enter(route) { enterSection(route.part); },
    dirty() { return isDirty() ? '内容编辑' : ''; },
  });
  if (!window.AdminShell) intro.textContent = editors[section].intro;
  formMode.addEventListener('click', () => { if (mode !== 'form') openForm(section); });
  jsonMode.addEventListener('click', () => {
    if (!draft || pending || mode === 'json') return;
    raw.value = format(draft);
    clearJsonError();
    showMode('json');
    byId('json-title').focus();
    updateControls();
  });
  raw.addEventListener('input', () => {
    clearJsonError();
    updateControls();
  });
  reload.addEventListener('click', loadContent);
  save.addEventListener('click', saveContent);
  loadContent();
})();
