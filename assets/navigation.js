(() => {
  'use strict';

  const t = (key, fallback) => window.SiteI18n?.t(key, fallback) ?? fallback;

  const root = document.documentElement;
  const topbar = document.querySelector('[data-site-topbar]');
  const nav = topbar?.querySelector('.site-nav');
  const isHome = topbar?.classList.contains('site-topbar-home');
  const menu = document.getElementById('siteMenu');
  const trigger = document.getElementById('menuToggle');
  const closeButton = document.getElementById('menuClose');
  const panel = menu?.querySelector('.menu-panel');
  const backdrop = menu?.querySelector('.menu-backdrop-brand');
  const menuLinks = [...(menu?.querySelectorAll('.menu-chapters a') || [])];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const qq = document.getElementById('qqMenu');
  let nextSection = null;
  let closeTimer;
  let closing = false;
  let backdropPress = false;

  const GITHUB_REPOSITORY_URL = 'https://github.com/YunxiRamito/GTA6PC-PortTracker';
  // Primer Octicons mark-github-16, e6626e159c4ba786d512e252182b62617014c752 (MIT; see assets/ui/Octicons-LICENSE.txt).
  const GITHUB_MARK_PATH = 'M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656';
  const loopback = /^(?:localhost|127\.0\.0\.1|\[::1\])$/;

  function readOrigin(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const url = new URL(value);
      const localHttp = url.protocol === 'http:' && loopback.test(location.hostname) && loopback.test(url.hostname);
      return url.origin === value && (url.protocol === 'https:' || localHttp) ? url.origin : null;
    } catch {
      return null;
    }
  }

  function mountRepositoryLink() {
    if (!nav) return;
    const brand = nav.querySelector(':scope > .site-brand');
    if (!brand || nav.querySelector(':scope > .site-brand-cluster')) return;

    const cluster = document.createElement('div');
    cluster.className = 'site-brand-cluster';
    brand.before(cluster);
    cluster.append(brand);

    const link = document.createElement('a');
    link.className = 'nav-action site-github-link';
    link.href = GITHUB_REPOSITORY_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = t('widgets.nav.repository', 'GitHub 仓库');
    link.setAttribute('aria-label', t('widgets.nav.repositoryLabel', 'GitHub 仓库（在新标签页打开）'));

    // The admin and account hosts do not serve the public Octicons sprite.
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.classList.add('ui-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('viewBox', '0 0 16 16');
    const path = document.createElementNS(icon.namespaceURI, 'path');
    path.setAttribute('d', GITHUB_MARK_PATH);
    icon.append(path);
    link.append(icon);
    cluster.append(link);
  }

  function mountBackToTop() {
    // The old public mastheads use these two modes; leave console and login alone.
    if (!['inline', 'overlay'].includes(topbar?.dataset.siteTopbar) || document.getElementById('siteBackToTop')) return;

    const button = document.createElement('button');
    const key = 'pages.home.backToTop';
    const label = t(key, '返回顶部');
    button.type = 'button';
    button.id = 'siteBackToTop';
    button.className = 'site-back-to-top';
    button.setAttribute('aria-label', label);
    button.setAttribute('data-i18n-aria-label', key);
    button.setAttribute('data-i18n-title', key);
    button.title = label;
    button.setAttribute('inert', '');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.classList.add('ui-icon');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.setAttribute('focusable', 'false');
    const use = document.createElementNS(arrow.namespaceURI, 'use');
    use.setAttribute('href', '/assets/ui/fluent.svg#arrow-down');
    arrow.append(use);
    button.append(arrow);

    // The homepage has a focusable top anchor; the older public subpages have a focusable main.
    const pageStart = () => document.getElementById('top') ?? document.querySelector('body > main');
    const moveFocus = target => target?.focus({ preventScroll: true });
    function syncVisibility() {
      const hide = !(window.scrollY >= window.innerHeight);
      if (button.hasAttribute('inert') === hide) return;
      if (hide && document.activeElement === button) moveFocus(nav?.querySelector('.site-brand') ?? pageStart());
      button.toggleAttribute('inert', hide);
    }

    button.addEventListener('click', () => {
      if (button.hasAttribute('inert')) return;
      moveFocus(pageStart());
      const motion = window.PortMotion;
      const suspendLenis = root.classList.contains('lenis') && typeof motion?.pause === 'function' && typeof motion.resume === 'function';
      // Stop Lenis's pending wheel animation, then let it resync to the real window position.
      if (suspendLenis) motion.pause();
      try { window.scrollTo({ top: 0, behavior: reduced.matches || suspendLenis ? 'instant' : 'smooth' }); }
      finally { if (suspendLenis) motion.resume(); }
    });

    document.body.append(button);
    window.addEventListener('scroll', syncVisibility, { passive: true });
    window.addEventListener('resize', syncVisibility, { passive: true });
    window.addEventListener('pageshow', syncVisibility);
    syncVisibility();
  }

  const publicOrigin = readOrigin(document.querySelector('meta[name="port-tracker-public-origin"]')?.content);
  mountRepositoryLink();
  mountBackToTop();

  if (publicOrigin) {
    for (const link of document.querySelectorAll('[data-site-topbar] [data-site-path], #siteMenu [data-site-path]')) {
      const destination = new URL(link.dataset.sitePath, publicOrigin).href;
      link.href = window.SiteI18n?.url(destination) ?? destination;
    }
  }

  if (topbar && nav) {
    const syncHeight = () => root.style.setProperty('--site-topbar-height', topbar.offsetHeight + 'px');
    new ResizeObserver(syncHeight).observe(topbar);
    syncHeight();
    const syncNavBackdrop = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
    window.addEventListener('scroll', syncNavBackdrop, { passive: true });
    window.addEventListener('pageshow', syncNavBackdrop);
    syncNavBackdrop();
  }

  function highlightChapter() {
    const boundary = (trigger?.getBoundingClientRect().bottom || 40) + 55;
    let current;
    for (const link of menuLinks) {
      const section = document.getElementById(link.hash.slice(1));
      if (section && section.getBoundingClientRect().top <= boundary) current = link;
    }
    for (const link of menuLinks) {
      if (link === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }

  function navigate(target) {
    const hash = '#' + target.id;
    if (window.location.hash !== hash) history.pushState(null, '', hash);
    target.focus({ preventScroll: true });
    if (window.PortMotion) window.PortMotion.scrollTo(target);
    else target.scrollIntoView({ block: 'start' });
  }

  function finishClose() {
    if (!menu.open || !closing) return;
    clearTimeout(closeTimer);
    menu.close();
  }

  function closeMenu(destination = null) {
    if (!menu.open) return;
    if (destination) nextSection = destination;
    if (closing) return;
    closing = true;
    menu.classList.remove('is-open');
    menu.classList.add('is-closing');
    if (reduced.matches) finishClose();
    else closeTimer = setTimeout(finishClose, 510);
  }

  if (menu?.showModal && trigger && closeButton && panel) {
    topbar?.setAttribute('data-menu-ready', '');
    reduced.addEventListener('change', () => { if (reduced.matches) finishClose(); });
    trigger.addEventListener('click', () => {
      if (menu.open || closing) return;
      highlightChapter();
      if (qq?.open) qq.open = false;
      menu.showModal();
      root.classList.add('menu-open');
      trigger.setAttribute('aria-expanded', 'true');
      window.PortMotion?.pause();
      panel.scrollTop = 0;
      closeButton.focus({ preventScroll: true });
      // Commit the off-screen drawer before asking CSS to transition it into view.
      void panel.offsetWidth;
      menu.classList.add('is-open');
    });
    menu.addEventListener('close', () => {
      clearTimeout(closeTimer);
      root.classList.remove('menu-open');
      menu.classList.remove('is-open', 'is-closing');
      trigger.setAttribute('aria-expanded', 'false');
      backdropPress = false;
      closing = false;
      window.PortMotion?.resume();
      const destination = nextSection;
      nextSection = null;
      if (destination) navigate(destination);
      else trigger.focus({ preventScroll: true });
    });
    panel.addEventListener('transitionend', event => {
      if (event.target === panel && event.propertyName === 'transform') finishClose();
    });
    closeButton.addEventListener('click', () => closeMenu());
    menu.addEventListener('cancel', event => {
      event.preventDefault();
      closeMenu();
    });
    menu.addEventListener('pointerdown', event => {
      backdropPress = event.button === 0 && Boolean(backdrop?.contains(event.target));
    });
    menu.addEventListener('pointercancel', () => { backdropPress = false; });
    menu.addEventListener('click', event => {
      if (backdropPress && backdrop?.contains(event.target)) closeMenu();
      backdropPress = false;
    });
  }

  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest?.('a[href^="#"]');
    if (!anchor || anchor.hash.length < 2 || (!isHome && !topbar?.contains(anchor))) return;
    const section = document.getElementById(anchor.hash.slice(1));
    if (!section) return;
    event.preventDefault();
    if (menu?.open && menu.contains(anchor)) closeMenu(section);
    else navigate(section);
  });

  if (qq) {
    document.addEventListener('pointerdown', event => {
      if (qq.open && !qq.contains(event.target)) qq.open = false;
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !qq.open || menu?.open) return;
      const focusInside = qq.contains(document.activeElement);
      qq.open = false;
      if (focusInside) qq.querySelector('summary').focus({ preventScroll: true });
    });
    qq.addEventListener('focusout', event => {
      if (event.relatedTarget && !qq.contains(event.relatedTarget)) qq.open = false;
    });
  }
})();
