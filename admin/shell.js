// 后台外壳：主导航、手机抽屉、hash 路由和未保存修改确认。路由表与权限规则见 router.js。
(() => {
  'use strict';

  const Router = window.AdminRouter;
  const byId = id => document.getElementById(id);
  const page = document.body.dataset.adminPage || 'console';
  const compact = window.matchMedia('(max-width: 52rem)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const modules = new Map();
  const entered = new Set();
  let caps = null;
  let current = null;
  let skipGuardFor = '';
  let leaveConfirmed = false;

  function moduleDirty(name, area) {
    const label = modules.get(name)?.dirty?.(area);
    return typeof label === 'string' ? label : '';
  }

  function anyDirty() {
    for (const name of modules.keys()) {
      const label = moduleDirty(name);
      if (label) return label;
    }
    return '';
  }

  function say(message) {
    const status = byId('shell-status');
    if (!status) return;
    status.textContent = '';
    if (message) requestAnimationFrame(() => { status.textContent = message; });
  }

  function confirmSwitch(from, to) {
    if (!from || from.area === to.area) return true;
    const label = moduleDirty(from.module, from.area);
    if (!label) return true;
    return window.confirm(`${label}有未保存的修改。草稿仍留在本页，但刷新或关闭页面会丢失。仍要切换吗？`);
  }

  // 离开本页（退出登录、打开独立页）前确认全部模块；确认后其他 beforeunload 提示不再重复出现。
  function confirmLeave(action = '离开本页') {
    const label = anyDirty();
    if (label && !window.confirm(`${label}有未保存的修改，${action}会丢弃这些修改。仍要继续吗？`)) return false;
    leaveConfirmed = true;
    return true;
  }

  function setText(selector, scope, value) {
    const node = scope.querySelector(selector);
    if (node && typeof value === 'string' && node.textContent !== value) node.textContent = value;
  }

  function animateIn(node) {
    if (reducedMotion.matches) return;
    node.classList.remove('is-entering');
    void node.offsetWidth;
    node.classList.add('is-entering');
  }

  function routeTitle(route) {
    if (caps?.forced && route.path === '/account/password') return '设置新密码';
    return route.title || route.label;
  }

  function setNavGroup(toggle, expanded) {
    const panel = byId(toggle.getAttribute('aria-controls'));
    if (!expanded && panel.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    toggle.setAttribute('aria-expanded', String(expanded));
    panel.inert = !expanded;
  }

  function paintNav() {
    for (const link of document.querySelectorAll('#admin-nav a[data-path]')) {
      const item = { external: link.dataset.external === 'true', page: link.dataset.page, match: link.dataset.match.split(' ') };
      if (Router.isCurrent(item, current?.path, page)) {
        link.setAttribute('aria-current', 'page');
        setNavGroup(link.closest('.nav-group').querySelector('.nav-group-toggle'), true);
      } else link.removeAttribute('aria-current');
    }
  }

  function apply(route, { initial = false, focus = true } = {}) {
    const previous = current;
    const viewChanged = previous?.view !== route.view;
    const sameRecords = !viewChanged && previous?.module === 'danmaku' && route.module === 'danmaku'
      && previous.records && route.records;
    current = route;
    for (const view of document.querySelectorAll('[data-shell-view]')) view.hidden = view.id !== route.view;
    const view = byId(route.view);
    const heading = view?.querySelector('.page-heading');
    if (heading) {
      setText('[data-shell-eyebrow]', heading, route.eyebrow);
      setText('[data-shell-title]', heading, routeTitle(route));
      if (route.intro) setText('[data-shell-intro]', heading, route.intro);
    }
    document.title = `${routeTitle(route)} · 控制台 · LOCAL CONSOLE`;
    paintNav();
    if (view && !sameRecords && (viewChanged || route.part !== previous?.part)) animateIn(view);
    const hooks = modules.get(route.module);
    if (hooks) {
      hooks.enter?.(route, { initial: !entered.has(route.module), previous });
      entered.add(route.module);
    }
    if (!initial && focus && !sameRecords) {
      window.scrollTo({ top: 0, behavior: 'auto' });
      const target = hooks?.focusTarget?.(route) || view?.querySelector('[data-shell-title]');
      target?.focus({ preventScroll: true });
    }
  }

  function revert() {
    if (current) history.replaceState(history.state, '', `#${current.path}`);
  }

  function handleHash() {
    if (!caps) return;
    const parsed = Router.parseHash(window.location.hash);
    if (parsed === null) return;
    const result = Router.resolve(window.location.hash, caps);
    if (!result) return;
    const { route } = result;
    if (result.denied) say('当前账号不能打开这个页面，已转到可用页面。');
    if (current && route.path === current.path) {
      if (result.redirect) revert();
      paintNav();
      return;
    }
    const confirmed = skipGuardFor === route.path;
    skipGuardFor = '';
    if (!confirmed && !confirmSwitch(current, route)) { revert(); return; }
    const reason = modules.get(route.module)?.canEnter?.(route, current);
    if (typeof reason === 'string' && reason) { say(reason); revert(); return; }
    if (result.redirect) history.replaceState(history.state, '', `#${route.path}`);
    apply(route);
  }

  function navigate(path, { replace = false } = {}) {
    const route = Router.routeFor(path);
    if (!route || !caps || !Router.allowed(route, caps)) return false;
    if (page !== 'console' || route.href) {
      if (!confirmLeave('打开新页面')) return false;
      window.location.assign(Router.hrefFor(route, page));
      return true;
    }
    if (current?.path === path) {
      paintNav();
      return true;
    }
    if (!confirmSwitch(current, route)) return false;
    skipGuardFor = path;
    if (replace) {
      history.replaceState(history.state, '', `#${path}`);
      handleHash();
    } else window.location.hash = path;
    return true;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `/assets/ui/fluent.svg#${name}`);
    svg.append(use);
    return svg;
  }

  function buildNavItem(item) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = item.href;
    link.dataset.path = item.path;
    link.dataset.page = item.page;
    link.dataset.external = String(item.external);
    link.dataset.match = item.match.join(' ');
    if (item.number) {
      const number = document.createElement('span');
      number.className = 'nav-number';
      number.setAttribute('aria-hidden', 'true');
      number.textContent = item.number;
      link.append(number);
    }
    const label = document.createElement('span');
    label.className = 'nav-label';
    label.textContent = item.label;
    link.append(label);
    if (item.external) link.append(icon('arrow-up-right'));
    li.append(link);
    return li;
  }

  function buildNavItems(group) {
    const content = document.createElement('div');
    content.className = 'nav-group-items';
    const lists = new Map();
    for (const item of group.items) {
      const subgroup = item.subgroup;
      const subgroupId = subgroup?.id && subgroup.label ? subgroup.id : null;
      let list = lists.get(subgroupId);
      if (!list) {
        list = document.createElement('ul');
        list.setAttribute('role', 'list');
        lists.set(subgroupId, list);
        if (subgroupId === null) content.append(list);
        else {
          const section = document.createElement('div');
          section.className = 'nav-subgroup';
          const heading = document.createElement('h3');
          heading.className = 'nav-subgroup-title';
          heading.id = `nav-subgroup-${group.id}-${subgroupId}`;
          heading.textContent = subgroup.label;
          list.setAttribute('aria-labelledby', heading.id);
          section.append(heading, list);
          content.append(section);
        }
      }
      list.append(buildNavItem(item));
    }
    return content;
  }

  function buildNav() {
    const nav = byId('admin-nav');
    if (!nav) return;
    const groups = Router.navTree(caps, page).map(group => {
      const section = document.createElement('section');
      section.className = 'nav-group';
      const title = document.createElement('h2');
      title.className = 'nav-group-title';
      title.id = `nav-group-${group.id}`;
      section.setAttribute('aria-labelledby', title.id);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'nav-group-toggle';
      toggle.textContent = group.label;
      toggle.append(icon('chevron-down'));
      const panel = document.createElement('div');
      panel.className = 'nav-group-panel';
      panel.id = `nav-panel-${group.id}`;
      toggle.setAttribute('aria-controls', panel.id);
      toggle.setAttribute('aria-expanded', 'true');
      toggle.addEventListener('click', () => setNavGroup(toggle, panel.inert));
      title.append(toggle);
      panel.append(buildNavItems(group));
      section.append(title, panel);
      return section;
    });
    nav.replaceChildren(...groups);
    paintNav();
  }

  function setDrawer(open, { restoreFocus = false } = {}) {
    const sidebar = byId('admin-sidebar');
    const toggle = byId('nav-toggle');
    const drawer = byId('nav-drawer');
    if (!sidebar || !toggle || !drawer) return;
    const expanded = compact.matches && open;
    sidebar.dataset.open = String(expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    byId('nav-toggle-label').textContent = expanded ? '收起' : '菜单';
    drawer.inert = compact.matches && !expanded;
    if (expanded) {
      const active = drawer.querySelector('a[aria-current="page"]');
      const target = active?.closest('.nav-group-panel').inert
        ? active.closest('.nav-group').querySelector('.nav-group-toggle')
        : active;
      (target || drawer.querySelector('button'))?.focus({ preventScroll: true });
    } else if (restoreFocus) toggle.focus();
  }

  function bindChrome() {
    byId('nav-toggle')?.addEventListener('click', () => setDrawer(byId('admin-sidebar').dataset.open !== 'true'));
    compact.addEventListener('change', () => setDrawer(false));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && byId('admin-sidebar')?.dataset.open === 'true') setDrawer(false, { restoreFocus: true });
    });
    byId('admin-nav')?.addEventListener('click', event => {
      const link = event.target.closest('a[data-path]');
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const path = link.dataset.path;
      const route = Router.routeFor(path);
      if (page !== 'console' || route?.href) {
        if (route?.page === page) { event.preventDefault(); setDrawer(false); return; }
        if (!confirmLeave('打开新页面')) event.preventDefault();
        return;
      }
      event.preventDefault();
      setDrawer(false);
      if (current?.path === path) byId(current.view)?.querySelector('[data-shell-title]')?.focus({ preventScroll: true });
      else navigate(path);
    });
    // 跳过导航链接不改写 hash，避免覆盖当前路由。
    document.querySelector('.skip-link')?.addEventListener('click', event => {
      event.preventDefault();
      byId('main')?.focus();
    });
    document.querySelector('.brand')?.addEventListener('click', event => {
      if (page !== 'console' || !caps) return;
      event.preventDefault();
      const target = Router.defaultPath(caps);
      if (target) navigate(target);
    });
    setDrawer(false);
  }

  async function start() {
    bindChrome();
    const account = window.AdminAccount;
    if (!Router || !account) return;
    await account.ready;
    if (!account.initialized) return;
    caps = account.capabilities;
    buildNav();
    if (page !== 'console') return;
    window.addEventListener('hashchange', handleHash);
    const result = Router.resolve(window.location.hash, caps);
    if (!result) return;
    if (result.denied) say('当前账号不能打开这个页面，已转到可用页面。');
    if (result.redirect) history.replaceState(history.state, '', `#${result.route.path}`);
    apply(result.route, { initial: true });
  }

  window.AdminShell = Object.freeze({
    page,
    get current() { return current; },
    get leaveConfirmed() { return leaveConfirmed; },
    // hooks: enter(route, info)、canEnter(route) 返回提示文字表示拒绝、dirty(area) 返回模块名表示有草稿、focusTarget(route)。
    register(name, hooks) {
      modules.set(name, hooks);
      if (current?.module === name && !entered.has(name)) {
        entered.add(name);
        hooks.enter?.(current, { initial: true, previous: null });
      }
    },
    navigate, confirmLeave, anyDirty, say,
  });

  // defer 脚本执行时 readyState 已是 interactive，但 account.js 还没运行；等 DOMContentLoaded 再启动。
  if (document.readyState === 'complete') start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
