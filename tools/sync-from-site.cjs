'use strict';

// Maintainer-only. Generate a review set from named source files. Generated
// output stays outside the publishable tree until its changes are reviewed.
const fs = require('node:fs');
const backend = require('./sync-core.cjs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const workspace = path.resolve(__dirname, '../..');
const source = path.resolve(process.env.GTAVI_SITE_SOURCE || path.join(workspace, 'gta6-pc-port-dashboard'));
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
  html = html.replace(/^.*(?:vi-favicon\.png|<script[^>]*src="\/assets\/(?:player|player-state|obs-import|feedback|danmaku|danmaku-translate|danmaku-mount|traffic)\.js(?:\?[^"\n]*)?"|<link[^>]*href="\/assets\/(?:player|obs-widget|feedback|danmaku)\.css(?:\?[^"\n]*)?").*(?:\n|$)/gm, '');
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
<script defer src="/assets/danmaku-translate.js"></script>
</head>`);
  const notice = source.match(/  <aside class="feedback-site-notice"[^]*?<\/aside>\n/)?.[0];
  if (notice) html = html.replace('  <div class="site-nav">', notice + '  <div class="site-nav">');
  const raw = source.match(/      <a class="nav-action site-account" id="siteAccount"[^]*?<\/a>\n/)?.[0];
  if (raw) {
    const account = raw.replace(/^\s*<a\b[^>]+>/, tag => tag.replace(/\s+href="[^"]*"/g, '').replace(' target="_blank"', ''));
    html = html.replace('    <div class="nav-actions">\n', '    <div class="nav-actions">\n' + account);
  }
  if (html.includes('<div id="floatingWidgetDock">')) {
    return html.replace('<div id="floatingWidgetDock">', '<div id="floatingWidgetDock" data-danmaku-mount>');
  }
  return html.replace('</body>', '<div data-danmaku-mount></div>\n</body>');
}

function feedbackMarkup(text) {
  return publicWidgets(chrome(text), text).replace('data-site-topbar="overlay"', 'data-site-topbar="inline"');
}

function feedbackBrowser(text) {
  const height = text.slice(text.indexOf('  function syncSiteNoticeHeight() {'), text.indexOf('  function maybeReturnToPrimary()'))
    .replace("['mirrorPrimaryNoticeStrip', 'siteNoticeStrip']", "['siteNoticeStrip']");
  const mirror = text.includes('  const PRIMARY_HOME =') ? '  const PRIMARY_HOME =' : '  const MIRROR_NOTICE =';
  return cut(text, mirror, '  function getClientSecret()', height)
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
  html = replace(html, /(<title\b[^>]*>)[^<]*(<\/title>)/, '$1GTA VI · PC 移植观测站 · 源码演示$2');
  html = replace(html, /(<meta name="description"[^>]*\scontent=")[^"]+/, '$1GTA VI PC 移植观测站的本地源码演示，全部数据为虚构示例。');
  html = replace(html, /<picture class="poster-final">[^]*?<\/picture>\s*<div class="poster-layers"[^>]*><\/div>/, `
      <div class="poster-final demo-poster" aria-hidden="true">
        <span class="demo-poster-grid"></span><span class="demo-poster-glow"></span>
        <span class="demo-poster-mark">VI</span><span class="demo-poster-caption">PORT TRACKER / LOCAL DEMO</span>
      </div>`);
  html = replace(html, /(<h1 class="poster-caption-title" id="homeTitle"[^>]*>)[^<]*(<\/h1>)/, '$1GTA VI 移植观测站$2');
  html = replace(html, /^ +<details class="qq-menu"[^]*?<\/details>\n/m, '');
  // Keep the public demo's scoring surface and scorer in sync.
  html = html.replace(/^<dialog class="port-score-dialog"[^]*?^<\/dialog>\n/gm, '')
    .replace(/^ +<button class="port-score-button port-score-trigger"[^]*?<\/button>\n/gm, '')
    .replace(/^<svg width="0" height="0"[^>]*>\n  <symbol id="port-score-graph-icon"[^\n]*\n<\/svg>\n/m, '')
    .replace(/^ +<div class="port-score-controls">\n( +<p class="(?:hero-opening-progress-score|port-progress-score)"[^\n]+)\n +<\/div>\n/gm, '$1\n');
  html = neutralizeSourceLabels(html)
    .replaceAll('下载分区', '示例资源')
    .replace(/下载(<span\b[^>]*>)分区/, '示例$1资源')
    .replaceAll('已启动 GTA VI', '达到启动阶段')
    .replaceAll('数据更新于', '示例数据 · 更新于')
    .replace('独立社区观测站，仅收录公开项目与活动。', '本站是独立社区观测站的源码演示，项目、进度、新闻和统计均为虚构样例。');
  html = html.replace('<span id="onlineCompactCount">—', '<span class="demo-traffic-label" data-i18n="pages.home.trafficMode">本地</span><span id="onlineCompactCount">—');
  html = replace(html, /(<div class="traffic-head"[^>]*>)访问统计/, '$1访问统计 · 本地');
  html = html.replace('</head>', '<script defer src="/assets/traffic.js"></script>\n</head>');
  return html.trimEnd() + '\n';
}

function archive(text) {
  let js = cut(text, '    var logoUrl =', '    var fallbackIcon =');
  js = cut(js, '  function safeProjectLogoUrl(', '  function safeColor(');
  js = cut(js, "    grid.addEventListener('error',", "    grid.addEventListener('animationstart',");
  js = replace(js, /^    var url = .*safeHttpsUrl\(p\.url\).*;$/m, '    var url = escapeAttr(localizedUrl(safeHttpsUrl(p.url)));');
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
  js = replace(js, /label: item\.url\?\.startsWith\('magnet:'\) \? [^\n]*?, url: item\.url/, "label: t('home.downloads.resource', '查看资源'), url: item.url");
  js = replace(js, 'link(anchor, channel.url, true)', 'link(anchor, channel.url)');
  js = replace(js, "t('home.downloads.empty', '暂无下载条目。')", "(data.note || t('home.downloads.empty', '暂无示例资源。'))");
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
  js = js.replace(/^  const scoreDialog = .*\n|^  let scoreRules(?:Progress|Opener);\n|^    scoreRulesProgress = .*\n|^    if \(scoreDialog\?\.open\).*\n|^    const scoreTrigger = .*\n|^  initScoreRules\(\);\n/gm, '');
  js = cut(js, '  function renderScoreRules(', '  function renderHomeProgress(');
  js = cut(js, '    if (scoreTrigger &&', '    const headings =');
  js = replace(js, "'home.port.bootCount', '已运行程序'", "'home.port.bootCount', '达到启动阶段'");
  if (/renderCommunity|qqGroup|key\s*===\s*['"]community['"]|repositoryAvatarUrl/.test(js)) {
    throw new Error('Unexpected QQ or repository image code in public content renderer');
  }
  return neutralizeSourceLabels(js);
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
  html = replace(html, /<ul class="about-source-list">[^]*?<\/ul>/, `<ul class="about-source-list">
        <li class="about-enter"><span class="about-source-type" data-i18n="pages.about.demoTimeline">时间线</span><a href="/rss.xml" data-i18n="pages.about.demoRss">示例 RSS</a></li>
        <li class="about-enter"><span class="about-source-type" data-i18n="pages.about.demoData">样例数据</span><a href="/api/dashboard" data-i18n="pages.about.demoDashboard">工程档案 JSON</a></li>
      </ul>`);
  return neutralizeSourceLabels(html)
    .replace('Port Tracker 由社区独立维护，整理公开项目、动态和来源，供玩家了解社区观测到的移植工程。', '此处用虚构项目、新闻和统计展示 Port Tracker 的功能。')
    .replace('翻译社区公告并保留原文入口。', '浏览示例公告及对应的站内链接。')
    .replace('GTA VI 本体的运行阶段以可复查记录为准。工具、着色器、测试程序和其他游戏的结果按各自的测试对象归档。', '样例场景展示各运行阶段和对应的证据面板。')
    .replace('条目分别标注项目方自述、公开视频或独立复测，并提供原始出处。引用 PortWatch VI 的评估时保留对应快照。', '演示条目标明证据类别和测试对象，并提供站内样例链接。')
    .replace('data-i18n-own="pages.feedback.send">提交反馈', 'data-i18n-own="pages.shared.feedback">反馈说明')
    .replace('内容可能滞后，请以原始来源为准。', '页面数据用于本地演示。');
}

function pageWords(text) {
  const demoCopy = {
    'pages.home.title': ['GTA VI · PC Port Tracker Demo', 'GTA VI · PC 移植トラッカーのデモ'],
    'pages.home.description': ['Local demo of the GTA VI PC Port Tracker with fictional projects, news, and statistics.', '架空のプロジェクト、ニュース、統計を使った GTA VI PC 移植トラッカーのローカルデモです。'],
    'pages.home.heading': ['GTA VI Port Tracker', 'GTA VI 移植トラッカー'],
    'pages.home.updatedAt': ['Demo data · Last updated:', 'デモデータ · 最終更新：'],
    'pages.home.downloads': ['Example resources', 'サンプル資料'],
    'pages.home.downloadsTitleStart': ['Example ', 'サンプル'],
    'pages.home.downloadsTitleAccent': ['Resources', '資料'],
    'pages.home.boots': ['Reached startup', '起動段階に到達'],
    'pages.home.traffic': ['Local traffic statistics', 'ローカルアクセス統計'],
    'pages.shared.independentTracker': ['Local demo of an independent tracker. All project, progress, news, and traffic records are fictional.', '独立したトラッカーのローカルデモです。プロジェクト、進捗、ニュース、アクセス統計はすべて架空です。'],
    'pages.about.lead': ['Explore Port Tracker with fictional projects, news, and statistics.', '架空のプロジェクト、ニュース、統計を使って Port Tracker の機能を紹介します。'],
    'pages.about.cyberleek': ['Community announcements', 'コミュニティのお知らせ'],
    'pages.about.cyberleekDesc': ['Browse example announcements and related links within the demo.', 'サンプルのお知らせと関連するサイト内リンクを確認できます。'],
    'pages.about.gameplayDesc': ['Example scenes demonstrate runtime stages and their evidence panels.', 'サンプルシーンで、動作段階と根拠パネルの見方を紹介します。'],
    'pages.about.attributionDesc': ['Demo entries show evidence categories, test targets, and links to examples within the site.', 'デモの各項目に、根拠の種類、テスト対象、サイト内のサンプルへのリンクを表示します。'],
    'pages.about.disclaimer': ['An independent community project, unaffiliated with Rockstar Games. Page data is for local demonstration.', '当サイトは独立したコミュニティプロジェクトであり、Rockstar Games とは無関係です。掲載データはローカルデモ用です。'],
    'pages.thanks.lead': ['This fictional list demonstrates the community thanks page.', 'この架空の一覧は、コミュニティへの謝辞ページのデモです。'],
  };
  const publicOnly = {
    'pages.home.trafficMode': ['Local', 'ローカル'],
    'pages.home.sampleTrafficMode': ['Sample', 'サンプル'],
    'pages.home.sampleTraffic': ['Sample traffic statistics', 'サンプルのアクセス統計'],
    'pages.about.demoTimeline': ['Timeline', 'タイムライン'],
    'pages.about.demoRss': ['Sample RSS', 'サンプル RSS'],
    'pages.about.demoData': ['Sample data', 'サンプルデータ'],
    'pages.about.demoDashboard': ['Project archive JSON', 'プロジェクト一覧の JSON'],
    'pages.feedback.previewNote': ['The feedback form is available in local site mode.', 'ローカルサイトモードでフィードバックフォームを利用できます。'],
  };
  const entry = (key, val) => `  '${key}': ${JSON.stringify(val)},`;
  let js = text.replace(/^ *'pages\.(?:about\.(?:portWatchSnapshot|victoryReadme|cyberleekMirror|rockstarPage)|home\.(?:posterAlt|qq\w+)|shared\.(?:officialGame|musicPlayer|siteAudio|playbackProgress|previousTrack|play|nextTrack|playlistTracks|playlistSource))':.*\n/gm, '');
  for (const [key, val] of Object.entries(demoCopy)) {
    js = replace(js, new RegExp(`^  '${key.replaceAll('.', '\\.')}':.*$`, 'm'), () => entry(key, val));
  }
  return replace(js, '\n});\nwindow.SiteI18n.apply();', `\n${Object.entries(publicOnly).map(([key, val]) => entry(key, val)).join('\n')}\n});\nwindow.SiteI18n.apply();`);
}

function homeWords(text) {
  const js = text.replace(/^ *'home\.(?:qq\.[^']*|scoreRules\.(?!legend)[^']*|downloads\.magnet)':.*\n/gm, '')
    .replace("['Cyberleek website', 'Cyberleek 公式サイト']", "['Event source', 'イベントの出典']")
    .replace("['Fully playable', '完全にプレイ可能']", "['Stable play', '安定してプレイ可能']")
    .replace("['Loads', '読み込み']", "['Program starts', 'プログラム起動']");
  return replace(js, "    'home.port.stage.stable':", "    'home.port.stage.fps30': ['30 FPS', '30 FPS'],\n    'home.port.stage.stable':");
}

function widgetWords(text) {
  const js = text.replace(/^ *'widgets\.(?:player\.|obs\.|feedback\.mirror)[^']*':.*\n/gm, '');
  // Keep badge copy in the public widget catalog, including when the source client inlines it.
  const badges = [
    "    'widgets.danmaku.rankTag': ['Identity badge', '識別バッジ'],",
    "    'widgets.danmaku.rankAuto': ['Automatic', '自動'],",
    "    'widgets.danmaku.rankNone': ['Hide badge', '表示しない'],",
    "    'widgets.danmaku.rankHint': ['This changes the displayed badge. Account permissions follow your role.', '表示するバッジを変更できます。アカウントの権限はロールで決まります。'],",
    "    'widgets.danmaku.rankReset': ['That badge is unavailable. Automatic selection is restored. Send again or choose a badge in Settings.', 'そのバッジは使えなくなったため、自動に戻しました。再送信するか、設定でバッジを選んでください。'],",
    "    'widgets.danmaku.rankForbidden': ['That badge is unavailable. Check your selection in Settings and send again.', 'そのバッジは使えなくなりました。設定で選択を確認してから再送信してください。'],",
  ];
  const missing = badges.filter(line => !js.includes(line.slice(0, line.indexOf(':')) + ':'));
  if (!missing.length) return js;
  return replace(js, /^    'widgets\.danmaku\.postingAs':.*$/m, anchor => [anchor, ...missing].join('\n'));
}

function translationIcon(text, publicSprite) {
  const translate = /^  <symbol id="translate"[^\n]*<\/symbol>$/m;
  const symbol = text.match(translate)?.[0];
  if (!symbol) throw new Error('Translation symbol is missing from the source Fluent sprite');
  if (!publicSprite) throw new Error('The public Fluent sprite is required to update the translation symbol');
  if (translate.test(publicSprite)) return publicSprite.replace(translate, () => symbol);
  return replace(publicSprite, /^<!-- Microsoft Fluent(?: UI)? System Icons[^\n]* -->$/m, notice => `${notice}\n${symbol}`);
}

function danmakuClient(text, requiredAnchor) {
  if (!text.includes(requiredAnchor)) throw new Error('Expected badge selection in the public danmaku client: ' + requiredAnchor);
  return text.replace(/^  window\.SiteI18n\?\.register\?\.\(\{\n[^]*?^  \}\);\n/gm, block =>
    /^    'widgets\.danmaku\.rank\w+':/m.test(block) ? block.replace(/^    'widgets\.danmaku\.(?:rank\w+|role(?:Owner|Admin|Moderator|Contributor))':.*\n/gm, '') : block)
    .replace(/^  window\.SiteI18n\?\.register\?\.\(\{\n  \}\);\n/gm, '');
}

function browserLocale(text) {
  return replace(text, String.raw`(?:about|thanks|feedback)\/?`, String.raw`(?:about|thanks|feedback)(?:\/|\.html)?`)
    .replace(String.raw`content|dashboard`, 'content|dashboard|sponsors');
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
  'api/_danmaku-rank-grants.js': null,
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
  'admin/rank-tags.js': null,
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
  'thanks.js': text => replace(text, "fetch('/api/sponsors',", "fetch(window.SiteI18n?.url('/api/sponsors') ?? '/api/sponsors',"),
  'assets/chapters.css': null,
  'assets/danmaku-translate.js': null,
  'assets/dashboard.css': null,
  'assets/danmaku-mount.js': text => danmakuClient(text, 'id="danmakuRankTagField"'),
  'assets/danmaku.css': null,
  'assets/danmaku.js': text => danmakuClient(text, 'function selectableRankTags('),
  'assets/feedback.css': null,
  'assets/feedback.js': feedbackBrowser,
  'feedback.html': feedbackMarkup,
  'assets/hero-opening.css': null,
  'assets/i18n.js': browserLocale,
  'assets/i18n.css': null,
  'assets/i18n-pages.js': pageWords,
  'assets/i18n-home.js': homeWords,
  'assets/i18n-widgets.js': widgetWords,
  'assets/motion.js': motion,
  'assets/navigation.js': null,
  'assets/progress-motion.css': null,
  'assets/project-progress.js': null,
  'assets/site-content.js': contentBrowser,
  'assets/site-topbar.css': null,
  'assets/site-widgets.css': null,
  'assets/ui/fluent.svg': translationIcon,
  'assets/traffic-history.js': null,
  'assets/traffic.js': null,
  'api/_content-locale.js': null,
  'api/_feedback.js': backend.feedback,
  'api/_danmaku.js': backend.danmaku,
  'api/_danmaku-filter.js': backend.filter,
  // The public entry points, content store, RSS, and scoring are maintained here.
  'scripts/bootstrap-account-owner.js': backend.bootstrap,
};

const localeInputs = new Set([
  'about.html', 'feedback.html', 'index.html', 'thanks.html', 'app.js', 'thanks.js',
  'assets/danmaku-translate.js', 'assets/danmaku.js', 'assets/danmaku-mount.js',
  'assets/feedback.js', 'assets/i18n.js', 'assets/i18n.css', 'assets/i18n-pages.js', 'assets/i18n-home.js',
  'assets/i18n-widgets.js', 'assets/navigation.js', 'assets/site-content.js', 'assets/traffic.js',
  'assets/traffic-history.js', 'assets/ui/fluent.svg', 'api/_content-locale.js',
]);

// Catch direct QQ locators and production-only adapters that new source code could reintroduce.
const privateDependencies = /\b(?:tencent:\/\/|(?:[a-z\d-]+\.)*qq\.com\b)|\/(?:assets\/(?:repository-avatars\/|qq-logo\.png)|api\/_(?:repository-images|qq-group-counts|obs)\b)/i;

function run() {
  const mode = process.argv[2];
  const approvedReview = mode === '--apply' ? process.argv[3] : undefined;
  const options = process.argv.slice(mode === '--apply' ? 4 : 3);
  if (!['--review', '--apply'].includes(mode) || options.length > 1 || options.some(option => option !== '--i18n')) {
    throw new Error('Use --review [--i18n] or --apply <review SHA-256> [--i18n]');
  }
  const onlyLocale = options.includes('--i18n');
  const entries = [];
  for (const [rel, transform] of Object.entries(inputs)) {
    if (onlyLocale && !localeInputs.has(rel)) continue;
    const file = path.join(source, rel);
    if (fs.realpathSync(file) !== path.join(fs.realpathSync(source), rel.replaceAll('/', path.sep))) {
      throw new Error(`Unexpected source path: ${rel}`);
    }
    const raw = canonicalText(fs.readFileSync(file, 'utf8'));
    const target = path.join(published, rel);
    const before = fs.existsSync(target) ? canonicalText(fs.readFileSync(target, 'utf8')) : null;
    const output = transform ? transform(raw, before) : raw;
    if (privateDependencies.test(output)) throw new Error(`Production-only dependency in public candidate: ${rel}`);
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
