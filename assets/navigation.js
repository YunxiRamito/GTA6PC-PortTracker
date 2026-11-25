(() => {
  'use strict';

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
    link.className = 'site-github-link';
    link.href = GITHUB_REPOSITORY_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', 'GitHub 仓库（在新标签页打开）');

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.classList.add('ui-icon');
    icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    const adminTopbar = topbar.dataset.siteTopbar === 'login' || topbar.dataset.siteTopbar === 'console';
    use.setAttribute('href', adminTopbar ? '/assets/ui/fluent.svg#document' : '/assets/ui/octicons.svg#repo-16');
    icon.append(use);

    const label = document.createElement('span');
    label.textContent = 'GitHub 仓库';
    link.append(icon, label);
    cluster.append(link);
  }

  const publicOrigin = readOrigin(document.querySelector('meta[name="port-tracker-public-origin"]')?.content);
  mountRepositoryLink();

  if (publicOrigin) {
    for (const link of document.querySelectorAll('[data-site-topbar] [data-site-path], #siteMenu [data-site-path]')) {
      link.href = new URL(link.dataset.sitePath, publicOrigin).href;
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
