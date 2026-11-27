'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const Router = require('../admin/router');

const filename = require.resolve('../admin/danmaku.js');
const source = readFileSync(filename, 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const fields = { settings: ['master-enabled', 'checked', 'change'], scheduled: ['scheduled-messages', 'value', 'input'] };
const original = { settings: true, scheduled: 'Saved rotation' };
const edited = { settings: false, scheduled: 'Draft rotation' };

async function mount() {
  const nodes = new Map();
  const get = name => {
    const id = `danmaku-${name}`;
    if (!nodes.has(id)) {
      const handlers = new Map();
      nodes.set(id, {
        value: '', hidden: false, disabled: false, dataset: {}, classList: { add() {}, remove() {} },
        get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
        addEventListener(type, listener) { handlers.set(type, listener); },
        emit(type) { return handlers.get(type)?.({ target: this, preventDefault() {} }); },
        querySelectorAll: () => [], setAttribute() {}, removeAttribute() {},
      });
    }
    return nodes.get(id);
  };
  const config = {
    settings: { enabled: true, active: true, schedule: { enabled: false, closeAt: '23:00', openAt: '07:00' },
      communityVoteThreshold: 6, rateLimit: { perMinute: 2, minIntervalSeconds: 5 } },
    scheduled: { enabled: true, intervalMinutes: 10, messages: ['Saved rotation'] },
  };
  let release;
  const saveGate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const confirmations = [];
  let hooks;
  let current;
  const window = {
    AdminAccount: { ready: Promise.resolve(), canModerate: true, canEdit: true },
    AdminShell: { register(name, registered) { assert.equal(name, 'danmaku'); hooks = registered; } },
    addEventListener() {}, removeEventListener() {},
    confirm(text) { confirmations.push(text); return false; },
  };
  await runInNewContext(source, {
    window, document: { getElementById: id => get(id.slice('danmaku-'.length)) },
    async fetch(url, { method, body }) {
      const part = url.split('/').at(-1);
      assert.ok(Object.hasOwn(config, part), url);
      calls.push(`${method} ${part}`);
      if (method === 'PUT') {
        await saveGate;
        const input = JSON.parse(body);
        config[part] = part === 'settings' ? { ...input, active: input.enabled } : input;
      }
      return { ok: true, json: async () => config[part] };
    },
  }, { filename });
  function enter(part) {
    const previous = current;
    current = Router.routeFor(`/danmaku/${part}`);
    assert.equal(typeof hooks.canEnter(current, previous), 'boolean');
    hooks.enter(current, { previous });
  }
  function edit(part) {
    const [field, prop, type] = fields[part];
    const control = get(field);
    assert.equal(control.disabled, false);
    control[prop] = edited[part];
    control.emit(type);
  }
  function value(part) {
    const [field, prop] = fields[part];
    return get(field)[prop];
  }
  return { get, enter, edit, value, release, calls, confirmations, dirty: part => hooks.dirty(`danmaku-${part}`),
    save: part => get(`${part}-form`).emit('submit') };
}

for (const [sourcePart, target] of [['settings', 'scheduled'], ['scheduled', 'settings']]) {
  test(`reads ${target} for the first time while ${sourcePart} is still saving`, async () => {
    const f = await mount();
    f.enter(sourcePart);
    await flush();
    f.edit(sourcePart);
    const saving = f.save(sourcePart);
    try {
      f.enter(target);
      await flush();
      assert.deepEqual(f.calls, [`GET ${sourcePart}`, `PUT ${sourcePart}`, `GET ${target}`]);
      assert.equal(f.value(target), original[target]);
      assert.equal(f.get(`${target}-reload`).disabled, false);
      assert.ok(f.dirty(sourcePart), 'the other GET does not mark the pending save as completed');
    } finally {
      f.release();
      await saving;
    }
    assert.equal(f.dirty(sourcePart), '');
  });

  test(`preserves an existing ${target} draft when switching during a ${sourcePart} save`, async () => {
    const f = await mount();
    f.enter(target);
    await flush();
    f.edit(target);
    f.enter(sourcePart);
    await flush();
    f.edit(sourcePart);
    const saving = f.save(sourcePart);
    try {
      f.enter(target);
      await flush();
      assert.deepEqual(f.calls, [`GET ${target}`, `GET ${sourcePart}`, `PUT ${sourcePart}`]);
      assert.equal(f.value(target), edited[target]);
      assert.ok(f.dirty(target));
      f.get(`${target}-reload`).emit('click');
      assert.equal(f.confirmations.length, 1, 'explicit reload still requires consent for a draft');
      assert.equal(f.calls.length, 3);
    } finally {
      f.release();
      await saving;
    }
    assert.equal(f.value(target), edited[target]);
    assert.ok(f.dirty(target));
  });
}
