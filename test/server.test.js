'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { createAdminAccounts } = require('../api/_admin-accounts');
const { createContentStore, validateContent } = require('../api/_content');
const { createDashboard } = require('../api/dashboard');
const { createFixtures } = require('../fixtures/demo');
const { createSiteServer } = require('../server');
const { createDemoServer } = require('../preview');

const workspace = path.resolve(__dirname, '..');
const loopback = '127.0.0.1';
const scrollbarBootstrap = '/assets/site-scrollbars.js';

async function listener(t, server) {
  server.listen(0, loopback);
  await once(server, 'listening');
  t.after(async () => {
    await server.closeDanmaku?.();
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  });
  return `http://${loopback}:${server.address().port}`;
}

async function runtime() {
  const directory = await fs.mkdtemp(path.join(workspace, '.test-runtime-'));
  const cleanup = async () => {
    const [root, target] = await Promise.all([fs.realpath(workspace), fs.realpath(directory)]);
    if (path.dirname(target) !== root || !path.basename(target).startsWith('.test-runtime-')) {
      throw new Error('Unexpected test runtime path');
    }
    await fs.rm(target, { recursive: true, force: true });
  };
  return { directory, cleanup };
}

function send(origin, route, { method = 'GET', cookie, data, headers = {} } = {}) {
  const fields = new Headers(headers);
  if (cookie) fields.set('Cookie', cookie);
  if (data !== undefined) fields.set('Content-Type', 'application/json');
  return fetch(origin + route, {
    method, headers: fields, body: data === undefined ? undefined : JSON.stringify(data), redirect: 'manual',
  });
}

async function json(response, status) {
  assert.equal(response.status, status);
  return response.json();
}

function sessionCookie(response) {
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie, 'Expected a session cookie');
  return cookie;
}

async function readScrollbarPage(response, route) {
  assert.equal(response.status, 200, route);
  assert.match(response.headers.get('content-security-policy') || '', /(?:^|;\s*)script-src 'self'(?:;|$)/, route);
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b[^>]*\ssrc="([^"\s]+)"[^>]*>/g)]
    .filter(([, src]) => src.split('?')[0] === scrollbarBootstrap);
  assert.equal(scripts.length, 1, route + ' must load the same-origin scrollbar bootstrap once');
  const [[tag]] = scripts;
  assert.match(tag, /\sdefer(?=[\s>])/, route + ' must defer the scrollbar bootstrap');
  assert.doesNotMatch(tag, /\sasync(?=[\s=>])/, route + ' must not load the scrollbar bootstrap asynchronously');
  return html;
}

function checkDemoPrivateRepositories(archive) {
  assert.deepEqual(archive.privateRepositories.map(project => project.id), ['private-repo-sample-launch', 'private-repo-sample-render']);
  for (const project of archive.privateRepositories) {
    assert.deepEqual(Object.keys(project).sort(), ['id', 'portProgress', 'sourceLabel', 'sourceUrl', 'summary', 'title', 'translations']);
    assert.equal(project.sourceUrl, '#about');
  }
  assert.equal(archive.progress.leaderId, 'private-repo-sample-launch');
  assert.equal(archive.progress.leaderName, archive.privateRepositories[0].title);
  assert.equal(archive.progress.score, 58);
  assert.deepEqual(archive.progress.ranked.filter(project => project.id.startsWith('private-repo-')).map(project => project.score), [58, 5.5]);
  assert.equal(archive.progress.rankedCount, 5);
  assert.equal(archive.stats.total, 5);
  assert.equal(archive.projects.length, 5);
  assert.equal(archive.stats.totalStars, 322);
}

