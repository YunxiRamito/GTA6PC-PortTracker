'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test, before, afterEach, after, mock } = require('node:test');

let createGitHubStats;
let realFetchGuard;
before(() => {
  realFetchGuard = mock.method(globalThis, 'fetch', async () => {
    throw new Error('GitHub stats tests require the injected fetch fixture');
  });
  ({ createGitHubStats } = require('../api/_github-stats'));
});
afterEach(() => {
  const realRequests = realFetchGuard.mock.callCount();
  realFetchGuard.mock.resetCalls();
  assert.equal(realRequests, 0, 'all requests must use the injected fetch fixture');
});
after(() => realFetchGuard?.mock.restore());

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 0, 15);
const ANON_INTERVAL = 25 * MINUTE;
const ANON_BATCH = 18;
const ANON_LIMIT = 60;
const COUNTS = { stars: 12, forks: 3, openIssues: 2, pushedAt: '2026-01-14T12:00:00Z' };
const ZERO_COUNTS = { ...COUNTS, stars: 0, forks: 0, openIssues: 0 };

function projectsNamed(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({ repo: `fixture/${prefix}-${index + 1}`, type: 'runner' }));
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function repoResponse(counts = COUNTS, headers) {
  return json({
    stargazers_count: counts.stars,
    forks_count: counts.forks,
    open_issues_count: counts.openIssues,
    pushed_at: counts.pushedAt,
  }, 200, headers);
}

function quotaHeaders(remaining, reset) {
  return {
    'x-ratelimit-limit': String(ANON_LIMIT),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(reset / 1000),
  };
}

function fakeGitHub(respond = () => repoResponse()) {
  let time = START;
  const calls = [];
  return {
    calls,
    advance(ms) { time += ms; },
    create(options = {}) {
      return createGitHubStats({
        ...options,
        now: () => time,
        fetchGitHub: async url => {
          const call = { path: new URL(url).pathname, at: time };
          calls.push(call);
          return respond(call);
        },
      });
    },
  };
}

async function temporaryCache(t) {
  const root = await fs.realpath(path.join(__dirname, '..'));
  const dir = await fs.mkdtemp(path.join(root, '.test-github-stats-'));
  t.after(async () => {
    const target = await fs.realpath(dir);
    assert.equal(path.dirname(target), root, 'cleanup target must stay inside the project');
    assert.match(path.basename(target), /^\.test-github-stats-/);
    await fs.rm(target, { recursive: true, force: true });
  });
  return path.join(dir, 'github-stats.json');
}

const repoPaths = projects => projects.map(({ repo }) => `/repos/${repo}`);

async function assertGated(stats, projects) {
  const pass = stats.schedule(projects);
  await pass;
  assert.equal(pass, undefined, 'a gated schedule must return undefined');
}

test('anonymous refreshes cap each 25-minute window at 18 and stay within 60 requests per hour', async () => {
  const projects = projectsNamed('listed', 72);
  const callsByHour = new Map();
  const github = fakeGitHub(({ at }) => {
    const hourStart = Math.floor(at / HOUR) * HOUR;
    const used = (callsByHour.get(hourStart) ?? 0) + 1;
    callsByHour.set(hourStart, used);
    const headers = quotaHeaders(Math.max(0, ANON_LIMIT - used), hourStart + HOUR);
    return used > ANON_LIMIT ? json({ message: 'API rate limit exceeded' }, 429, headers) : repoResponse(COUNTS, headers);
  });
  const stats = github.create();

  for (let batch = 0; batch < 4; batch++) {
    const previous = github.calls.length;
    if (batch > 0) {
      github.advance(ANON_INTERVAL - 1);
      await assertGated(stats, projects);
      assert.equal(github.calls.length, previous, 'a refresh attempt cannot bypass the anonymous interval');
      github.advance(1);
    }
    await stats.schedule(projects);
    assert.equal(github.calls.length - previous, ANON_BATCH);
  }

  assert.deepEqual([...callsByHour.values()], [54, 18]);
  assert.deepEqual(new Set(github.calls.map(call => call.path)), new Set(repoPaths(projects)));
  for (const { repo } of projects) assert.deepEqual(stats.get(repo), COUNTS, repo);
  assert.equal(stats.getStatus(projects).rateLimited, false);
  assert.deepEqual(stats.getTimeline(), []);
});

