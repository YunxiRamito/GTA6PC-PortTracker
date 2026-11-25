'use strict';

// Maintainer-only. Generate a review set from named source files. Generated
// output stays outside the publishable tree until its changes are reviewed.
const fs = require('node:fs');
const backend = require('./sync-core.cjs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const workspace = path.resolve(__dirname, '../..');
const source = path.resolve(process.env.GTAVI_SITE_SOURCE_DIR || process.env.GTAVI_SITE_SOURCE || path.join(workspace, 'gta6-pc-port-dashboard'));
const published = path.resolve(__dirname, '..');
const review = path.resolve(process.env.GTAVI_EXPORT_REVIEW_DIR || path.join(workspace, '.preview/public-source-review'));
const canonicalText = value => value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const digest = value => createHash('sha256').update(value).digest('hex');

function replace(text, pattern, next) {
  if (typeof pattern === 'string' ? !text.includes(pattern) : !pattern.test(text)) {
    throw new Error(`Expected source anchor changed: ${String(pattern)}`);
  }
  if (pattern instanceof RegExp) pattern.lastIndex = 0;
  return text.replace(pattern, next);
}

function cut(text, begin, end, substitute = '') {
  const start = text.indexOf(begin);
  const finish = text.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) throw new Error(`Expected section changed: ${begin}`);
  return text.slice(0, start) + substitute + text.slice(finish);
}

function chrome(html) {
  html = html.replace(/^.*(?:vi-favicon\.png|<script[^>]*src="\/assets\/(?:player|player-state|obs-import|feedback|danmaku|danmaku-mount|traffic)\.js(?:\?[^"\n]*)?"|<link[^>]*href="\/assets\/(?:player|obs-widget|feedback|danmaku)\.css(?:\?[^"\n]*)?").*(?:\n|$)/gm, '');
  html = html.replace('</head>', '<link rel="stylesheet" href="/assets/demo.css" />\n</head>');
  html = html.replace(/<a\b[^>]*\bhref="https?:\/\/[^"\n]+"[^>]*>[^]*?<\/a>/gi, '');
  html = html.replace(/<img\b[^>]*\bsrc="\/assets\/ui\/vi-mark\.webp"[^>]*>/g, '<span class="brand-mark demo-brand-mark" aria-hidden="true">VI</span>');
  html = html.replace(/^.*<span class="site-forum-placeholder".*\n/gm, '');
  html = replace(html, /^( +<div class="nav-actions">\n)[^]*?(^ +<button class="menu-toggle")/m, '$1$2');
  html = html.replace(/^.*(?:<audio id="siteMusic"|id="musicStatus"|<div data-danmaku-mount><\/div>).*(?:\n|$)/gm, '');
  html = html.replace(/\bdata-danmaku-mount\s+/g, '');
  html = html.replace(/^.*<meta name="port-tracker-public-origin"[^>]*>.*(?:\n|$)/gm, '');
  html = html.replace(/  <aside class=\"feedback-site-notice".*?<\/aside>\n/s, '');
  html = html.replaceAll('反馈建议', '反馈说明').replaceAll('href=\"#about"', 'href=\"/about/"');
  return html;
}

function publicWidgets(html, source) {
  html = html.replace('</head>', `
<link rel="stylesheet" href="/assets/feedback.css" />
<link rel="stylesheet" href="/assets/danmaku.css" />
<script defer src="/assets/feedback.js"></script>
<script defer src="/assets/danmaku-mount.js"></script>
<script defer src="/assets/danmaku.js"></script>
</head>`);
  const notice = source.match(/  <aside class="feedback-site-notice"[^]*?<\/aside>\n/)?.[0];
  if (notice) html = html.replace('  <div class="site-nav">', notice + '  <div class="site-nav">');
  const raw = source.match(/      <a class="nav-action site-account" id="siteAccount"[^]*?<\/a>\n/)?.[0];
  if (raw) {
    const account = raw.replace(/\s+href="[^"]*"/g, '').replace(' target="_blank"', '');
    html = html.replace('    <div class="nav-actions">\n', '    <div class="nav-actions">\n' + account);
  }
  if (html.includes('<div id="floatingWidgetDock">')) {
    return html.replace('<div id="floatingWidgetDock">', '<div id="floatingWidgetDock" data-danmaku-mount>');
  }
  return html.replace('</body>', '<div data-danmaku-mount></div>\n</body>');
}