test('functional backend stores edits, enforces roles, and serves community routes', async t => {
  const { directory, cleanup } = await runtime();
  const accountFile = path.join(directory, 'accounts.json');
  const ownerPassword = randomBytes(24).toString('base64url');
  const memberPassword = randomBytes(24).toString('base64url');
  const ownerName = 'local-owner-example';
  const accounts = createAdminAccounts({ filePath: accountFile, bootstrap: { username: ownerName, password: ownerPassword }, confirmedInitialOwner: ownerName });
  await accounts.initialize();
  const server = createSiteServer({ runtimeDir: directory, accounts, liveGitHub: false });
  const origin = await listener(t, server);
  t.after(cleanup);

  const home = await send(origin, '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /GTA VI 移植观测站/);
  const archive = await json(await send(origin, '/api/dashboard'), 200);
  checkDemoPrivateRepositories(archive);
  assert.ok(archive.projects.every(project => project.repo.startsWith('demo-workshop/')));
  assert.equal((await send(origin, '/rss.xml')).status, 200);
  assert.equal((await send(origin, '/admin/')).headers.get('location'), '/admin/login');
  assert.equal((await send(origin, '/admin/login')).headers.get('referrer-policy'), 'same-origin');
  assert.equal((await send(origin, '/api/admin/content/home')).status, 401);
  assert.equal((await send(origin, '/api/_admin-accounts.js')).status, 404);
  assert.equal((await send(origin, '/.runtime/accounts.json')).status, 404);

  const login = await send(origin, '/api/admin/session', { method: 'POST', data: { username: ownerName, password: ownerPassword } });
  const cookie = sessionCookie(login);
  const { account } = await json(login, 200);
  assert.equal(account.role, 'owner');
  assert.equal((await send(origin, '/admin/', { cookie })).status, 200);
  assert.equal((await send(origin, '/admin/feedback/', { cookie })).status, 200);
  assert.equal((await send(origin, '/admin/sponsors/', { cookie })).status, 200);

  const before = await send(origin, '/api/admin/content/home', { cookie });
  const revision = before.headers.get('etag');
  const { content } = await json(before, 200);
  const next = { ...content, latestUpdate: '已保存的本地测试文本。' };
  assert.equal((await send(origin, '/api/admin/content/home', { method: 'PUT', data: next, cookie })).status, 428);
  await json(await send(origin, '/api/admin/content/home', { method: 'PUT', data: next, cookie, headers: { 'If-Match': revision } }), 200);
  assert.equal((await send(origin, '/api/admin/content/home', { method: 'PUT', data: next, cookie, headers: { 'If-Match': revision } })).status, 412);
  assert.equal((await json(await send(origin, '/api/content'), 200)).content.home.latestUpdate, next.latestUpdate);
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'content.json'), 'utf8'));
  assert.equal(saved.content.home.latestUpdate, next.latestUpdate);

  const roadmapUrl = '/api/admin/content/roadmap';
  const roadmapResponse = await send(origin, roadmapUrl, { cookie });
  const roadmapRevision = roadmapResponse.headers.get('etag');
  const { content: roadmap } = await json(roadmapResponse, 200);
  const first = roadmap.privateRepositories[0];
  const writeRoadmap = data => send(origin, roadmapUrl, { method: 'PUT', data, cookie, headers: { 'If-Match': roadmapRevision } });
  const invalid = await writeRoadmap({ ...roadmap, privateRepositories: [first, { ...first, repo: 'demo-workshop/hidden-example' }] });
  const failure = await json(invalid, 422);
  assert.ok(failure.details.some(detail => detail.includes('privateRepositories[2].id')));
  assert.ok(failure.details.some(detail => detail.includes('privateRepositories[2].repo')));
  assert.equal((await send(origin, roadmapUrl, { cookie })).headers.get('etag'), roadmapRevision);
  const proposal = { ...roadmap, privateRepositories: roadmap.privateRepositories.slice(1) };
  const { content: updated } = await json(await writeRoadmap(proposal), 200);
  assert.deepEqual(updated.privateRepositories, proposal.privateRepositories);
  assert.equal((await writeRoadmap(roadmap)).status, 412);
  assert.deepEqual((await json(await send(origin, '/api/content'), 200)).content.roadmap.privateRepositories, proposal.privateRepositories);
  const reread = createContentStore({ filePath: path.join(directory, 'content.json') }).read('roadmap');
  assert.deepEqual(reread.content.privateRepositories, proposal.privateRepositories);
  const changedArchive = await json(await send(origin, '/api/dashboard'), 200);
  assert.deepEqual(changedArchive.privateRepositories.map(project => project.id), ['private-repo-sample-render']);
  assert.equal(changedArchive.progress.score, 46);
  assert.deepEqual(changedArchive.stats, archive.stats);

  const username = 'local-member-example';
  await json(await send(origin, '/api/admin/register', { method: 'POST', data: {
    username, password: memberPassword, confirmPassword: memberPassword, nickname: '本地样例',
  } }), 201);
  const memberLogin = await send(origin, '/api/admin/session', { method: 'POST', data: { username, password: memberPassword } });
  const memberCookie = sessionCookie(memberLogin);
  const member = (await json(memberLogin, 200)).account;
  assert.equal(member.role, 'user');
  assert.equal((await send(origin, '/api/admin/content/home', { cookie: memberCookie })).status, 403);


  const rankGrants = await send(origin, '/api/admin/danmaku/rank-tags?q=local-member-example', { cookie });
  const rankSearch = await json(rankGrants, 200);
  assert.equal(rankSearch.accounts[0].id, member.id);
  assert.deepEqual((await json(await send(origin, '/api/admin/danmaku/rank-tags', { cookie: memberCookie }), 403)).error, '当前账号没有这项权限');
  await json(await send(origin, '/api/admin/danmaku/rank-tags', {
    method: 'PUT', cookie, data: { accountId: member.id, tag: 'moderator', enabled: true },
  }), 200);
  const memberDanmakuSession = await json(await send(origin, '/api/admin/danmaku/session', { cookie: memberCookie }), 200);
  assert.ok(memberDanmakuSession.rankTags.includes('moderator'));
  const memberSendNonce = await json(await send(origin, '/api/admin/danmaku/nonce?action=send', { cookie: memberCookie }), 200);
  const taggedMessage = await json(await send(origin, '/api/admin/danmaku/messages', {
    method: 'POST', cookie: memberCookie, data: { nonce: memberSendNonce.nonce, text: 'Granted badge sample', rankTag: 'moderator' },
  }), 201);
  assert.equal(taggedMessage.rankTag, 'moderator');
  const rankedRecent = await json(await send(origin, '/api/danmaku/recent'), 200);
  assert.equal(rankedRecent.messages.find(item => item.text === 'Granted badge sample')?.rankTag, 'moderator');
  const rejectedTagNonce = await json(await send(origin, '/api/admin/danmaku/nonce?action=send', { cookie: memberCookie }), 200);
  const rejectedTag = await send(origin, '/api/admin/danmaku/messages', {
    method: 'POST', cookie: memberCookie, data: { nonce: rejectedTagNonce.nonce, text: 'Unassigned badge sample', rankTag: 'owner' },
  });
  const rejectedTagPayload = await json(rejectedTag, 403);
  assert.equal(rejectedTagPayload.code, 'rank_tag_forbidden');
  const feedbackHeaders = { 'X-Feedback-Client': randomBytes(32).toString('hex') };
  const { feedback } = await json(await send(origin, '/api/feedback', { method: 'POST', headers: feedbackHeaders, data: { text: '本地反馈测试' } }), 201);
  const feedbackList = await json(await send(origin, '/api/admin/feedback', { cookie }), 200);
  assert.equal(feedbackList.feedback[0].id, feedback.id);
  await json(await send(origin, `/api/admin/feedback/${feedback.id}/reply`, { method: 'PUT', cookie, data: { text: '本地回复测试' } }), 200);
  assert.equal((await json(await send(origin, '/api/feedback/replies', { headers: feedbackHeaders }), 200)).replies[0].text, '本地回复测试');

  const sponsorIndex = await send(origin, '/api/admin/sponsors', { cookie });
  const sponsorsRevision = sponsorIndex.headers.get('etag');
  assert.deepEqual((await json(sponsorIndex, 200)).sponsors, []);
  await json(await send(origin, '/api/admin/sponsors', {
    method: 'PUT', cookie, headers: { 'If-Match': sponsorsRevision }, data: { sponsors: [{ accountId: member.id, message: '本地鸣谢测试' }] },
  }), 200);
  const { sponsors } = await json(await send(origin, '/api/sponsors'), 200);
  assert.equal(sponsors[0].nickname, '本地样例');
  assert.deepEqual(Object.keys(sponsors[0]).sort(), ['avatar', 'id', 'message', 'nickname']);

  assert.equal((await json(await send(origin, '/api/danmaku/config'), 200)).adminOrigin, origin);
  const { nonce } = await json(await send(origin, '/api/danmaku/nonce'), 200);
  await json(await send(origin, '/api/danmaku', { method: 'POST', data: { nonce, text: '本地弹幕测试', color: 'mint' } }), 201);
  const recent = await json(await send(origin, '/api/danmaku/recent'), 200);
  assert.ok(JSON.stringify(recent).includes('本地弹幕测试'));
  assert.equal((await send(origin, '/api/traffic')).status, 200);
  assert.equal((await send(origin, '/api/traffic/history')).status, 200);
});