test('an in-flight pass blocks overlap and the interval runs from its start', async () => {
  const [firstProject, nextProject] = projectsNamed('slow', 2);
  let release, markStarted;
  const upstream = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const github = fakeGitHub(async () => {
    markStarted();
    await upstream;
    return repoResponse();
  });
  const stats = github.create();

  const firstPass = stats.schedule([firstProject]);
  try {
    assert.equal(typeof firstPass?.then, 'function');
    await Promise.race([started, firstPass]);
    assert.equal(github.calls.length, 1);
    assert.equal(stats.getStatus([firstProject]).refreshing, true);
    github.advance(ANON_INTERVAL);
    const overlap = stats.schedule([nextProject]);
    assert.ok(overlap === undefined || overlap === firstPass);
  } finally {
    release();
    await firstPass;
  }
  assert.equal(github.calls.length, 1);
  assert.equal(stats.getStatus([firstProject]).refreshing, false);

  await stats.schedule([nextProject]);
  assert.deepEqual(stats.get(nextProject.repo), COUNTS);
  assert.equal(github.calls.length, 2);
});

test('unchecked repositories without counts take priority and a 404 rotates across a restart', async t => {
  const cachePath = await temporaryCache(t);
  const cached = projectsNamed('cached', ANON_BATCH - 1);
  const unchecked = projectsNamed('unchecked', ANON_BATCH);
  const [newProject] = projectsNamed('new', 1);
  const missing = unchecked[0];
  const missingPath = `/repos/${missing.repo}`;
  const github = fakeGitHub(({ path }) => path === missingPath ? json({ message: 'Not Found' }, 404) : repoResponse());
  const options = { cachePath, initial: new Map(cached.map(({ repo }) => [repo, COUNTS])) };
  const first = github.create(options);
  const initialProjects = [...cached, ...unchecked];

  await first.schedule(initialProjects);
  assert.equal(github.calls.length, ANON_BATCH);
  assert.deepEqual(new Set(github.calls.map(call => call.path)), new Set(repoPaths(unchecked)));
  assert.equal(first.get(missing.repo), undefined);

  github.advance(ANON_INTERVAL - 1);
  const stats = github.create(options);
  const projects = [...unchecked, ...cached, newProject];
  await assertGated(stats, projects);
  assert.equal(github.calls.length, ANON_BATCH);

  github.advance(1);
  await stats.schedule(projects);
  const secondBatch = github.calls.slice(ANON_BATCH).map(call => call.path);
  assert.equal(secondBatch[0], `/repos/${newProject.repo}`);
  assert.deepEqual(new Set(secondBatch), new Set(repoPaths([newProject, ...cached])));
  assert.equal(secondBatch.length, ANON_BATCH);
  assert.deepEqual(stats.get(newProject.repo), COUNTS);

  github.advance(ANON_INTERVAL);
  await stats.schedule([...cached, newProject, ...unchecked]);
  const thirdBatch = github.calls.slice(2 * ANON_BATCH).map(call => call.path);
  assert.deepEqual(new Set(thirdBatch), new Set(repoPaths(unchecked)));
  assert.equal(thirdBatch.length, ANON_BATCH);
  assert.equal(stats.get(missing.repo), undefined);
});

