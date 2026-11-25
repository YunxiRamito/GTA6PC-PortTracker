// 后台的路由表、角色可见性和 hash 解析。纯逻辑，不碰 DOM；浏览器挂到 window.AdminRouter，Node 中可 require 测试。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdminRouter = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const CONTENT_SECTIONS = Object.freeze([
    ['home', '首页动态', 'HOME', 'home-progress'],
    ['playability', '可玩情况', 'PLAYABILITY', 'home-progress'],
    ['site-notices', '站点公告', 'SITE NOTICES', 'home-progress', {
      module: 'feedback', area: 'site-notices', view: 'site-notices-view', part: 'notices',
    }],
    ['countdown', '社区倒计时', 'COUNTDOWN', 'home-progress'],
    ['roadmap', '总进度', 'ROADMAP', 'home-progress'],
    ['news', '新闻时间线', 'NEWS', 'news-archives'],
    ['announcements', '站公告', 'NOTICES', 'news-archives'],
    ['projects', '工程档案', 'PROJECTS', 'news-archives'],
    ['downloads', '下载分区', 'DOWNLOADS', 'site-resources'],
  ]);
  const DANMAKU_TABS = Object.freeze([
    ['mutes', '禁言记录', 'MUTES'], ['messages', '近期弹幕', 'RECENT'], ['history', '历史弹幕', 'HISTORY'], ['words', '违禁词', 'WORDS'],
  ]);
  const RECORDS_INTRO = '禁言、解除禁言和词库操作会立即保存。';

  // cap：需要的能力；view：主后台里的视图元素 id；href：独立页地址；area：未保存修改的确认边界，同一 area 内切换不提示。
  const ROUTES = Object.freeze([
    ...CONTENT_SECTIONS.map(([part, label, en, , overrides], index) => ({
      path: `/content/${part}`, group: 'content', module: 'content', area: 'content', view: 'editorial-view', part, label,
      number: String(index).padStart(2, '0'), eyebrow: `CONTENT / ${String(index).padStart(2, '0')} ${en}`, cap: 'canEdit', ...overrides,
    })),
    ...DANMAKU_TABS.map(([part, label, en]) => ({
      path: `/danmaku/${part}`, group: 'community', module: 'danmaku', area: 'danmaku-records', view: 'danmaku-view', part, label,
      title: '弹幕记录', eyebrow: `DANMAKU / ${en}`, intro: RECORDS_INTRO, records: true, cap: 'canModerate',
    })),
    { path: '/danmaku/settings', group: 'community', module: 'danmaku', area: 'danmaku-settings', view: 'danmaku-view', part: 'settings',
      label: '弹幕设置', eyebrow: 'DANMAKU / SETTINGS', intro: '总开关、每日定时关闭、社区禁言票数和访客发送限制，点「保存设置」后生效。', cap: 'canEdit' },
    { path: '/danmaku/scheduled', group: 'community', module: 'danmaku', area: 'danmaku-scheduled', view: 'danmaku-view', part: 'scheduled',
      label: '自动消息', title: '自动管理员消息', eyebrow: 'DANMAKU / SCHEDULED',
      intro: '按间隔每次发送一条，按列表顺序循环。实时弹幕总开关关闭时暂停，恢复后继续。', cap: 'canEdit' },
    { path: '/feedback', group: 'community', module: 'feedback', area: 'feedback', view: 'feedback-view', part: 'inbox',
      page: 'feedback', standaloneHref: '/admin/feedback/', label: '反馈与通知', eyebrow: 'COMMUNITY / FEEDBACK', cap: 'canEdit' },
    { path: '/sponsors', group: 'community', module: 'sponsors', area: 'sponsors', view: 'sponsors-view', part: 'sponsors',
      page: 'sponsors', standaloneHref: '/admin/sponsors/', label: '鸣谢管理', eyebrow: 'COMMUNITY / SPONSORS', cap: 'canEdit' },
    { path: '/account/profile', group: 'account', module: 'account', area: 'account', view: 'account-view', part: 'profile',
      label: '个人资料', eyebrow: 'ACCOUNT / PROFILE', cap: 'canUseProfile' },
    { path: '/account/password', group: 'account', module: 'account', area: 'account', view: 'account-view', part: 'password',
      label: '更改密码', eyebrow: 'ACCOUNT / PASSWORD', cap: 'hasAccount' },
    { path: '/account/accounts', group: 'account', module: 'accounts', area: 'accounts', view: 'accounts-view', part: 'accounts',
      label: '账号管理', eyebrow: 'ACCOUNT / ACCESS', intro: '查看账户并按职责分配角色。', cap: 'canManageAccounts' },
    { path: '/account/create', group: 'account', module: 'accounts', area: 'accounts', view: 'accounts-view', part: 'create',
      label: '创建账号', eyebrow: 'ACCOUNT / CREATE', intro: '新账户首次登录时需要先设置密码。', cap: 'canCreateAccounts' },
  ].map(route => Object.freeze(route)));
  const BY_PATH = new Map(ROUTES.map(route => [route.path, route]));

  const GROUPS = Object.freeze([
    { id: 'content', label: '内容', eyebrow: 'CONTENT' },
    { id: 'community', label: '社区', eyebrow: 'COMMUNITY' },
    { id: 'account', label: '账户', eyebrow: 'ACCOUNT' },
  ]);

  const SUBGROUP_LABELS = Object.freeze({
    'home-progress': '首页与进度',
    'news-archives': '资讯与档案',
    'site-resources': '站点资源',
    danmaku: '弹幕',
    interaction: '互动',
    'account-settings': '账户设置',
    'account-management': '账户管理',
  });

  // 弹幕记录一项对应四个标签页；资料和改密各有独立导航入口。
  const NAV = Object.freeze([
    ...CONTENT_SECTIONS.map(([part, , , subgroup]) => ({ path: `/content/${part}`, subgroup })),
    { path: '/danmaku/mutes', subgroup: 'danmaku', label: '弹幕记录', match: DANMAKU_TABS.map(([part]) => `/danmaku/${part}`) },
    { path: '/danmaku/settings', subgroup: 'danmaku' },
    { path: '/danmaku/scheduled', subgroup: 'danmaku' },
    { path: '/feedback', subgroup: 'interaction' },
    { path: '/sponsors', subgroup: 'interaction' },
    { path: '/account/profile', subgroup: 'account-settings' },
    { path: '/account/password', subgroup: 'account-settings', forcedLabel: '设置新密码' },
    { path: '/account/accounts', subgroup: 'account-management' },
    { path: '/account/create', subgroup: 'account-management' },
  ]);

  const LEGACY_HASHES = Object.freeze({
    '#profile': '/account/profile',
    '#account': '/account/profile',
    '#change-password': '/account/password',
    '#accounts': '/account/accounts',
    '#danmaku': '/danmaku/mutes',
    '#danmaku-scheduled': '/danmaku/scheduled',
  });

  const ROLES = ['owner', 'admin', 'moderator', 'user'];

  // 与服务端 EDITOR_ROLES / MODERATOR_ROLES 一致；界面可见性只是提示，接口仍由服务器校验。
  function capabilities(account, accountMode = true) {
    const role = ROLES.includes(account?.role) ? account.role : null;
    const forced = accountMode && account?.needsPasswordChange === true;
    const canEdit = !accountMode || (!forced && (role === 'owner' || role === 'admin'));
    const canModerate = !accountMode || (!forced && (canEdit || role === 'moderator'));
    return Object.freeze({
      accountMode: Boolean(accountMode), forced, role,
      canEdit, canModerate,
      canManageAccounts: Boolean(accountMode) && !forced && (role === 'owner' || role === 'admin'),
      canCreateAccounts: Boolean(accountMode) && !forced && role === 'owner',
      hasAccount: Boolean(accountMode) && role !== null,
      canUseProfile: Boolean(accountMode) && role !== null && !forced,
    });
  }

  function allowed(route, caps) {
    if (!route || !caps) return false;
    if (caps.forced) return route.path === '/account/password';
    return caps[route.cap] === true;
  }

  function defaultPath(caps) {
    if (caps.forced) return '/account/password';
    if (caps.canEdit) return '/content/home';
    if (caps.canModerate) return '/danmaku/mutes';
    if (caps.canUseProfile) return '/account/profile';
    return null;
  }

  // 返回路径字符串；不是后台路由的 hash（如跳转链接 #main）返回 null。
  function parseHash(hash) {
    if (typeof hash !== 'string' || hash === '' || hash === '#' || hash === '#/') return '';
    if (Object.hasOwn(LEGACY_HASHES, hash)) return LEGACY_HASHES[hash];
    const match = /^#(\/[a-z0-9/-]{1,64})$/.exec(hash);
    if (!match) return null;
    return match[1].replace(/\/+$/, '') || '';
  }

  // 解析出最终要显示的路由；redirect 为 true 时应以 replace 方式改写地址。
  function resolve(hash, caps) {
    const parsed = parseHash(hash);
    const route = parsed ? BY_PATH.get(parsed) : undefined;
    if (route && !route.href && allowed(route, caps)) return { route, redirect: hash !== `#${route.path}` };
    const fallback = BY_PATH.get(defaultPath(caps));
    return fallback ? { route: fallback, redirect: true, denied: Boolean(route) } : null;
  }

  function hrefFor(route, page = 'console') {
    if (route.href) return route.href;
    return page === 'console' ? `#${route.path}` : route.standaloneHref || `/admin/#${route.path}`;
  }

  function navTree(caps, page = 'console') {
    return GROUPS.map(group => ({
      ...group,
      items: NAV.filter(item => {
        const route = BY_PATH.get(item.path);
        return route.group === group.id && allowed(route, caps);
      }).map(item => {
        const route = BY_PATH.get(item.path);
        return {
          path: route.path, label: (caps.forced && item.forcedLabel) || item.label || route.label, number: route.number || '',
          href: hrefFor(route, page), external: Boolean(route.href || (page !== 'console' && route.standaloneHref)),
          page: route.page || 'console',
          match: item.match || [route.path], subgroup: { id: item.subgroup, label: SUBGROUP_LABELS[item.subgroup] },
        };
      }),
    })).filter(group => group.items.length);
  }

  function isCurrent(item, currentPath, page) {
    if (item.external) return item.page === page;
    return page === 'console' && item.match.includes(currentPath);
  }

  function routeFor(path) {
    return BY_PATH.get(path) || null;
  }

  return Object.freeze({
    ROUTES, GROUPS, CONTENT_SECTIONS, DANMAKU_TABS, LEGACY_HASHES,
    capabilities, allowed, defaultPath, parseHash, resolve, hrefFor, navTree, isCurrent, routeFor,
  });
});
