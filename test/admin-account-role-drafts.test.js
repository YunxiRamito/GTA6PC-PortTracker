'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const Router = require('../admin/router');

const filename = require.resolve('../admin/account.js');
const source = readFileSync(filename, 'utf8');
const event = { preventDefault() {} };
const flush = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.hidden = true;
    this.events = new Map();
  }
  get value() {
    return this.selectedValue ?? (this.tag === 'select' ? this.children.find(option => option.selected)?.value : '') ?? '';
  }
  set value(value) { this.selectedValue = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this.events.set(type, listener); }
  emit(type, data = event) { return this.events.get(type)?.(data); }
  setAttribute() {}
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
  reportValidity() { return true; }
}

async function mount() {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new Element(id));
    return nodes.get(id);
  };
  const fixtureAccount = (id, uid, role = 'user') => ({
    id, uid, role, username: id, nickname: id, email: null, avatar: null, needsPasswordChange: false,
  });
  const admin = fixtureAccount('fixture-admin', 1, 'owner');
  const first = fixtureAccount('fixture-first', 2);
  const second = fixtureAccount('fixture-second', 3);
  const otherAdmin = fixtureAccount('fixture-other-admin', 4, 'owner');
  const users = new Map([admin, first, second, otherAdmin].map(item => [item.id, item]));
  const session = { actor: admin, patchStatus: 200, logoutStatus: 200, confirm: () => false };
  const calls = [];
  const prompts = [];
  const redirects = [];
  const windows = new Map();
  const modules = new Map();
  const window = {
    AdminRouter: Router,
    AdminShell: { register(name, hooks) { modules.set(name, hooks); }, confirmLeave: () => true },
    AdminAvatar: { create: () => ({ value: '', setValue(value) { this.value = value; } }) },
    matchMedia: () => ({ matches: true }),
    confirm(message) { prompts.push(message); return session.confirm(); },
    location: { hash: '', replace(path) { redirects.push(path); } },
    addEventListener(type, listener) { windows.set(type, [...(windows.get(type) ?? []), listener]); },
  };
  const accounts = '/api/admin/accounts';
  function json(data, status = 200) { return { ok: status < 300, status, json: async () => data }; }
  async function fetch(url, { method, body }) {
    const payload = body === undefined ? undefined : JSON.parse(body);
    calls.push({ url, method, payload });
    if (url === '/api/admin/session') {
      if (method === 'GET') return json({ authenticated: Boolean(session.actor), account: session.actor });
      assert.equal(method, 'DELETE');
      if (session.logoutStatus === 200) session.actor = null;
      return json({}, session.logoutStatus);
    }
    if (url === '/api/admin/account/profile' && method === 'GET') return json({ account: session.actor });
    if (url === accounts && method === 'GET') {
      return json({ accounts: (session.listOverride ?? [...users.values()]).map(value => ({ ...value })) });
    }
    if (url === accounts && method === 'POST') {
      const created = fixtureAccount(payload.username, users.size + 1, payload.role);
      users.set(created.id, created);
      return json({ account: created }, 201);
    }
    if (url.startsWith(`${accounts}/`)) {
      const target = users.get(url.slice(accounts.length + 1));
      assert.ok(target);
      if (method === 'PATCH') {
        if (session.patchStatus !== 200) return json({ error: 'fixture failure' }, session.patchStatus);
        target.role = payload.role;
        return json({ account: target });
      }
      assert.equal(method, 'DELETE');
      assert.equal(payload.confirmUsername, target.username);
      users.delete(target.id);
      return json({ deleted: true, uid: target.uid });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }
  runInNewContext(source, { window, document: { getElementById: get, createElement: tag => new Element(tag) }, fetch }, { filename });
  await window.AdminAccount.ready;
  const hooks = modules.get('accounts');
  const enter = part => hooks.enter(Router.routeFor(`/account/${part}`));
  const lookup = id => get('accounts-list').children.find(row => row.children[0]?.children[0]?.textContent === id);
  function row(id) {
    const found = lookup(id);
    assert.ok(found, `Missing account row: ${id}`);
    const [, role, status, actions] = found.children;
    return { select: role.children[0], status: status.children[0], form: actions.children[0],
      save: actions.children[0].children[0], remove: actions.children[2] };
  }
  function choose(id, value) {
    const { select } = row(id);
    assert.notEqual(select.disabled, true);
    select.value = value;
    select.emit('change');
  }
  function unloadWarns() {
    let warned = false;
    for (const listener of windows.get('beforeunload')) listener({ preventDefault() { warned = true; } });
    return warned;
  }
  enter('accounts');
  await flush();
  return { get, enter, lookup, row, choose, hooks, unloadWarns, session, users, first, second, otherAdmin, calls, prompts, redirects,
    logout: window.AdminAccount.logout, patches: () => calls.filter(call => call.method === 'PATCH') };
}

