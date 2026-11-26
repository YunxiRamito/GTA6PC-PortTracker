(() => {
  'use strict';

  const languages = Object.freeze({ 'zh-CN': '简体中文', en: 'English', ja: '日本語' });
  const defaultLocale = 'zh-CN';
  const storageKey = 'port-tracker:locale';
  const publicPath = /^(?:\/|\/index\.html|\/(?:about|thanks|feedback)(?:\/|\.html)?|\/rss\.xml|\/api\/(?:content|dashboard|sponsors))$/;
  const page = new URL(window.location.href);
  const requested = page.searchParams.get('lang');
  let saved;
  try { saved = window.localStorage.getItem(storageKey); } catch { /* Storage is optional. */ }
  const preferred = requested === null ? saved : requested;
  const locale = Object.hasOwn(languages, preferred) ? preferred : defaultLocale;
  if (requested !== null && Object.hasOwn(languages, requested)) {
    try { window.localStorage.setItem(storageKey, locale); } catch { /* The URL still carries the choice. */ }
  } else if (requested === null && locale !== defaultLocale) {
    page.searchParams.set('lang', locale);
    try { window.history.replaceState(window.history.state, '', page.href); } catch { /* Keep the original URL. */ }
  }
  document.documentElement.lang = locale;

  const words = Object.create(null);
  function register(messages) { Object.assign(words, messages); }
  function t(key, fallback = '', values) {
    const index = locale === 'en' ? 0 : locale === 'ja' ? 1 : -1;
    const message = (index >= 0 && words[key]?.[index]) || fallback;
    return values ? message.replace(/\{([\w]+)\}/g, (part, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : part) : message;
  }

  function url(value) {
    if (typeof value !== 'string' || !value || value.trimStart().startsWith('#')) return value;
    let address;
    try { address = new URL(value, page); } catch { return value; }
    if (address.origin !== page.origin || address.username || address.password || !publicPath.test(address.pathname) ||
        address.searchParams.has('lang') || locale === defaultLocale) return value;
    address.searchParams.set('lang', locale);
    return address.pathname + address.search + address.hash;
  }

  function apply(root = document) {
    if (locale !== defaultLocale) {
      for (const node of root.querySelectorAll('[data-i18n]')) {
        node.textContent = t(node.dataset.i18n, node.textContent);
      }
      for (const node of root.querySelectorAll('[data-i18n-own]')) {
        const text = Array.from(node.childNodes).find(child => child.nodeType === 3 && child.data.trim());
        if (text) {
          const translated = t(node.dataset.i18nOwn);
          if (translated) text.data = text.data.replace(/\S(?:[\s\S]*\S)?/, () => translated);
        }
      }
      for (const attr of ['aria-label', 'title', 'alt', 'placeholder', 'content']) {
        for (const node of root.querySelectorAll(`[data-i18n-${attr}]`)) {
          node.setAttribute(attr, t(node.getAttribute(`data-i18n-${attr}`), node.getAttribute(attr) ?? ''));
        }
      }
    }
    for (const link of root.querySelectorAll('a[href], link[type="application/rss+xml"][href]')) {
      const before = link.getAttribute('href');
      const next = url(before);
      if (next !== before) link.setAttribute('href', next);
    }
  }

  window.SiteI18n = Object.freeze({ locale, register, t, url, withLocale: url, apply });
  register({ 'language.control': ['Site language', 'サイトの表示言語'] });

  const actions = document.querySelector('.site-topbar .nav-actions');
  if (!actions) return;
  const picker = document.createElement('div');
  picker.className = 'site-language';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'nav-action site-language-toggle';
  const label = t('language.control', '网站语言');
  button.setAttribute('aria-label', label);
  button.title = label;
  button.setAttribute('aria-controls', 'siteLanguageOptions');
  button.setAttribute('aria-expanded', 'false');
  const ns = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(ns, 'svg');
  icon.setAttribute('class', 'ui-icon');
  icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '/assets/ui/fluent.svg#translate');
  icon.append(use);
  button.append(icon);

  const options = document.createElement('nav');
  options.id = 'siteLanguageOptions';
  options.className = 'site-language-options';
  options.setAttribute('aria-label', label);
  options.inert = true;
  for (const [code, name] of Object.entries(languages)) {
    const link = document.createElement('a');
    // Read the live URL; a chapter link may have changed the hash since page load.
    const selectionUrl = () => {
      const current = new URL(window.location.href);
      current.searchParams.set('lang', code);
      return current.pathname + current.search + current.hash;
    };
    link.href = selectionUrl();
    link.lang = link.hreflang = code;
    link.textContent = name;
    if (code === locale) link.setAttribute('aria-current', 'true');
    for (const event of ['focus', 'pointerdown', 'click']) link.addEventListener(event, () => { link.href = selectionUrl(); });
    options.append(link);
  }
  picker.append(button, options);
  actions.insertBefore(picker, actions.querySelector('#menuToggle'));

  function setOpen(open) {
    picker.classList.toggle('is-open', open);
    button.setAttribute('aria-expanded', String(open));
    options.inert = !open;
  }
  button.addEventListener('click', () => setOpen(!picker.classList.contains('is-open')));
  picker.addEventListener('focusout', event => { if (!picker.contains(event.relatedTarget)) setOpen(false); });
  document.addEventListener('pointerdown', event => { if (!picker.contains(event.target)) setOpen(false); });
  picker.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !picker.classList.contains('is-open')) return;
    event.preventDefault();
    setOpen(false);
    button.focus();
  });
})();