function feedbackBrowser(text) {
  const height = text.slice(text.indexOf('  function syncSiteNoticeHeight() {'), text.indexOf('  function maybeReturnToPrimary()'))
    .replace("['mirrorPrimaryNoticeStrip', 'siteNoticeStrip']", "['siteNoticeStrip']");
  return cut(text, '  const MIRROR_NOTICE =', '  function getClientSecret()', height)
    .replace('getRandomValues is also available on the HTTP mirror.', 'Use browser-generated entropy for the local feedback identity.');
}

function neutralizeSourceLabels(text) {
  const publisher = ['Cyber', 'leek'].join('');
  return text.replaceAll(`${publisher} 公告翻译`, '社区公告')
    .replaceAll(`${publisher} 官网`, '活动来源')
    .replaceAll(`${publisher} 公告`, '社区公告')
    .replaceAll(publisher, '社区公告')
    .replaceAll('公告翻译', '社区公告');
}
function homepage(text) {
  let html = publicWidgets(chrome(text), text);
  html = replace(html, /<title>.*?<\/title>/, '<title>GTA VI · PC 移植观测站 · 源码演示</title>');
  html = replace(html, /<meta name="description"[^>]*>/, '<meta name="description" content="GTA VI PC 移植观测站的本地源码演示，全部数据为虚构示例。" />');
  html = replace(html, /<picture class="poster-final">[^]*?<\/picture>\s*<div class="poster-layers"[^>]*><\/div>/, `
      <div class="poster-final demo-poster" aria-hidden="true">
        <span class="demo-poster-grid"></span><span class="demo-poster-glow"></span>
        <span class="demo-poster-mark">VI</span><span class="demo-poster-caption">PORT TRACKER / LOCAL DEMO</span>
      </div>`);
  html = replace(html, /<h1 class="poster-caption-title" id="homeTitle">[^<]*<\/h1>/, '<h1 class="poster-caption-title" id="homeTitle">GTA VI 移植观测站</h1>');
  html = replace(html, /^ +<details class="qq-menu"[^]*?<\/details>\n/m, '');
  html = neutralizeSourceLabels(html)
    .replaceAll('下载分区', '示例资源')
    .replaceAll('下载<span>分区</span>', '示例<span>资源</span>')
    .replaceAll('已启动 GTA VI', '达到启动阶段')
    .replaceAll('数据更新于', '示例数据 · 更新于')
    .replace('独立社区观测站，仅收录公开项目与活动。', '本站是独立社区观测站的源码演示，项目、进度、新闻和统计均为虚构样例。');
  html = html.replace('id="onlineCompactCount">—', 'class="demo-traffic-label">本地</span><span id="onlineCompactCount">—');
  html = html.replace('class="traffic-head">访问统计', 'class="traffic-head">访问统计 · 本地');
  html = html.replace('</head>', '<script defer src="/assets/traffic.js"></script>\n</head>');
  return html.trimEnd() + '\n';
}