test('a 200 with zero remaining saves its counts and its reset gate across a restart', async t => {
  const cachePath = await temporaryCache(t);
  const projects = projectsNamed('reset', 3);
  const reset = START + HOUR;
  const github = fakeGitHub(({ at }) => repoResponse(COUNTS, quotaHeaders(at < reset ? 0 : 59, at < reset ? reset : reset + HOUR)));
  const first = github.create({ cachePath });

  await first.schedule(projects);
  assert.equal(github.calls.length, 1);
  const firstRepo = github.calls[0].path.slice('/repos/'.length);
  assert.deepEqual(first.get(firstRepo), COUNTS);
  const { generatedAt, rateLimited, rateLimit } = first.getStatus(projects);
  assert.equal(generatedAt, new Date(START).toISOString());
  assert.equal(rateLimited, true);
  assert.equal(rateLimit.remaining, 0);

  github.advance(HOUR - 1);
  const stats = github.create({ cachePath });
  assert.deepEqual(stats.get(firstRepo), COUNTS);
  await assertGated(stats, projects);
  assert.equal(github.calls.length, 1);
  assert.equal(stats.getStatus(projects).rateLimited, true);

  github.advance(1);
  await stats.schedule(projects);
  for (const { repo } of projects) assert.deepEqual(stats.get(repo), COUNTS, repo);
  assert.equal(stats.getStatus(projects).rateLimited, false);
});

for (const [name, status, retryMinutes, primaryHeaders] of [
  ['a 429 waits for Retry-After when it exceeds the normal cadence', 429, 35, {}],
  ['a 429 with a short Retry-After still waits for the normal cadence', 429, 5, {}],
  ['a secondary 403 honors Retry-After with primary quota remaining', 403, 35, quotaHeaders(57, START + HOUR)],
]) {
  test(name, async t => {
    const cachePath = await temporaryCache(t);
    const projects = projectsNamed('retry', 2);
    const retryDelay = retryMinutes * MINUTE;
    const delay = Math.max(retryDelay, ANON_INTERVAL);
    const github = fakeGitHub(({ at }) => at < START + retryDelay
      ? json({ message: 'You have exceeded a secondary rate limit.' }, status, {
        ...primaryHeaders, 'retry-after': String(retryDelay / 1000),
      })
      : repoResponse());
    const first = github.create({ cachePath });

    await first.schedule(projects);
    assert.equal(github.calls.length, 1);
    assert.equal(first.getStatus(projects).rateLimited, true);
    for (const { repo } of projects) assert.equal(first.get(repo), undefined, repo);

    github.advance(retryDelay - 1);
    const restarted = github.create({ cachePath });
    assert.equal(restarted.getStatus(projects).rateLimited, true);
    await assertGated(restarted, projects);
    if (delay > retryDelay) {
      github.advance(delay - retryDelay);
      await assertGated(restarted, projects);
    }
    assert.equal(github.calls.length, 1);

    github.advance(1);
    await restarted.schedule(projects);
    for (const { repo } of projects) assert.deepEqual(restarted.get(repo), COUNTS, repo);
    assert.equal(restarted.getStatus(projects).rateLimited, false);
  });
}

test('persisted zeros survive recreation, HTTP failures, and malformed responses', async t => {
  const cachePath = await temporaryCache(t);
  const projects = projectsNamed('persist', 1);
  const [{ repo }] = projects;
  let respond = () => repoResponse(ZERO_COUNTS);
  const github = fakeGitHub(() => respond());
  const initial = new Map([[repo, COUNTS]]);
  const options = { cachePath, initial, generatedAt: new Date(START - HOUR).toISOString() };
  const first = github.create(options);

  await first.schedule(projects);
  assert.deepEqual(first.get(repo), ZERO_COUNTS);
  await fs.access(cachePath);

  const restarted = github.create(options);
  assert.deepEqual(restarted.get(repo), ZERO_COUNTS);
  assert.equal(restarted.getStatus(projects).generatedAt, new Date(START).toISOString());

  for (const [label, failure] of [
    ['HTTP 503', () => json({ stargazers_count: 99, forks_count: 99, open_issues_count: 99, pushed_at: COUNTS.pushedAt }, 503)],
    ['invalid JSON', () => new Response('{"stargazers_count":', { headers: { 'content-type': 'application/json' } })],
    ['string stars', () => repoResponse({ ...COUNTS, stars: '99' })],
    ['missing forks', () => repoResponse({ ...COUNTS, forks: undefined })],
    ['invalid open issues', () => repoResponse({ ...COUNTS, openIssues: null })],
    ['invalid pushed timestamp', () => repoResponse({ ...COUNTS, pushedAt: 'yesterday' })],
    ['non-ISO pushed timestamp', () => repoResponse({ ...COUNTS, pushedAt: 'Thu, 15 Jan 2026 00:00:00 GMT' })],
  ]) {
    const previous = github.calls.length;
    respond = failure;
    github.advance(ANON_INTERVAL);
    await restarted.schedule(projects);
    assert.equal(github.calls.length, previous + 1, `${label} fixture was not requested`);
    assert.deepEqual(restarted.get(repo), ZERO_COUNTS, label);
  }

  assert.deepEqual(github.create({ cachePath }).get(repo), ZERO_COUNTS);
});