test('screenshot preview responds from fixtures and rejects writes', async t => {
  const server = createDemoServer();
  const origin = await listener(t, server);
  const content = await json(await send(origin, '/api/content'), 200);
  assert.match(content.content.home.latestUpdate, /虚构/);
  checkDemoPrivateRepositories(await json(await send(origin, '/api/dashboard'), 200));
  assert.equal((await send(origin, '/api/feedback', { method: 'POST', data: { text: 'sample' } })).status, 405);
  assert.equal((await send(origin, '/about/')).status, 200);
});

test('both entry points serve the shared scrollbar theme on every public page', async t => {
  const sharedCss = '/assets/site-topbar.css';
  const enhancementCss = '/assets/site-scrollbars.css';
  const themeBlock = /\/\* site-scrollbars:start \*\/[\s\S]*?\/\* site-scrollbars:end \*\//;
  const overrides = /\bscrollbar-(?:color|width)\s*:|::-webkit-scrollbar\b/i;
  for (const mode of ['site', 'preview']) {
    await t.test(mode, async t => {
      const { directory, cleanup } = mode === 'site' ? await runtime() : {};
      const origin = await listener(t, mode === 'site'
        ? createSiteServer({ runtimeDir: directory, liveGitHub: false })
        : createDemoServer());
      if (cleanup) t.after(cleanup);

      const stylesheets = new Set();
      for (const route of ['/', '/about/', '/feedback/', '/thanks/', '/can-i-run/']) {
        const html = await readScrollbarPage(await send(origin, route), route);
        const links = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)].map(([, href]) => href);
        assert.ok(links.some(href => new URL(href, origin).pathname === sharedCss), `${route} must load ${sharedCss}`);
        for (const href of links) stylesheets.add(href);
      }
      if (mode === 'preview') assert.equal((await send(origin, '/admin/')).status, 404);
      for (const href of stylesheets) {
        const stylesheet = await send(origin, href);
        assert.equal(stylesheet.status, 200, href);
        assert.match(stylesheet.headers.get('content-type'), /^text\/css\b/i);
        const css = await stylesheet.text();
        const { pathname } = new URL(href, origin);
        if (pathname === sharedCss) {
          const theme = css.match(themeBlock)?.[0];
          assert.ok(theme, 'The shared stylesheet must contain the canonical scrollbar theme');
          assert.match(theme, /scrollbar-color\s*:/);
          assert.match(theme, /::-webkit-scrollbar-thumb\b/);
        }
        if (pathname === enhancementCss) {
          assert.match(css, /os-scrollbar-auto-hide-hidden\s*\{[^}]*opacity:\s*\.055;[^}]*visibility:\s*visible/s);
          assert.match(css, /os-scrollbar-interaction\s*\{[^}]*opacity:\s*1;[^}]*visibility:\s*visible/s);
        }
        // The shared touch enhancement has its own feature probe with scrollbar hiding rules.
        if (pathname !== enhancementCss) {
          assert.doesNotMatch(css.replace(themeBlock, ''), overrides, `${href} overrides the shared theme`);
        }
      }
    });
  }
});

