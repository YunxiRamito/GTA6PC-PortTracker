'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const { test } = require('node:test');
const { PUBLIC_ASSETS } = require('../site-assets');

const source = file => readFileSync(path.resolve(__dirname, '..', file), 'utf8');

test('public templates load their dictionaries and optional history translator in order', () => {
  const words = new Map();
  const register = dictionary => {
    for (const [key, pair] of Object.entries(dictionary)) {
      assert.ok(!words.has(key), key);
      assert.ok(Array.isArray(pair) && pair.length === 2 && pair.every(value => typeof value === 'string' && value.trim()), key);
      words.set(key, pair);
    }
  };
  for (const file of ['i18n-pages.js', 'i18n-home.js', 'i18n-hardware-check.js', 'i18n-widgets.js']) {
    runInNewContext(source('assets/' + file), { window: { SiteI18n: { register, apply() {} } } });
  }
  for (const page of ['index.html', 'about.html', 'feedback.html', 'thanks.html', 'hardware-check.html']) {
    const html = source(page);
    const scripts = [...html.matchAll(/<script defer src="([^"]+)"/g)].map(([, href]) => href);
    const hardware = page === 'hardware-check.html';
    const locales = ['/assets/i18n.js', '/assets/i18n-pages.js',
      ...(page === 'index.html' ? ['/assets/i18n-home.js'] : []),
      ...(hardware ? ['/assets/i18n-hardware-check.js'] : []), '/assets/i18n-widgets.js'];
    assert.deepEqual(scripts.slice(0, locales.length), locales, page);
    if (hardware) {
      assert.ok(!scripts.includes('/assets/danmaku.js'));
      assert.equal(scripts.at(-1), '/assets/hardware-check.js');
    } else {
      assert.equal(scripts[scripts.indexOf('/assets/danmaku.js') + 1], '/assets/danmaku-translate.js', page);
    }
    for (const [, href] of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="(\/(?!\/)[^"]+)"/g)) {
      if (href !== '/rss.xml') assert.ok(PUBLIC_ASSETS.has(href), href);
    }
    for (const [, key] of html.matchAll(/\bdata-i18n(?:-[\w-]+)?="([\w.]+)"/g)) assert.ok(words.has(key), key);
  }
  for (const page of ['admin/index.html', 'admin/login.html', 'admin/feedback.html', 'admin/sponsors.html']) {
    assert.doesNotMatch(source(page), /\/assets\/(?:i18n|danmaku-translate)\./, page);
  }
  assert.match(source('assets/ui/fluent.svg'), /^<svg\b[^]*<symbol id="translate"[^]*<\/svg>\s*$/);
});

test('language choice applies to local public links and leaves external, fragment, and admin links intact', () => {
  const document = { documentElement: {}, querySelector: () => null };
  const saved = new Map([['port-tracker:locale', 'en']]);
  const window = {
    location: { href: 'http://127.0.0.1:8787/about.html?lang=ja#scope' },
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
  };
  runInNewContext(source('assets/i18n.js'), { document, window, URL });
  const { locale, url } = window.SiteI18n;
  assert.equal(locale, 'ja');
  assert.equal(document.documentElement.lang, 'ja');
  assert.equal(saved.get('port-tracker:locale'), 'ja');
  assert.equal(url('/feedback.html#content'), '/feedback.html?lang=ja#content');
  assert.equal(url('/rss.xml'), '/rss.xml?lang=ja');
  assert.equal(url('/can-i-run/#hardwareTargets'), '/can-i-run/?lang=ja#hardwareTargets');
  assert.equal(url('/can-i-run'), '/can-i-run?lang=ja');
  assert.equal(url('/api/dashboard?force=1'), '/api/dashboard?force=1&lang=ja');
  for (const unmodified of ['#scope', '/admin/', '/api/admin/content', '/about/?lang=en', 'https://127.0.0.1:8788/about/']) {
    assert.equal(url(unmodified), unmodified);
  }
});

