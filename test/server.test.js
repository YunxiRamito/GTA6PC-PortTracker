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

async function listener(t, server, afterClose) {
  server.listen(0, loopback);
  await once(server, 'listening');
  t.after(async () => {
    await server.closeDanmaku?.();
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await afterClose?.();
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

function checkDemoPrivateRepositories(archive) {
  assert.deepEqual(archive.privateRepositories.map(project => project.id), ['private-repo-sample-launch', 'private-repo-sample-render']);
  for (const project of archive.privateRepositories) {
    assert.deepEqual(Object.keys(project).sort(), ['id', 'portProgress', 'sourceLabel', 'sourceUrl', 'summary', 'title']);
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

test('dashboard and RSS reads stay passive while the scheduler starts on listening', async t => {
  const { directory, cleanup } = await runtime();
  let starts = 0;
  let reads = 0;
  const dashboard = {
    start(readProjects) {
      starts++;
      assert.equal(typeof readProjects, 'function');
      assert.equal(readProjects().length, createFixtures(Date.now()).content.projects.length);
    },
    stop() {},
    get(content) {
      reads++;
      assert.equal(arguments.length, 1, 'routes must not pass a force option');
      assert.ok(content.projects.length);
      return { timeline: [] };
    },
  };
  const server = createSiteServer({ runtimeDir: directory, dashboard, traffic: {
    readSnapshot: async () => null,
    subscribe: () => () => {},
  } });
  assert.equal(starts, 0, 'the scheduler must wait until the server listens');
  const origin = await listener(t, server, cleanup);

  assert.equal(starts, 1);
  assert.equal((await send(origin, '/api/dashboard?force=1')).status, 200);
  assert.equal((await send(origin, '/rss.xml')).status, 200);
  assert.equal(reads, 2);
});

test('dashboard reads and legacy force options do not fetch before the background schedule', async () => {
  const now = () => Date.UTC(2026, 0, 15);
  const { content, metadata } = createFixtures(now());
  const dashboardContent = { ...content, projects: [{ ...content.projects[0], repo: 'fixture/background-runner' }] };
  let requests = 0;
  let markRequested;
  const requested = new Promise(resolve => { markRequested = resolve; });
  const dashboard = createDashboard({
    now,
    initial: metadata,
    liveGitHub: true,
    fetchGitHub: async () => {
      requests++;
      markRequested();
      return new Response(JSON.stringify({
        stargazers_count: 4, forks_count: 1, open_issues_count: 0, pushed_at: '2026-01-14T12:00:00Z',
      }), { headers: { 'content-type': 'application/json' } });
    },
  });

  try {
    dashboard.get(dashboardContent);
    dashboard.get(dashboardContent, { force: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 0);

    dashboard.start(() => dashboardContent.projects);
    await requested;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1, 'listening starts a single immediate refresh pass');

    dashboard.get(dashboardContent, { force: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1, 'dashboard reads cannot bypass the scheduler cadence');
  } finally {
    dashboard.stop();
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