test('admin entries defer the shared scrollbar bootstrap without changing access', async t => {
  const { directory, cleanup } = await runtime();
  const username = 'local-owner-example';
  const password = randomBytes(24).toString('base64url');
  const accounts = createAdminAccounts({
    filePath: path.join(directory, 'accounts.json'),
    bootstrap: { username, password },
    confirmedInitialOwner: username,
  });
  await accounts.initialize();
  const origin = await listener(t, createSiteServer({ runtimeDir: directory, accounts, liveGitHub: false }));
  t.after(cleanup);

  const redirect = await send(origin, '/admin/');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/admin/login');
  await readScrollbarPage(await send(origin, '/admin/login'), '/admin/login');

  const login = await send(origin, '/api/admin/session', { method: 'POST', data: { username, password } });
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login);
  for (const route of ['/admin/', '/admin/feedback/', '/admin/sponsors/']) {
    await readScrollbarPage(await send(origin, route, { cookie }), route);
  }
});

test('both entry points serve the exact scrollbar runtime assets', async t => {
  const assets = [
    scrollbarBootstrap,
    '/assets/site-scrollbars.css',
    '/assets/vendor/overlayscrollbars-2.17.0.min.js',
    '/assets/vendor/overlayscrollbars-2.17.0.min.css',
  ];
  for (const mode of ['site', 'preview']) {
    await t.test(mode, async t => {
      const { directory, cleanup } = mode === 'site' ? await runtime() : {};
      const origin = await listener(t, mode === 'site'
        ? createSiteServer({ runtimeDir: directory, liveGitHub: false })
        : createDemoServer());
      if (cleanup) t.after(cleanup);

      for (const route of assets) {
        const response = await send(origin, route);
        assert.equal(response.status, 200, route);
        const mime = route.endsWith('.js') ? /^text\/javascript\b/i : /^text\/css\b/i;
        assert.match(response.headers.get('content-type') || '', mime, route);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(path.join(workspace, route.slice(1))), route);
      }
      // Notices ship in the repository without opening a route for the vendor directory.
      assert.equal((await send(origin, '/assets/vendor/OverlayScrollbars-PROVENANCE.txt')).status, 404);
    });
  }
});