function historyFixture({ supported, fail = false }) {
  const makeNode = () => ({
    attrs: {}, handlers: {}, textContent: '', children: [],
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(event, fn) { this.handlers[event] = fn; },
    append(...children) { this.children.push(...children); },
  });
  const history = makeNode();
  const classes = new Set();
  history.classList = { add: value => classes.add(value), remove: value => classes.delete(value) };
  history.dataset = { open: 'true' };
  const list = makeNode();
  const original = makeNode();
  original.textContent = '你好';
  original.after = next => { original.nextElementSibling = { ...next, classList: { contains: value => next.className === value } }; };
  list.before = controls => { list.controls = controls; };
  list.querySelectorAll = () => [original];
  list.contains = node => node === original;
  const document = { querySelector: selector => selector === '#danmakuHistory' ? history : list, createElement: makeNode };
  const calls = [];
  const window = { isSecureContext: supported, SiteI18n: { locale: 'ja' } };
  if (supported) {
    window.LanguageDetector = { async create() {
      calls.push('detect');
      return { detect: async () => [{ detectedLanguage: 'zh', confidence: 1 }] };
    } };
    window.Translator = { async create({ sourceLanguage, targetLanguage }) {
      calls.push([sourceLanguage, targetLanguage]);
      if (fail) throw new Error('Unavailable model');
      return { translate: async () => 'こんにちは' };
    } };
  }
  const context = { document, window, AbortController, MutationObserver: class { observe() {} } };
  runInNewContext(source('assets/danmaku-translate.js'), context);
  return { button: list.controls.children[0], status: list.controls.children[1], original, classes, calls };
}

test('browser translation starts only on opt-in and adds text alongside the original', async () => {
  const capture = historyFixture({ supported: true });
  const { button, original, classes, calls } = capture;
  assert.equal(button.attrs['aria-pressed'], 'false');
  assert.deepEqual(calls, []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.disabled, false);
  assert.deepEqual(calls, []);
  button.handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.attrs['aria-pressed'], 'true');
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === 'zh' && call[1] === 'ja'));
  assert.equal(original.textContent, '你好');
  assert.equal(original.nextElementSibling.children[1].textContent, 'こんにちは');
  assert.equal(original.nextElementSibling.children[1].lang, 'ja');
  assert.ok(classes.has('has-auto-translation'));
  button.handlers.click();
  assert.equal(button.attrs['aria-pressed'], 'false');
  assert.equal(classes.size, 0);
});

test('unsupported browsers and unavailable translation models keep the original readable', async () => {
  const unsupported = historyFixture({ supported: false });
  assert.equal(unsupported.button.disabled, true);
  assert.equal(unsupported.original.textContent, '你好');
  const failed = historyFixture({ supported: true, fail: true });
  await new Promise(resolve => setImmediate(resolve));
  failed.button.handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed.button.attrs['aria-pressed'], 'false');
  assert.match(failed.status.textContent, /利用できません/);
  assert.equal(failed.original.textContent, '你好');
  assert.equal(failed.original.nextElementSibling, undefined);
});


test('V5 benchmark display distinguishes measurements, estimates, zero and missing data in all public languages', () => {
  const vm = require('node:vm');
  const dictionaries = {};
  const context = { module: { exports: {} }, window: { SiteI18n: { register: words => Object.assign(dictionaries, words), apply() {} } } };
  vm.createContext(context);
  vm.runInContext(source('assets/site-content.js'), context);
  vm.runInContext(source('assets/i18n-home.js'), context);
  const format = context.formatV5Benchmark;
  for (const [locale, index, measured, estimate] of [
    ['zh-CN', null, '实测', '参考机估算'], ['en', 0, 'measured', 'normalized estimate'], ['ja', 1, '実測', '推定値'],
  ]) {
    const t = (key, fallback, params) => (index === null ? fallback : dictionaries[key][index]).replace(/\{(\w+)\}/g, (_, name) => params[name]);
    const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    assert.ok(format({ benchmarkFps: 60, benchmarkFpsMethod: 'direct', benchmarkFpsUpper: null }, number, t).includes(measured));
    const estimated = format({ benchmarkFps: 0, benchmarkFpsMethod: 'normalized', benchmarkFpsUpper: 60 }, number, t);
    assert.ok(estimated.includes('0–60 FPS') && estimated.includes(estimate) && !estimated.includes(measured));
    assert.equal(format({ benchmarkFps: 60, benchmarkFpsMethod: 'normalized' }, number, t), '');
    assert.equal(format({ benchmarkFps: null, benchmarkFpsMethod: null }, number, t), '');
    assert.ok(format({ benchmarkFps: 60 }, number, t).includes(measured));
  }
});