test('reading an empty cache or stats due for refresh never calls upstream', async () => {
  const projects = projectsNamed('read-only', 1);
  const [{ repo }] = projects;
  const github = fakeGitHub();
  const stats = github.create();

  assert.equal(stats.get(repo), undefined);
  assert.equal(stats.getStatus(projects).refreshing, false);
  assert.deepEqual(stats.getTimeline(), []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(github.calls.length, 0);

  await stats.schedule(projects);
  assert.equal(github.calls.length, 1);
  github.advance(2 * HOUR);

  assert.deepEqual(stats.get(repo), COUNTS);
  assert.equal(stats.getStatus(projects).refreshing, false);
  assert.deepEqual(stats.getTimeline(), []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(github.calls.length, 1);
});

test('demo-workshop fixtures are never queried or persisted in the live cache', async t => {
  const cachePath = await temporaryCache(t);
  const demoRepo = 'demo-workshop/fixture-runner';
  const liveRepo = 'sample-owner/live-runner';
  const projects = [{ repo: demoRepo, type: 'runner' }, { repo: liveRepo, type: 'runner' }];
  const github = fakeGitHub();
  const stats = github.create({ cachePath, initial: new Map([[demoRepo, COUNTS]]) });

  assert.deepEqual(stats.get(demoRepo), COUNTS);
  await stats.schedule(projects);

  assert.deepEqual(github.calls.map(call => call.path), ['/repos/sample-owner/live-runner']);
  assert.deepEqual(stats.get(demoRepo), COUNTS);
  const saved = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  assert.deepEqual(Object.keys(saved.projects), [liveRepo.toLowerCase()]);
  assert.deepEqual(Object.keys(saved.attempts), [liveRepo.toLowerCase()]);
});

test('a corrupt cache falls back to the seed and can be replaced by a successful refresh', async t => {
  const cachePath = await temporaryCache(t);
  await fs.writeFile(cachePath, '{broken', 'utf8');
  const projects = projectsNamed('corrupt', 1);
  const [{ repo }] = projects;
  const updated = { ...ZERO_COUNTS, pushedAt: null };
  const github = fakeGitHub(() => repoResponse(updated));
  const stats = github.create({ cachePath, initial: new Map([[repo, COUNTS]]) });

  assert.deepEqual(stats.get(repo), COUNTS);
  await stats.schedule(projects);
  assert.deepEqual(github.create({ cachePath }).get(repo), updated);
});

test('disabled live mode serves the seed and ignores a refresh request', async () => {
  const projects = projectsNamed('offline', 1);
  const [{ repo }] = projects;
  const github = fakeGitHub();
  const stats = github.create({ liveGitHub: false, initial: new Map([[repo, COUNTS]]) });

  await assertGated(stats, projects);
  assert.equal(github.calls.length, 0);
  assert.deepEqual(stats.get(repo), COUNTS);
  assert.equal(stats.getStatus(projects).refreshing, false);
  assert.deepEqual(stats.getTimeline(), []);
});

test('disabled live mode does not load cached live metadata', async t => {
  const cachePath = await temporaryCache(t);
  const projects = projectsNamed('offline-cache', 1);
  const [{ repo }] = projects;
  const github = fakeGitHub();
  await github.create({ cachePath }).schedule(projects);
  const requests = github.calls.length;
  const disabled = github.create({ cachePath, liveGitHub: false });

  assert.equal(disabled.get(repo), undefined);
  await assertGated(disabled, projects);
  assert.equal(github.calls.length, requests);
});