test('both entry points localize records and feeds without changing IDs, URLs, or scores', async t => {
  for (const mode of ['site', 'preview']) {
    await t.test(mode, async t => {
      const { directory, cleanup } = mode === 'site' ? await runtime() : {};
      const fixed = Date.parse('2026-02-01T00:00:00Z');
      const origin = await listener(t, mode === 'site'
        ? createSiteServer({ runtimeDir: directory, now: () => fixed, liveGitHub: false })
        : createDemoServer({ now: fixed }));
      if (cleanup) t.after(cleanup);

      const base = await send(origin, '/api/content');
      const baseTag = base.headers.get('etag');
      const chinese = (await json(base, 200)).content;
      const archive = await json(await send(origin, '/api/dashboard'), 200);
      const feed = await (await send(origin, '/rss.xml')).text();
      const itemIds = xml => [...xml.matchAll(/<guid isPermaLink="false">(.*?)<\/guid>/g)].map(([, guid]) => guid);
      const recordIds = rows => rows.map(row => [row.id, row.sourceUrl, row.url, row.repo, row.date]);
      const tags = new Set([baseTag]);
      for (const locale of ['en', 'ja']) {
        const query = '?lang=' + locale;
        const content = await send(origin, '/api/content' + query, { headers: { 'If-None-Match': baseTag } });
        assert.equal(content.headers.get('content-language'), locale);
        const tag = content.headers.get('etag');
        assert.ok(tag && !tags.has(tag));
        tags.add(tag);
        const localized = (await json(content, 200)).content;
        assert.equal(localized.home.latestUpdate, chinese.home.translations[locale].latestUpdate);
        assert.equal(localized.home.latestNews[0].title, chinese.home.latestNews[0].translations[locale].title);
        assert.equal(localized.announcements.items[0].buttons[0].url, '#dashboard');
        assert.equal(localized.countdown.target, chinese.countdown.target);
        assert.deepEqual(recordIds(localized.roadmap.gameplayProgress.milestones), recordIds(chinese.roadmap.gameplayProgress.milestones));
        assert.doesNotMatch(JSON.stringify(localized), /"translations"/);
        const cached = await send(origin, '/api/content' + query, { headers: { 'If-None-Match': tag } });
        assert.equal(cached.status, 304);
        assert.equal(cached.headers.get('content-language'), locale);

        const localizedArchive = await send(origin, '/api/dashboard' + query);
        assert.equal(localizedArchive.headers.get('content-language'), locale);
        const data = await json(localizedArchive, 200);
        assert.equal(data.progress.score, archive.progress.score);
        assert.equal(data.progress.leaderId, archive.progress.leaderId);
        assert.deepEqual(data.progress.ranked, archive.progress.ranked);
        assert.deepEqual(data.stats, archive.stats);
        assert.deepEqual(recordIds(data.projects), recordIds(archive.projects));
        assert.deepEqual(recordIds(data.privateRepositories), recordIds(archive.privateRepositories));
        assert.deepEqual(recordIds(data.timeline), recordIds(archive.timeline));
        assert.equal(data.progress.leaderName, data.privateRepositories[0].title);
        assert.notEqual(data.progress.leaderName, archive.progress.leaderName);
        assert.equal(data.projects[0].summary, archive.projects[0].translations[locale].summary);

        const translatedFeed = await send(origin, '/rss.xml' + query);
        assert.equal(translatedFeed.status, 200);
        assert.equal(translatedFeed.headers.get('content-language'), locale);
        const xml = await translatedFeed.text();
        assert.ok(xml.includes('<language>' + locale + '</language>'));
        assert.ok(xml.includes('/rss.xml' + query + '" rel="self"'));
        assert.ok(xml.includes(query + '#timeline'));
        assert.ok(xml.includes(data.timeline[0].title));
        assert.deepEqual(itemIds(xml), itemIds(feed));
      }
      const fallback = await send(origin, '/api/content?lang=fr');
      assert.equal(fallback.headers.get('content-language'), 'zh-CN');
      assert.equal(fallback.headers.get('etag'), baseTag);
      if (mode === 'preview') {
        const redirect = await send(origin, '/thanks?lang=ja');
        assert.equal(redirect.headers.get('location'), '/thanks/?lang=ja');
        const sponsorData = await json(await send(origin, '/api/sponsors?lang=ja'), 200);
        assert.deepEqual(sponsorData.sponsors.map(sponsor => sponsor.id), ['demo-type', 'demo-motion', 'demo-fixture']);
        assert.match(sponsorData.sponsors[0].nickname, /サンプル/);
        const feedback = await (await send(origin, '/feedback/?lang=ja')).text();
        assert.match(feedback, /data-i18n="pages.feedback.previewNote"/);
        assert.doesNotMatch(feedback, /<form\b|danmaku-translate\.js/);
      }
    });
  }
});

