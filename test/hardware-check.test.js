'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const { createSiteServer } = require('../server');
const { createDemoServer } = require('../preview');
const demo = require('../fixtures/hardware-demo');

const root = path.resolve(__dirname, '..');
const keys = (object, expected) => assert.deepEqual(Object.keys(object).sort(), expected.split(' ').sort());

for (const mode of ['site', 'preview']) {
  test(`${mode} serves only the public hardware demo page, assets, and GET fixture`, async t => {
    let directory;
    if (mode === 'site') {
      const realRoot = await fs.realpath(root);
      const preview = path.join(realRoot, '.preview');
      await fs.mkdir(preview, { recursive: true });
      assert.equal(await fs.realpath(preview), preview);
      directory = await fs.mkdtemp(path.join(preview, 'hardware-route-'));
      const local = await fs.realpath(directory);
      assert.equal(path.dirname(local), preview);
      assert.match(path.basename(local), /^hardware-route-/);
      directory = local;
    }
    const server = mode === 'site' ? createSiteServer({ runtimeDir: directory, liveGitHub: false, githubToken: '' }) : createDemoServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    // One cleanup hook stops writes before removing the isolated runtime.
    t.after(async () => {
      await server.closeDanmaku?.();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    });
    const request = (url, options) => fetch(`http://127.0.0.1:${server.address().port}${url}`, { redirect: 'manual', ...options });
    const page = await request('/can-i-run/?lang=ja');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('set-cookie'), null);
    assert.match(page.headers.get('content-security-policy'), /; connect-src 'self';/);
    const html = await page.text();
    assert.match(html, /data-hardware-check/);
    assert.match(html, /用虚构硬件体验配置对照/);
    assert.ok(html.includes(`href="${demo.source}"`));
    assert.doesNotMatch(html, /data-port-view|public-navigation\.js|<audio|<form|<iframe/);
    assert.equal((await request('/can-i-run')).status, 200);
    assert.equal((await request('/can-i-run/', { method: 'HEAD' })).status, 200);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/(?:i18n-)?hardware-check\.(?:css|js)(?:\?[^\"]+)?)"/g)];
    assert.equal(assets.length, 3);
    for (const match of assets) {
      const response = await request(match[1]);
      assert.equal(response.status, 200, match[1]);
      assert.match(response.headers.get('content-type'), /(?:css|javascript)/);
    }
    assert.match(await (await request('/')).text(), /class="route-playability-hardware">\s*<a href="\/can-i-run\/"/);

    const response = await request('/api/hardware-check?lang=en');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-gtavi-hardware-data'), 'synthetic');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const data = await response.json();
    keys(data, 'source syncedAt stale gpus cpus targets storage');
    assert.deepEqual(data, demo);
    assert.equal(new Date(data.syncedAt).toISOString(), data.syncedAt);
    assert.equal(data.stale, false);
    for (const row of data.gpus) { keys(row, 'name score vramGb'); assert.match(row.name, /^Demo GPU /); }
    for (const row of data.cpus) { keys(row, 'name score'); assert.match(row.name, /^Demo CPU /); }
    for (const row of data.targets) { keys(row, 'id label gpuScore cpuScore ramGb vramGb'); assert.match(row.id, /^demo-/); }
    for (const row of data.storage) { keys(row, 'id label score'); assert.match(row.id, /^demo-/); }
    for (const method of ['POST', 'HEAD']) {
      const refused = await request('/api/hardware-check', { method });
      assert.equal(refused.status, 405);
      assert.equal(refused.headers.get('allow'), 'GET');
    }
    assert.equal((await request('/api/hardware-check', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    for (const blocked of ['/hardware-check.html', '/fixtures/hardware-demo.js', '/api/hardware-check.js', '/assets/hardware-check.json']) {
      assert.equal((await request(blocked)).status, 404, blocked);
    }
  });
}

test('hardware demo translates its runtime messages and every sample option', async () => {
  const source = file => fs.readFile(path.join(root, 'assets', file), 'utf8');
  const [ui, words] = await Promise.all(['hardware-check.js', 'i18n-hardware-check.js'].map(source));
  const dictionary = new Map();
  runInNewContext(words, { window: { SiteI18n: { register: entries => Object.entries(entries).forEach(([key, pair]) => dictionary.set(key, pair)), apply() {} } } });
  for (const [, key] of ui.matchAll(/\bt\('([\w.]+)'/g)) assert.ok(dictionary.has('pages.hardwareCheck.' + key), key);
  for (const row of [...demo.targets, ...demo.storage]) assert.ok(dictionary.has('pages.hardwareCheck.demo.' + row.id), row.id);
  assert.deepEqual(Array.from(dictionary.get('pages.hardwareCheck.resultNote')), [
    'Sample results compare fictional thresholds.', '結果は架空の設定の基準値と比較したものです。',
  ]);
});
