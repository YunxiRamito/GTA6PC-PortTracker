(() => {
  'use strict';

  const history = document.querySelector('#danmakuHistory');
  const list = document.querySelector('#danmakuHistoryList');
  if (!history || !list) return;

  const i18n = window.SiteI18n;
  const locale = i18n?.locale ?? 'zh-CN';
  const target = locale === 'zh-CN' ? 'zh' : locale;
  const sources = ['zh', 'zh-Hant', 'en', 'ja'].filter(language => language !== target);
  const copy = {
    toggle: ['自动翻译', 'Auto-translate', '自動翻訳'],
    idle: ['按当前页面语言翻译。首次开启时，浏览器可能下载语言包。', 'Translates into the site language. Your browser may download language packs on first use.', 'サイトの表示言語に翻訳します。初回は言語パックがダウンロードされることがあります。'],
    unavailable: ['需要支持设备端翻译的桌面浏览器和安全连接。', 'Requires a secure connection and a desktop browser with on-device translation.', '端末内翻訳に対応したデスクトップブラウザーと安全な接続が必要です。'],
    checking: ['正在检查可用语言包…', 'Checking available language packs…', '利用できる言語パックを確認中…'],
    noModels: ['设备暂不支持翻译为当前页面语言。', 'On-device translation into this language is unavailable.', 'この端末では、現在の表示言語への翻訳を利用できません。'],
    loading: ['正在准备设备端翻译…', 'Preparing on-device translation…', '端末内翻訳を準備中…'],
    enabled: ['已开启设备端翻译。', 'On-device translation is on.', '端末内翻訳が有効です。'],
    failed: ['翻译暂不可用。可以再次尝试。', 'Translation is unavailable. You can try again.', '翻訳を利用できません。もう一度お試しください。'],
    label: ['自动译文', 'Machine translation', '自動翻訳'],
  };
  const text = key => copy[key][locale === 'en' ? 1 : locale === 'ja' ? 2 : 0];
  const detectorAPI = window.LanguageDetector;
  const translatorAPI = window.Translator;
  const supported = window.isSecureContext && typeof detectorAPI?.create === 'function' &&
    typeof translatorAPI?.create === 'function';

  const controls = document.createElement('div');
  controls.className = 'danmaku-translate-control';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = text('toggle');
  toggle.setAttribute('aria-pressed', 'false');
  toggle.setAttribute('aria-describedby', 'danmakuTranslateStatus');
  toggle.disabled = true;
  const status = document.createElement('p');
  status.id = 'danmakuTranslateStatus';
  status.setAttribute('role', 'status');
  status.textContent = text(supported ? 'checking' : 'unavailable');
  controls.append(toggle, status);
  list.before(controls);
  if (!supported) return;

  const cache = new Map();
  let session = null;
  let availableSources = sources;

  function setStatus(key) { status.textContent = text(key); }

  async function availability(api, options) {
    try { return await api.availability?.(options); }
    catch { return undefined; }
  }

  async function checkModels() {
    const [detector, ...pairs] = await Promise.all([
      availability(detectorAPI),
      ...sources.map(sourceLanguage => availability(translatorAPI, { sourceLanguage, targetLanguage: target })),
    ]);
    availableSources = sources.filter((_, index) => pairs[index] !== 'unavailable');
    if (detector === 'unavailable' || !availableSources.length) {
      setStatus('noModels');
      return;
    }
    toggle.disabled = false;
    setStatus('idle');
  }

  function stop(key) {
    session?.controller.abort();
    session = null;
    history.classList.remove('has-auto-translation');
    toggle.setAttribute('aria-pressed', 'false');
    setStatus(key);
  }

  async function start() {
    const controller = new AbortController();
    const { signal } = controller;
    const current = { controller, handled: new WeakSet(), detector: null, translators: new Map(), processing: false };
    session = current;
    toggle.setAttribute('aria-pressed', 'true');
    setStatus('loading');
    try {
      // Initiate model creation in the click, while the browser grants user activation.
      const createModel = async (api, options) => api.create({ ...options, signal });
      const models = await Promise.allSettled([
        createModel(detectorAPI),
        ...availableSources.map(sourceLanguage => createModel(translatorAPI, { sourceLanguage, targetLanguage: target })),
      ]);
      if (signal.aborted) return;
      if (models[0].status === 'fulfilled') current.detector = models[0].value;
      for (const [index, source] of availableSources.entries()) {
        const result = models[index + 1];
        if (result.status === 'fulfilled') current.translators.set(source, result.value);
      }
      if (!current.detector || !current.translators.size) return stop('failed');
      history.classList.add('has-auto-translation');
      setStatus('enabled');
      void translateRows();
    } catch {
      if (!signal.aborted) stop('failed');
    }
  }

  function sourceLanguage(value) {
    const code = value?.toLowerCase() ?? '';
    if (/^zh-(?:hant|tw|hk|mo)(?:-|$)/.test(code)) return 'zh-Hant';
    return code.split('-')[0];
  }

  async function translate(original, current, signal) {
    const [result] = await current.detector.detect(original, { signal });
    const source = sourceLanguage(result?.detectedLanguage);
    const translator = result?.confidence >= .55 ? current.translators.get(source) : null;
    if (!translator || signal.aborted) return '';
    const translated = (await translator.translate(original, { signal })).trim();
    return translated && translated !== original ? translated.slice(0, 360) : '';
  }

  function appendTranslation(node, translated) {
    const paragraph = document.createElement('p');
    paragraph.className = 'danmaku-machine-translation';
    const label = document.createElement('span');
    label.textContent = text('label');
    const words = document.createElement('span');
    words.lang = locale;
    words.textContent = translated;
    paragraph.append(label, words);
    node.after(paragraph);
  }

  function nextOriginal(current) {
    if (!current?.detector || !current.translators.size || history.dataset.open !== 'true') return;
    return [...list.querySelectorAll('.danmaku-history-item:not([data-moderation]) .danmaku-history-text')]
      .find(node => !current.handled.has(node) && !node.nextElementSibling?.classList.contains('danmaku-machine-translation'));
  }

  async function translateRows() {
    const current = session;
    if (!current || current.processing) return;
    current.processing = true;
    const { signal } = current.controller;
    try {
      for (let node; !signal.aborted && (node = nextOriginal(current));) {
        current.handled.add(node);
        const original = node.textContent.trim();
        if (!original || !/\p{L}/u.test(original)) continue;
        try {
          if (!cache.has(original)) {
            const translated = await translate(original, current, signal);
            if (signal.aborted) continue;
            if (cache.size >= 180) cache.delete(cache.keys().next().value);
            cache.set(original, translated);
          }
          const translated = cache.get(original);
          if (translated && list.contains(node)) appendTranslation(node, translated);
        } catch { /* An individual message remains readable in the original language. */ }
      }
    } finally {
      current.processing = false;
    }
  }

  toggle.addEventListener('click', () => {
    if (session) stop('idle');
    else void start();
  });
  const hearHistory = new MutationObserver(() => void translateRows());
  hearHistory.observe(list, { childList: true });
  hearHistory.observe(history, { attributes: true, attributeFilter: ['data-open'] });
  void checkModels();
})();