test('optional translations validate fields and fall back to original copy', () => {
  const { localizePublicContent } = require('../api/_content-locale');
  const { projectPublicContent } = require('../api/_content');
  const { content } = createFixtures(Date.parse('2026-02-01T00:00:00Z'));
  assert.deepEqual(validateContent(content), []);
  const [news] = content.news;
  const { translations: omitted, ...original } = news;
  const legacy = { ...content, news: [original, ...content.news.slice(1)] };
  assert.deepEqual(validateContent(legacy), []);
  assert.equal(localizePublicContent(projectPublicContent(legacy), 'en').home.latestNews[0].title, news.title);
  for (const [translations, field] of [
    [{ fr: { title: 'Sample' } }, 'translations.fr'],
    [{ en: { id: 'different' } }, 'translations.en.id'],
    [{ ja: { title: String.fromCodePoint(0x202e) } }, 'translations.ja.title'],
    [{ en: { title: 'x'.repeat(401) } }, 'translations.en.title'],
  ]) {
    const next = { ...content, news: [{ ...news, translations }, ...content.news.slice(1)] };
    assert.ok(validateContent(next).some(error => error.includes(field)), field);
  }
});

test('private repository validation accepts legacy roadmaps and enforces the record contract', () => {
  const { content } = createFixtures(Date.now());
  const validate = list => validateContent({ ...content, roadmap: { ...content.roadmap, privateRepositories: list } });
  const first = content.roadmap.privateRepositories[0];
  for (const id of ['x', 'a-2', 'a'.repeat(48)]) assert.deepEqual(validate([{ ...first, id }]), []);
  assert.deepEqual(validate(undefined), []);
  assert.deepEqual(validate([]), []);
  for (const id of ['', '-a', 'a-', 'a--b', 'A', 'a_b', 'a/b', 'a\n', 'a'.repeat(49)]) {
    assert.ok(validate([{ ...first, id }]).some(detail => detail.includes('privateRepositories[1].id')), JSON.stringify(id));
  }
  for (const entry of [null, { ...first, title: ' ' }, { ...first, summary: '\u202e示例' }, { ...first, sourceLabel: '' },
    { ...first, sourceUrl: 'javascript:void(0)' }, { ...first, sourceUrl: '/not-an-anchor' },
    { ...first, portProgress: { gta: { loads: 2 } } }, { ...first, portProgress: undefined }, { ...first, github: {} }]) {
    assert.ok(validate([entry]).length > 0);
  }
  assert.ok(validate({}).length > 0);
  assert.ok(validate(Array.from({ length: 161 }, (_, index) => ({ ...first, id: `item-${index}` }))).length > 0);
  assert.ok(validate([first, first]).some(detail => detail.includes('privateRepositories[2].id')));
});

test('private records never trigger GitHub lookups and tie order matches the public archive', () => {
  const { content, metadata } = createFixtures(Date.now());
  const baseline = createDashboard({ initial: metadata }).get({ ...content, roadmap: {} });
  assert.deepEqual(baseline.privateRepositories, []);
  assert.equal(baseline.progress.score, 46);

  const tied = { ...content.roadmap.privateRepositories[0], portProgress: content.projects[0].portProgress };
  const result = createDashboard({ initial: metadata }).get({ ...content, roadmap: { privateRepositories: [tied] } });
  assert.deepEqual(result.progress.ranked.slice(0, 2).map(entry => entry.id), [baseline.progress.leaderId, `private-repo-${tied.id}`]);
  assert.deepEqual(result.stats, baseline.stats);

  let requests = 0;
  const standalone = createDashboard({ liveGitHub: true, fetchGitHub: async () => { requests++; return new Response(null, { status: 404 }); } })
    .get({ ...content, projects: [] });
  assert.equal(requests, 0);
  assert.equal(standalone.stats.total, 0);
  assert.equal(standalone.progress.rankedCount, 2);
  assert.equal(standalone.progress.leaderId, 'private-repo-sample-launch');
});