function archive(text) {
  let js = cut(text, '    var logoUrl =', '    var fallbackIcon =');
  js = cut(js, '  function safeProjectLogoUrl(', '  function safeColor(');
  js = cut(js, "    grid.addEventListener('error',", "    grid.addEventListener('animationstart',");
  js = replace(js, /    var url = escapeAttr\(safeHttpsUrl\(p\.url\).*\);/, "    var url = escapeAttr(safeHttpsUrl(p.url));");
  js = replace(js, "'<div class=\"card-identity\">' + image + fallbackIcon +", "'<div class=\"card-identity\">' + fallbackIcon +");
  js = replace(js,
    `'\x3ca class="card-repo" href="' + url + '" target="_blank" rel="noopener">' + escapeHtml(p.repo) + '</a>' +`,
    `(url ? '<a class="card-repo" href="' + url + '" target="_blank" rel="noopener">' + escapeHtml(p.repo) + '</a>' :
          '<span class="card-repo" tabindex="-1">' + escapeHtml(p.repo) + '</span>') +`);
  js = replace(js, /        ('<a class="card-link"[^\n]+)<\/a>' \+\n/, (match, link) => `        (url ? ${link}</a>' : '') +\n`);
  js = cut(js, '  function focusCommunityBuild() {', '    if (state.data && !state.projectsExpanded', '  function focusCommunityBuild() {\n');
  js = replace(js, '  function safeHttpsUrl(value) {', '  function safeHttpsUrl(value) {\n    if (typeof value === \'string\' && /^#[a-z0-9][a-z0-9-]*$/i.test(value)) return value;');
  return js.replaceAll('PortWatch VI 外部评估', '外部评估')
    .replaceAll('PortWatch VI 评估进度', '外部评估进度');
}

function contentBrowser(text) {
  let js = cut(text, '  function groupAvatar(', '  const renderers =');
  js = replace(js, ', community: renderCommunity', '');
  js = replace(js, /^        community: \['qqGroupNote'[^\n]+\n/m, '');
  js = replace(js, /^  async function refresh\(\) \{\n[^]*?^  \}\n/m, refresh => refresh
    .replace(/^([ \t]*)if \(key === ['"]community['"]\) \{\n[^]*?^\1\}[ \t]*\n/gm, '')
    .replace(/const stamp = key === 'community'\s*\? JSON\.stringify\(section, [^\n]+\)\s*:\s*JSON\.stringify\(section\);/g,
      'const stamp = JSON.stringify(section);'));
  js = replace(js, 'function link(el, value, allowMagnet = false) {', 'function link(el, value) {\n    if (typeof value === \'string\' && /^#[a-z0-9][a-z0-9-]*$/i.test(value)) {\n      el.href = value;\n      el.removeAttribute(\'target\');\n      el.removeAttribute(\'rel\');\n      return true;\n    }');
  js = replace(js, '  function safeHttpsSource(value) {', '  function safeHttpsSource(value) {\n    if (typeof value === \'string\' && /^#[a-z0-9][a-z0-9-]*$/i.test(value)) return new URL(value, document.baseURI);');
  js = replace(js, "(url.protocol === 'https:' || (allowMagnet && url.protocol === 'magnet:'))", "url.protocol === 'https:'");
  js = replace(js, "label: item.url?.startsWith('magnet:') ? '磁力链接' : '下载资源'", "label: '查看资源'");
  js = replace(js, 'link(anchor, channel.url, true)', 'link(anchor, channel.url)');
  js = replace(js, "'暂无下载条目。'", "(data.note || '暂无示例资源。')");
  js = replace(js, '    const publiclyListed = new Set(publicProjects);\n', '');
  js = cut(js, '      project: projectMap.get(r.id)', '      x: (r.score / 100) * W,', '      project: projectMap.get(r.id),\n');
  js = cut(js, "    if (leaderId === 'community-build') {", "    if (typeof leaderId === 'string'", "    if (leaderId === 'community-build') return '#community-build';\n");
  js = cut(js, '      const logo =', '      box.append(avatar);', `      const initial = document.createElement('span');
      initial.className = 'pp-avatar-fb';
      initial.setAttribute('aria-hidden', 'true');
      initial.textContent = (name || '?').slice(0, 2);
      art.append(initial);
`);
  js = cut(js, '  function safeProjectLogoUrl(', '  // ---- end port progress renderer ----');
  if (/renderCommunity|qqGroup|key\s*===\s*['"]community['"]|repositoryAvatarUrl/.test(js)) {
    throw new Error('Unexpected QQ or repository image code in public content renderer');
  }
  return neutralizeSourceLabels(js);
}

function contentServer(text) {
  let js = backend.content(text);
  // The demo ships its own scoring model and public dashboard projections.
  js = replace(js, /^const \{[^}]+\} = require\('\.\.\/assets\/port-score'\);\n/m, '');
  js = cut(js, '  function validateQuality(', '  function validatePortProgress(');
  js = replace(js, /const stages = \['loads', 'boots', 'menu', 'ingame'(?:, 'prison')?, 'rendered'\];/, "const stages = ['loads', 'boots', 'menu', 'ingame'];");
  js = replace(js, /\[\.\.\.stages, 'fps', 'stability', 'quality'(?:, 'milestoneLabel')?\]/, "[...stages, 'fps', 'stability']");
  if (js.includes('function withMilestoneLabel(')) {
    js = cut(js, 'function withMilestoneLabel(', 'function projectPublicContent(');
    js = replace(js, /^\s*if \(pp\.gta\.milestoneLabel !== undefined\)\n[^\n]*normalizeMilestoneLabel[^\n]*\n/m, '\n');
    js = replace(js, '  result.roadmap = mapRoadmapBuilds(content.roadmap, projectMilestoneLabel);\n', '');
    js = replace(js, 'withCountdownDefault(withNormalizedMilestoneLabels(normalized))', 'withCountdownDefault(normalized)');
    js = replace(js, 'withNewsIds(withNormalizedMilestoneLabels(compatible))', 'withNewsIds(compatible)');
    js = replace(js, 'projectPublicContent, projectMilestoneLabel,', 'projectPublicContent,');
  }
  js = replace(js, /^ *if \(pp\.gta\.quality !== undefined\) validateQuality.*\n/m, '');
  js = replace(js, "if (Object.hasOwn(roadmap, 'privateRepositories')) {", 'if (roadmap.privateRepositories !== undefined) {');
  js = replace(js, "items(roadmap.privateRepositories, 'roadmap.privateRepositories', 32,",
    "items(roadmap.privateRepositories, 'roadmap.privateRepositories', 160,");
  js = cut(js, '    required(build.title,', '    link(build.sourceUrl,', `    for (const [field, max] of [['title', 120], ['summary', 800], ['sourceLabel', 80]]) {
      check(validPlainText(build[field], max), loc + '.' + field, '需要 1–' + max + ' 个字符的纯文本');
    }
`);
  js = replace(js, /^const (?:WEBP_PREFIX|MAX_AVATAR_BYTES) = .*;\n/gm, '');
  js = cut(js, 'function validAvatar(', 'function normalizeNewsId(');
  js = cut(js, '  if (object(community)) {', '  return errors;', `  check(
    object(community) && Object.keys(community).length === 1 && Object.hasOwn(community, 'groups') &&
      Array.isArray(community.groups) && community.groups.length === 0,
    'community.groups', '演示版必须使用空列表',
  );
`);
  js = replace(js, '  const { newsIds, autoNewsCount = 2, ...home } = content.home;',
    '  result.community = { groups: [] };\n  const { newsIds, autoNewsCount = 2, ...home } = content.home;');
  return replace(js, 'function mergeCompatibleRoadmap(', `function projectPrivateRepositories(roadmap) {
  return (roadmap?.privateRepositories ?? []).map(({ id, title, summary, sourceLabel, sourceUrl, portProgress }) => ({
    id: 'private-repo-' + id, title, summary, sourceLabel, sourceUrl, portProgress,
  }));
}

function mergeCompatibleRoadmap(`)
    .replace('module.exports = { createContentStore, validateContent, projectPublicContent,',
      'module.exports = { createContentStore, validateContent, projectPublicContent, projectPrivateRepositories,');
}

function motion(text) {
  let js = text.replace(/^\/\*[^]*?\*\/\n/, '');
  js = cut(js, '  const layers =', '  const groups =');
  js = cut(js, "  let stageState =", '  const reveal =', `  let paused = false;

  const hasDesktopMotion = () => motion.matches && wheel.matches && desktopPoster.matches;
  function syncPoster() {
    if (!hasDesktopMotion()) clearPosterPaint();
    else if (posterHeight) queuePaint();
  }

`);
  return replace(js, '    stagePoster();\n', '');
}

function thanksMarkup(text) {
  let html = publicWidgets(chrome(text), text);
  html = replace(html, /^ +<img\b[^>]*\bsrc="\/assets\/art\/cover\/poster\.webp".*\n/m, '');
  return html.replace('这些朋友出钱支持了服务器和日常维护。站点能一直开着，有他们的一份。', '这份虚构名单用于演示社区鸣谢页。');
}

function aboutMarkup(text) {
  let html = publicWidgets(chrome(text), text);
  html = replace(html, /<div class="about-hero-media"[^>]*>[\s\S]*?<\/div>/,
    '<div class="about-hero-media" aria-hidden="true"></div>');
  html = replace(html, /<ul class="about-source-list">[^]*?<\/ul>/, `
      <ul class="about-source-list">
        <li class="about-enter"><span class="about-source-type">时间线</span><a href="/rss.xml">示例 RSS</a></li>
        <li class="about-enter"><span class="about-source-type">样例数据</span><a href="/api/dashboard">工程档案 JSON</a></li>
      </ul>`);
  return neutralizeSourceLabels(html)
    .replace('整理 GTA VI PC 移植相关的公开项目、进展与来源。', '使用虚构项目、记录和统计展示观测站的功能。')
    .replace('按主题整理可公开查看的信息；进入原始页面核对上下文与更新时间。', '各区使用同一组演示数据。选择主题可查看首页对应区域。')
    .replace('记录与移植相关的公开动态，并链接可复查来源。', '浏览并订阅样例动态。')
    .replace('区分 GTA VI 本体可玩记录与社区关注的工程节点。', '查看阶段详情与证据面板。')
    .replace('收录公开项目，注明仓库、测试对象及其公开进展。', '浏览项目卡片、进度与测试对象。')
    .replace('整理社区公告；不将其表述为 Rockstar 官方消息。', '浏览示例公告及对应站内入口。')
    .replace('不是游戏完成度', '工程评分')
    .replace('工程分数由本站按公开资料和站内规则计算，只用于整理工程档案；不表示 GTA VI 的完成百分比、可运行状态或官方认证。', '工程分数按技术里程碑计算。站内显示的分数与测试阶段均为样例。')
    .replace('以下为本站维护记录中使用的公开出处示例。每条项目进展应以其对应来源为准。', '可以直接查看本地演示的源数据。评分方法及第三方组件来源在仓库 README 中列出。')
    .replace('发现来源失效或记录有误，可提交反馈；社区支持者见鸣谢页。', '关于演示的问题可在仓库中提交 Issue。鸣谢页展示样例名单。')
    .replace('提交反馈 <svg', '反馈说明 <svg')
    .replace('公开信息可能滞后，请以原始来源为准。', '页面数据用于本地演示。');
}

function removePersonalBrand(text) {
  const brand = ['rami', 'rinko'].join('');
  return text.replace(new RegExp(brand, 'gi'), 'LOCAL CONSOLE');
}

function consoleMarkup(text) {
  const local = text.replace(/href="https?:\/\/[^"\s]+" data-site-path="(\/(?:about\/|thanks\/|feedback\/)?)"/g,
    'href="$1" data-site-path="$1"');
  let html = neutralizeSourceLabels(chrome(local));
  if (html.includes('id="username"')) {
    html = html.replace('</main>', '<p class="admin-local-help">首次运行时，请先用仓库提供的命令初始化本地站长账号。</p>\n</main>');
  }
  return removePersonalBrand(html);
}

function consoleEditor(text) {
  let js = cut(text, '  const avatarSize =', '  const projectTypes =');
  js = replace(js, /^    community: \{\n[^]*?^    \},\n/m, '');
  js = replace(js, /^.*(?:const avatarJobs =|avatarJobs\.clear\(\)).*\n/gm, '');
  js = replace(js, / \|\| avatarJobs\.size(?: > 0)?/g, '');
  js = replace(js, "    return content;\n  }", `    if (Object.keys(content.community).length !== 1 || content.community.groups.length !== 0) {
      throw new Error('community.groups 必须为空列表。');
    }
    return content;
  }`);
  js = replace(js, /^ *const id = text\(title\)\.trim\(\).*;\n/m, "        const id = 'legacy';\n");
  js = replace(js, "placeholder: '例如 cgbj'", "placeholder: '例如 sample-launch'");
  js = replace(js, '  const MAX_PRIVATE_REPOSITORIES = 32;', '  const MAX_PRIVATE_REPOSITORIES = 160;');
  js = replace(js, /^ *const summary = isRecord\(item\.portProgress\?\.gta\?\.quality\).*;\n/m, "        const summary = '移植评分';\n");
  return consoleScript(js);
}

function consoleRouter(text) {
  return consoleScript(replace(text, /^    \['community',[^\n]+\],\n/m, ''));
}

function server(text) {
  let js = backend.server(text);
  js = replace(js, /^const .*require\('\.\/api\/_(?:repository-images|qq-group-counts|obs)'\);\n/gm, '');
  js = cut(js, '    getContent() {', '    getDashboard()', `    getContent() {
      const { content, updatedAt, etag } = store.read();
      return { content: projectPublicContent(content), updatedAt, revision: etag };
    },
`);
  return replace(js,
    /^(      )const \{ payload, etag \} = publicContentResponse\(data, now\(\)\);\n([^]*?)^\1return sendJson\(res, 200, payload, headers, req\);$/m,
    '$1const etag = data.revision;\n$2$1return sendJson(res, 200, data, headers, req);');
}

function consoleScript(text) {
  const generic = neutralizeSourceLabels(removePersonalBrand(text));
  return generic
    .replaceAll('支持 HTTPS 或磁力链接', '支持 HTTPS 链接')
    .replaceAll('例如 磁力链接', '例如 项目文档')
    .replace("/^magnet:/i.test(text(item.url)) ? '磁力链接' : '下载资源'", "'下载资源'");
}

const inputs = {
  'api/_admin-accounts.js': null,
  'api/_admin-auth.js': null,
  'api/_danmaku-community-mutes.js': null,
  'api/_danmaku-history.js': null,
  'api/_danmaku-mutes.js': null,
  'api/_danmaku-nonces.js': null,
  'api/_danmaku-scheduled.js': null,
  'api/_danmaku-settings.js': null,
  'api/_danmaku-words.js': text => text.replace('the complete license-pinned list', 'the built-in list'),
  'api/_progress-history.js': null,
  'api/_sponsors.js': null,
  'api/_traffic-events.js': null,
  'api/_traffic-history.js': null,
  'api/traffic.js': text => text.replaceAll('process.env.TRACKER_PUBLIC_ORIGIN', "''"),
  'admin/account.js': null,
  'admin/admin.css': null,
  'admin/admin.js': consoleEditor,
  'admin/avatar.js': null,
  'admin/danmaku.js': null,
  'admin/feedback.css': null,
  'admin/feedback.html': consoleMarkup,
  'admin/feedback.js': null,
  'admin/index.html': consoleMarkup,
  'admin/login.css': null,
  'admin/login.html': consoleMarkup,
  'admin/login.js': null,
  'admin/router.js': consoleRouter,
  'admin/shell.js': consoleScript,
  'admin/sponsors.css': null,
  'admin/sponsors.html': consoleMarkup,
  'admin/sponsors.js': null,
  'about.html': aboutMarkup,
  'assets/about.css': null,
  'index.html': homepage,
  'app.js': archive,
  'styles.css': null,
  'thanks.html': thanksMarkup,
  'thanks.css': null,
  'thanks.js': null,
  'assets/chapters.css': null,
  'assets/dashboard.css': null,
  'assets/danmaku-mount.js': null,
  'assets/danmaku.css': null,
  'assets/danmaku.js': null,
  'assets/feedback.css': null,
  'assets/feedback.js': feedbackBrowser,
  'feedback.html': text => publicWidgets(chrome(text), text),
  'assets/hero-opening.css': null,
  'assets/motion.js': motion,
  'assets/navigation.js': null,
  'assets/progress-motion.css': null,
  'assets/project-progress.js': null,
  'assets/site-content.js': contentBrowser,
  'assets/site-topbar.css': null,
  'assets/site-widgets.css': null,
  'assets/traffic-history.js': null,
  'assets/traffic.js': null,
  'api/_content.js': contentServer,
  'api/_feedback.js': backend.feedback,
  'api/_danmaku.js': backend.danmaku,
  'api/_danmaku-filter.js': backend.filter,
  'api/_github-stats.js': backend.githubStats,
  // The dashboard projections, scoring model, and score tests are demo-owned.
  'server.js': server,
  'scripts/bootstrap-account-owner.js': backend.bootstrap,
  'api/_rss.js': value => value.replace('非官方 GTA VI 移植观测站的社区新闻与工程动态。', 'GTA VI 移植观测站源码演示。全部条目为虚构数据。'),
};

// Catch direct QQ locators and production-only adapters that new source code could reintroduce.
const privateDependencies = /\b(?:tencent:\/\/|(?:[a-z\d-]+\.)*qq\.com\b)|\/(?:assets\/(?:repository-avatars\/|qq-logo\.png)|api\/_(?:repository-images|qq-group-counts|obs)\b)/i;

function run() {
  const mode = process.argv[2];
  const approvedReview = process.argv[3];
  if (mode !== '--review' && mode !== '--apply') throw new Error('Use --review or --apply <review SHA-256>');
  const entries = [];
  for (const [rel, transform] of Object.entries(inputs)) {
    const file = path.join(source, rel);
    if (fs.realpathSync(file) !== path.join(fs.realpathSync(source), rel.replaceAll('/', path.sep))) {
      throw new Error(`Unexpected source path: ${rel}`);
    }
    const raw = canonicalText(fs.readFileSync(file, 'utf8'));
    const output = transform ? transform(raw) : raw;
    if (privateDependencies.test(output)) throw new Error(`Production-only dependency in public candidate: ${rel}`);
    const target = path.join(published, rel);
    const before = fs.existsSync(target) ? canonicalText(fs.readFileSync(target, 'utf8')) : null;
    entries.push({ rel, output, target, changed: output !== before });
  }
  const hash = digest(JSON.stringify(entries.map(({ rel, output }) => [rel, digest(output)])));
  if (mode === '--apply' && approvedReview !== hash) throw new Error('Source changed. Generate a new review set.');
  for (const { rel, output, target, changed } of entries) {
    const dest = mode === '--review' ? path.join(review, rel) : target;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (mode === '--review' || changed) fs.writeFileSync(dest, output);
    if (changed) console.log(rel);
  }
  console.log(`Review SHA-256 ${hash}`);
}

try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