test('keeps role drafts by ID through search, account creation, and other rows saving or being deleted', async () => {
  const f = await mount();
  const a = f.first.id;
  const b = f.second.id;
  f.choose(a, 'moderator');
  f.choose(b, 'admin');
  assert.equal(f.hooks.dirty(), '账号角色');
  assert.equal(f.unloadWarns(), true);
  const search = f.get('accounts-search');
  search.value = b;
  search.emit('input');
  assert.equal(f.lookup(a), undefined);
  assert.equal(f.row(b).select.value, 'admin');
  search.value = '';
  search.emit('input');
  assert.equal(f.row(a).select.value, 'moderator');

  f.enter('create');
  f.get('create-account-username').value = 'fixture-created';
  f.get('create-account-password').value = 'Fixture123';
  f.get('create-account-role').value = 'user';
  await f.get('create-account-form').emit('submit');
  f.enter('accounts');
  await flush();
  assert.ok(f.lookup('fixture-created'));
  assert.equal(f.row(a).select.value, 'moderator');
  assert.equal(f.row(b).select.value, 'admin');

  await f.row(b).form.emit('submit');
  assert.equal(f.second.role, 'admin');
  assert.equal(f.row(b).save.disabled, true);
  assert.equal(f.row(a).save.disabled, false);
  f.choose('fixture-created', 'moderator');
  f.row(a).remove.emit('click');
  f.get('account-dialog-confirm').value = a;
  await f.get('account-dialog-confirm-action').emit('click');
  assert.equal(f.lookup(a), undefined);
  assert.equal(f.row('fixture-created').select.value, 'moderator');
  f.choose('fixture-created', 'user');
  assert.equal(f.hooks.dirty(), '');
  assert.equal(f.unloadWarns(), false);
});

test('a remote role matching the draft is still pending until explicitly discarded, with no PATCH', async () => {
  const f = await mount();
  const id = f.first.id;
  f.choose(id, 'moderator');
  f.first.role = 'moderator';
  await f.get('accounts-reload').emit('click');
  assert.match(f.row(id).status.textContent, /未保存/);
  assert.equal(f.row(id).save.disabled, false);
  await f.row(id).form.emit('submit');
  assert.match(f.prompts[0], /不会再次写入/);
  assert.equal(f.row(id).save.disabled, false);
  assert.deepEqual(f.patches(), []);
  f.session.confirm = () => true;
  await f.row(id).form.emit('submit');
  assert.equal(f.row(id).save.disabled, true);
  assert.equal(f.hooks.dirty(), '');
  assert.deepEqual(f.patches(), []);
});

test('preflights a conflicting role without a manual refresh and rechecks after confirmation', async () => {
  const f = await mount();
  const id = f.first.id;
  f.choose(id, 'moderator');
  f.first.role = 'admin';
  await f.row(id).form.emit('submit');
  assert.match(f.prompts[0], /普通管理员.*弹幕风纪委员/);
  assert.equal(f.row(id).select.value, 'moderator');
  assert.deepEqual(f.patches(), []);

  f.session.confirm = () => { f.first.role = 'owner'; return true; };
  await f.row(id).form.emit('submit');
  assert.match(f.get('accounts-status').textContent, /又有变化/);
  assert.equal(f.row(id).select.value, 'moderator');
  assert.deepEqual(f.patches(), []);

  f.session.confirm = () => true;
  await f.row(id).form.emit('submit');
  assert.equal(f.first.role, 'moderator');
  assert.equal(f.row(id).save.disabled, true);
  assert.deepEqual(f.patches(), [{ url: `/api/admin/accounts/${id}`, method: 'PATCH', payload: { role: 'moderator' } }]);
});

test('failed saves and failed logout retain drafts, but a different signed-in account cannot submit them', async () => {
  const f = await mount();
  const id = f.first.id;
  f.choose(id, 'moderator');
  f.session.patchStatus = 503;
  await f.row(id).form.emit('submit');
  assert.match(f.get('accounts-status').textContent, /fixture failure/);
  assert.equal(f.row(id).select.value, 'moderator');
  f.session.logoutStatus = 503;
  await f.logout();
  assert.deepEqual(f.redirects, []);
  assert.equal(f.hooks.dirty(), '账号角色');

  f.session.patchStatus = 200;
  f.session.actor = f.otherAdmin;
  await f.row(id).form.emit('submit');
  assert.equal(f.first.role, 'user');
  assert.equal(f.patches().length, 1, 'only the earlier, failed PATCH is sent');
  assert.equal(f.hooks.dirty(), '');
  assert.equal(f.row(id).select.value, 'user');
  assert.deepEqual(f.redirects, ['/admin/login']);
});

test('an incomplete list does not erase drafts; a verified deletion only erases its own draft', async () => {
  const f = await mount();
  const a = f.first.id;
  const b = f.second.id;
  f.choose(a, 'moderator');
  f.choose(b, 'admin');
  f.session.listOverride = [];
  await f.get('accounts-reload').emit('click');
  assert.match(f.get('accounts-status').textContent, /草稿仍保留/);
  assert.equal(f.row(a).select.value, 'moderator');
  assert.equal(f.row(b).select.value, 'admin');

  delete f.session.listOverride;
  f.users.delete(a);
  await f.get('accounts-reload').emit('click');
  assert.equal(f.lookup(a), undefined);
  assert.equal(f.row(b).select.value, 'admin');
  f.choose(b, 'user');
  assert.equal(f.hooks.dirty(), '');
});

test('successful logout discards role drafts', async () => {
  const f = await mount();
  f.choose(f.first.id, 'moderator');
  await f.logout();
  assert.equal(f.hooks.dirty(), '');
  assert.deepEqual(f.redirects, ['/admin/login']);
  assert.deepEqual(f.patches(), []);
});
