(() => {
  'use strict';

  const main = document.querySelector('[data-hardware-check]');
  if (!main) return;
  const { locale, t: translate } = window.SiteI18n;
  const t = (key, fallback, values) => translate(`pages.hardwareCheck.${key}`, fallback, values);
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const find = selector => main.querySelector(selector);
  const targetSelect = find('[data-hc-target]');
  const storageSelect = find('[data-hc-storage]');
  const ram = find('[data-hc-ram]');
  const ramError = find('[data-hc-ram-error]');
  const table = find('[data-hc-targets]');
  const verdict = find('[data-hc-verdict]');
  const verdictTitle = find('[data-hc-verdict-title]');
  const verdictCopy = find('[data-hc-verdict-copy]');
  const feed = find('[data-hc-feed]');
  const status = find('[data-hc-status]');
  const retry = find('[data-hc-retry]');
  const partRows = main.querySelectorAll('[data-hc-part]');
  const pickers = ['gpu', 'cpu'].map(kind => ({
    kind, input: find(`[data-hc-search="${kind}"]`), select: find(`[data-hc-model="${kind}"]`),
    info: find(`[data-hc-model-info="${kind}"]`),
  }));
  const storageReference = 1;
  let demo;
  let loading = false;

  const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const label = item => t(`demo.${item.id}`, item.label);
  const format = (part, value) => value == null ? '—'
    : `${number.format(value)}${part === 'ram' || part === 'vram' ? '\u00a0GB' : ''}`;
  const normalized = value => value.normalize('NFKC').toLowerCase().trim();
  const wording = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100;
  const score = value => Number.isFinite(value) && value >= 0;
  const positive = value => score(value) && value > 0;
  const named = row => wording(row.name) && score(row.score);
  const labeled = row => wording(row.id) && wording(row.label);
  function rows(list, validate) {
    return Array.isArray(list) && list.length > 0 && list.length <= 64 && list.every(row => row && validate(row));
  }
  function usable(data) {
    return wording(data?.source) && typeof data.stale === 'boolean' && typeof data.syncedAt === 'string'
      && Number.isFinite(Date.parse(data.syncedAt))
      && rows(data.gpus, row => named(row) && score(row.vramGb)) && rows(data.cpus, named)
      && rows(data.targets, row => labeled(row) && [row.gpuScore, row.cpuScore, row.ramGb, row.vramGb].every(positive))
      && rows(data.storage, row => labeled(row) && score(row.score));
  }

  function options(select, items, placeholder) {
    const before = select.value;
    const next = items.map(([name, value]) => new Option(name, value));
    if (placeholder) next.unshift(new Option(placeholder, ''));
    select.replaceChildren(...next);
    select.value = items.some(([, value]) => value === before) ? before : next[0].value;
  }

  function showModelInfo(picker) {
    const name = picker.select.value;
    picker.info.dataset.state = name ? 'selected' : picker.count ? 'count' : 'empty';
    text(picker.info, name ? t('modelSelected', '已选：{name}', { name })
      : picker.count ? t('matches', '匹配型号：{count} 个', { count: number.format(picker.count) })
        : t('noModels', '没有匹配的示例型号。请更换关键词。'));
  }

  function filterModels(picker) {
    if (!demo) return;
    const terms = normalized(picker.input.value).split(/\s+/u);
    const matches = demo[`${picker.kind}s`].filter(({ name }) => terms.every(term => normalized(name).includes(term)));
    options(picker.select, matches.map(item => [item.name, item.name]), t('chooseModel', '选择完整型号'));
    picker.count = matches.length;
    picker.select.disabled = !picker.count;
    showModelInfo(picker);
  }

  function showVerdict(state, title, detail) {
    verdict.dataset.state = state;
    text(verdictTitle, title);
    text(verdictCopy, detail);
  }

  function compare() {
    if (!demo) return;
    const target = demo.targets.find(item => item.id === targetSelect.value);
    const gpu = demo.gpus.find(item => item.name === pickers[0].select.value);
    const cpu = demo.cpus.find(item => item.name === pickers[1].select.value);
    const storage = demo.storage.find(item => item.id === storageSelect.value);
    const ramValid = ram.value !== '' && ram.validity.valid;
    const ramInvalid = !ramValid && (ram.value !== '' || ram.validity.badInput);
    ram.setAttribute('aria-invalid', String(ramInvalid));
    ramError.hidden = !ramInvalid;
    for (const row of table.rows) {
      const current = row.dataset.targetId === target.id;
      row.toggleAttribute('data-current', current);
      if (current) row.cells[0].setAttribute('aria-current', 'true');
      else row.cells[0].removeAttribute('aria-current');
    }
    const checks = {
      gpu: [gpu?.score, target.gpuScore], cpu: [cpu?.score, target.cpuScore],
      ram: [ramValid ? ram.valueAsNumber : undefined, target.ramGb], vram: [gpu?.vramGb, target.vramGb],
      storage: [storage?.score, storageReference],
    };
    let below = 0;
    for (const row of partRows) {
      const part = row.dataset.hcPart;
      const [value, threshold] = checks[part];
      const state = value == null ? 'idle' : value >= threshold ? 'met' : 'below';
      if (state === 'below') below++;
      row.dataset.state = state;
      text(row.cells[1], format(part, value));
      text(row.cells[2], format(part, threshold));
      text(row.cells[3], state === 'idle' ? '—' : state === 'met' ? t('met', '达参考线') : t('below', '低于参考线'));
    }
    const detail = t('resultTier', '所选档位：{tier}', { tier: label(target) });
    if (!gpu || !cpu || !storage || !ramValid) {
      showVerdict('idle', t('resultWaiting', '请选择示例硬件'), detail);
    } else if (below) {
      showVerdict('below', t('resultBelow', '有 {count} 项低于示例参考线', { count: number.format(below) }), detail);
    } else {
      showVerdict('met', t('resultMet', '达到示例参考线'), detail);
    }
  }

  function render(data) {
    demo = data;
    options(targetSelect, data.targets.map(item => [label(item), item.id]));
    options(storageSelect, data.storage.map(item => [label(item), item.id]), t('chooseStorage', '选择储存选项'));
    for (const picker of pickers) filterModels(picker);
    for (const control of [targetSelect, storageSelect, ram, ...pickers.map(picker => picker.input)]) control.disabled = false;
    table.replaceChildren(...data.targets.map(item => {
      const row = document.createElement('tr');
      row.dataset.targetId = item.id;
      const title = document.createElement('th');
      title.scope = 'row';
      title.textContent = label(item);
      row.append(title);
      for (const [part, value] of Object.entries({ gpu: item.gpuScore, cpu: item.cpuScore, ram: item.ramGb, vram: item.vramGb })) {
        row.insertCell().textContent = format(part, value);
      }
      return row;
    }));
    compare();
  }

  async function loadDemo() {
    if (loading) return;
    loading = true;
    retry.setAttribute('aria-disabled', 'true');
    feed.dataset.state = 'loading';
    text(status, t('loading', '正在读取本地示例…'));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/api/hardware-check', {
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok || response.headers.get('X-GTAVI-Hardware-Data') !== 'synthetic') throw new Error('Non-demo response');
      const data = await response.json();
      if (!usable(data)) throw new Error('Invalid demo response');
      render(data);
      feed.dataset.state = 'ready';
      text(status, t('loaded', '已加载随应用提供的虚构数据。'));
    } catch {
      feed.dataset.state = 'error';
      text(status, demo ? t('retained', '重新读取失败。仍可使用已载入的示例。')
        : t('unavailable', '暂时无法读取本地示例。请重试。'));
      if (!demo) {
        showVerdict('error', t('resultUnavailable', '暂时无法对照'), t('resultUnavailableHint', '读取示例后即可对照。'));
        text(table.querySelector('td'), t('targetsUnavailable', '暂时无法读取示例档位。'));
      }
    } finally {
      clearTimeout(timeout);
      loading = false;
      retry.setAttribute('aria-disabled', 'false');
    }
  }

  for (const picker of pickers) {
    picker.input.addEventListener('input', () => { filterModels(picker); compare(); });
    picker.input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing || picker.select.disabled) return;
      event.preventDefault();
      picker.select.focus();
    });
    picker.select.addEventListener('change', () => { showModelInfo(picker); compare(); });
  }
  targetSelect.addEventListener('change', compare);
  ram.addEventListener('input', compare);
  storageSelect.addEventListener('change', compare);
  retry.addEventListener('click', loadDemo);
  void loadDemo();
})();
