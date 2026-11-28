(() => {
  'use strict';

  // Keep the browser's existing scrollers. OverlayScrollbars supplies only the
  // touch-grabbable handles; desktop (and forced colors) use native scrollbars.
  const touch = window.matchMedia('(any-pointer: coarse)');
  const contrast = window.matchMedia('(forced-colors: active)');
  const regions = [
    '[data-scrollbars]', '.qq-popover', '.menu-panel', '.menu-body', '.site-account-menu',
    '.site-language-options', '.traffic-panel', '.music-panel', '.music-list',
    '.danmaku-history-list', '.danmaku-options', '.danmaku-moderation', '.danmaku-mentions-list',
    '.danmaku-translate-menu', '.feedback-site-notice-inner p', '.feedback-notice-title',
    '.feedback-notice-body', '.port-score-dialog-body', '.obs-body', '.obs-import-dialog',
    '.admin-nav', '.account-table-wrap', '.account-dialog', '.nav-drawer', '.harness-console .sidebar',
  ].join(',');
  // Update the bootstrap with theme changes; late-loaded styles use the same release fingerprint.
  const assetVersion = document.currentScript?.src ? new URL(document.currentScript.src).search : '';
  // Scope CSS revisions to the theme so independently cached vendor assets stay reusable.
  const themeVersion = `${assetVersion}${assetVersion ? '&' : '?'}theme=3`;
  const vendor = '/assets/vendor/overlayscrollbars-2.17.0.min';
  const enabled = () => touch.matches && !contrast.matches;
  let boot;
  let stop;

  function load(node, url, attr, parent, prepend = false) {
    return new Promise((resolve, reject) => {
      node.addEventListener('load', resolve, { once: true });
      node.addEventListener('error', reject, { once: true });
      node[attr] = url;
      if (prepend) parent.prepend(node);
      else parent.append(node);
    });
  }

  function prepare() {
    if (boot) return boot;
    const base = document.createElement('link');
    base.rel = 'stylesheet';
    const theme = document.createElement('link');
    theme.rel = 'stylesheet';
    const script = document.createElement('script');
    boot = Promise.all([
      load(base, `${vendor}.css${assetVersion}`, 'href', document.head, true),
      load(theme, `/assets/site-scrollbars.css${themeVersion}`, 'href', document.head),
      load(script, `${vendor}.js${assetVersion}`, 'src', document.head),
    ]).then(() => window.OverlayScrollbarsGlobal?.OverlayScrollbars).catch(() => {
      for (const node of [base, theme, script]) node.remove();
      boot = undefined;
    });
    return boot;
  }

  function mount(OverlayScrollbars) {
    const instances = new Map();
    const watched = new Set();
    const pending = new Set();
    let frame = 0;
    const root = document.body;
    const scrollable = v => v === 'auto' || v === 'scroll' || v === 'overlay';
    const overflow = v => scrollable(v) ? 'scroll' : v === 'visible' ? 'visible' : 'hidden';

    function attach(target) {
      if (!target.isConnected) return;
      const doc = target === root;
      const existing = instances.get(target);
      if (existing) {
        // A playlist/option renderer can replace its children while the scroll
        // host stays mounted. Keep the original pointer-controlled bars alive.
        for (const bar of existing.bars) if (bar.parentElement !== target) target.append(bar);
        return;
      }
      const { overflowX, overflowY } = getComputedStyle(target);
      if (!doc && (!target.clientWidth || !target.clientHeight || !(
        (scrollable(overflowX) && target.scrollWidth > target.clientWidth + 1) ||
        (scrollable(overflowY) && target.scrollHeight > target.clientHeight + 1)
      ))) return;
      const instance = OverlayScrollbars({
        target,
        elements: { viewport: target }, // Do not create a new scrolling viewport.
        scrollbars: { slot: target },
        cancel: { body: false, nativeScrollbarsOverlaid: false },
      }, {
        overflow: doc ? { x: 'scroll', y: 'scroll' } : { x: overflow(overflowX), y: overflow(overflowY) },
        scrollbars: { theme: 'os-theme-port-tracker', autoHide: 'never', dragScroll: true },
      });
      if (!OverlayScrollbars.valid(instance)) return;
      const { scrollbarHorizontal, scrollbarVertical } = instance.elements();
      const bars = [scrollbarHorizontal.scrollbar, scrollbarVertical.scrollbar];
      for (const bar of bars) {
        bar.setAttribute('aria-hidden', 'true');
        bar.setAttribute('data-lenis-prevent', '');
        if (doc) bar.classList.add('site-scrollbar-document');
      }
      instances.set(target, { instance, bars });
    }

    function queue(target) {
      pending.add(target);
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        for (const node of pending) attach(node);
        pending.clear();
      });
    }
    const sizes = new ResizeObserver(entries => {
      for (const { target } of entries) if (!instances.has(target)) queue(target);
    });
    function watch(target) {
      if (watched.has(target)) return;
      watched.add(target);
      sizes.observe(target);
      queue(target);
    }
    function discover(node) {
      if (node.nodeType !== 1 || node.closest('.os-scrollbar')) return;
      if (node.matches(regions)) watch(node);
      for (const target of node.querySelectorAll(regions)) watch(target);
    }
    function forgetRemoved() {
      for (const target of watched) {
        if (target.isConnected) continue;
        sizes.unobserve(target);
        watched.delete(target);
        pending.delete(target);
        instances.get(target)?.instance.destroy();
        instances.delete(target);
      }
    }
    const changes = new MutationObserver(records => {
      let removed = false;
      for (const record of records) {
        const host = record.target.closest(regions);
        if (watched.has(host)) queue(host);
        for (const child of record.addedNodes) discover(child);
        for (const child of record.removedNodes) if (child.nodeType === 1 && !child.isConnected) removed = true;
      }
      if (removed) forgetRemoved();
    });

    // Start from the actual scrolling element and watch only authored scroll regions.
    attach(root);
    discover(root);
    changes.observe(root, { childList: true, subtree: true });
    return () => {
      changes.disconnect();
      sizes.disconnect();
      if (frame) cancelAnimationFrame(frame);
      for (const { instance } of instances.values()) instance.destroy();
    };
  }

  async function sync() {
    if (!enabled()) {
      stop?.();
      stop = undefined;
      return;
    }
    if (stop || !window.ResizeObserver || !window.MutationObserver) return;
    const OverlayScrollbars = await prepare();
    if (!enabled() || stop || !OverlayScrollbars?.env().scrollbarsHiding) return;
    stop = mount(OverlayScrollbars);
  }

  for (const query of [touch, contrast]) query.addEventListener('change', sync);
  sync();
})();
