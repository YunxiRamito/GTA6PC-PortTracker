'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { createAdminAccounts } = require('../api/_admin-accounts');
const { createSiteServer } = require('../server');
const { createDemoServer } = require('../preview');

const workspace = path.resolve(__dirname, '..');
const loopback = '127.0.0.1';

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
  assert.equal(archive.progress.score, 46);
  assert.ok(archive.projects.every(project => project.repo.startsWith('demo-workshop/')));
  assert.equal((await send(origin, '/rss.xml')).status, 200);
  assert.equal((await send(origin, '/admin/')).headers.get('location'), '/admin/login');
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
  assert.equal((await send(origin, '/api/feedback', { method: 'POST', data: { text: 'sample' } })).status, 405);
  assert.equal((await send(origin, '/about/')).status, 200);
});
