'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ANONYMOUS_BATCH = 18;
const ANONYMOUS_INTERVAL_MS = 25 * 60_000;
const AUTHENTICATED_INTERVAL_MS = 5 * 60_000;
const MAX_CACHE_BYTES = 1024 * 1024;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const DEMO_REPOSITORY = /^demo-workshop\//i;
const repoKey = repo => repo.toLowerCase();
const isRefreshableRepository = repo => REPOSITORY.test(repo) && !DEMO_REPOSITORY.test(repo);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const validCount = value => Number.isSafeInteger(value) && value >= 0;

function metrics(entry) {
  if (!entry || !validCount(entry.stars) || !validCount(entry.forks) || !validCount(entry.openIssues) ||
      (entry.pushedAt !== null && !validDate(entry.pushedAt))) return undefined;
  const { stars, forks, openIssues, pushedAt } = entry;
  return { stars, forks, openIssues, pushedAt };
}

function releaseTitle(tag) {
  const version = tag.trim();
  return '发布了新版本' + (version.length <= 30 && /^v?\d+(?:\.\d+){0,3}(?:[-+][\w.-]+)?$/i.test(version) ? ` · ${version}` : '');
}

function repoPath(project) {
  return '/repos/' + project.repo.split('/').map(encodeURIComponent).join('/');
}

function headerInteger(headers, name) {
  const value = headers.get(name);
  return value !== null && /^\d+$/.test(value) && validCount(Number(value)) ? Number(value) : null;
}

function createGitHubStats({
  fetchGitHub = fetch, now = Date.now, initial = new Map(), generatedAt = null,
  liveGitHub = true, token = '', cachePath = null,
} = {}) {
  const authenticated = Boolean(token);
  const refreshInterval = authenticated ? AUTHENTICATED_INTERVAL_MS : ANONYMOUS_INTERVAL_MS;
  const metadata = new Map(initial);
  const cachedMetadata = new Map();
  const attempts = new Map();
  let live = [];
  let nextRefresh = 0;
  let limitedUntil = 0;
  let pending = null;
  let rate = { limit: 0, remaining: 0, reset: 0, authenticated };
  const file = cachePath && path.resolve(cachePath);

  if (liveGitHub && file) {
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size <= MAX_CACHE_BYTES) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved?.version === 1 && validDate(saved.generatedAt)) {
          const newer = !validDate(generatedAt) || Date.parse(saved.generatedAt) >= Date.parse(generatedAt);
          for (const [key, entry] of Object.entries(saved.projects || {})) {
            const value = metrics(entry);
            if (isRefreshableRepository(key) && value) {
              const normalized = repoKey(key);
              cachedMetadata.set(normalized, value);
              if (newer || !metadata.has(normalized)) metadata.set(normalized, value);
            }
          }
          if (newer) generatedAt = saved.generatedAt;
        }
        if (saved?.version === 1) {
          for (const [key, entry] of Object.entries(saved.attempts || {})) {
            if (isRefreshableRepository(key) && validCount(entry?.at) && entry.at <= now() && typeof entry.ok === 'boolean') {
              attempts.set(repoKey(key), { at: entry.at, ok: entry.ok });
            }
          }
          if (saved.authenticated === authenticated) {
            if (validCount(saved.nextRefresh) && saved.nextRefresh <= now() + refreshInterval) nextRefresh = saved.nextRefresh;
            if (validCount(saved.limitedUntil) && saved.limitedUntil <= now() + 24 * 60 * 60_000) limitedUntil = saved.limitedUntil;
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Ignoring unreadable GitHub stats cache:', error.code || error.name);
    }
  }

  async function save(listed) {
    if (!file) return;
    const dir = path.dirname(file);
    const temporary = path.join(dir, `.github-stats-${randomUUID()}.tmp`);
    const select = map => Object.fromEntries([...listed.keys()].filter(key => map.has(key)).map(key => [key, map.get(key)]));
    try {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(temporary, JSON.stringify({
        version: 1, generatedAt, projects: select(cachedMetadata), attempts: select(attempts), authenticated, nextRefresh, limitedUntil,
      }) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.promises.rename(temporary, file);
    } catch (error) {
      await fs.promises.unlink(temporary).catch(() => {});
      console.warn('GitHub stats cache write failed:', error.code || error.name);
    }
  }

  async function request(apiPath) {
    const headers = { 'User-Agent': 'gta6-pc-port-tracker', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchGitHub(`https://api.github.com${apiPath}`, { headers, signal: AbortSignal.timeout(7500) });
    const time = now();
    const limit = headerInteger(response.headers, 'x-ratelimit-limit');
    const remaining = headerInteger(response.headers, 'x-ratelimit-remaining');
    const reset = (headerInteger(response.headers, 'x-ratelimit-reset') || 0) * 1000;
    const retrySeconds = headerInteger(response.headers, 'retry-after');
    const retryAt = retrySeconds !== null ? time + retrySeconds * 1000 : Date.parse(response.headers.get('retry-after'));
    if (limit > 0 && remaining !== null) rate = { limit, remaining, reset, authenticated };
    let throttled = response.status === 429 || (response.status === 403 && (remaining === 0 || retryAt > time));
    if (response.status === 403 && !throttled) {
      const payload = await response.json().catch(() => null);
      throttled = typeof payload?.message === 'string' && /rate limit|abuse detection/i.test(payload.message);
    }
    if (remaining === 0 || throttled) {
      // Also stop after a successful response that used the last available request.
      limitedUntil = Math.max(limitedUntil, retryAt > time ? retryAt : time + 60_000, remaining === 0 ? reset : 0);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    return response.json();
  }

  async function collectTimeline(sampled) {
    const next = [];
    for (const [, project] of sampled) {
      if (now() < limitedUntil) break;
      if (project.type !== 'runner' && project.type !== 'tool') continue;
      try {
        const root = repoPath(project);
        const commits = await request(`${root}/commits?per_page=2`);
        for (const item of Array.isArray(commits) ? commits : []) {
          if (!item.commit?.author?.date) continue;
          const url = /^[a-f0-9]{7,40}$/i.test(item.sha || '') ? `https://github.com/${project.repo}/commit/${item.sha}` : `https://github.com/${project.repo}`;
          next.push({ repo: project.repo, date: item.commit.author.date, title: '项目更新了代码', kind: 'commit', url });
        }
        if (project.type === 'runner' && now() >= limitedUntil) {
          const releases = await request(`${root}/releases?per_page=1`);
          const item = Array.isArray(releases) ? releases[0] : null;
          if (item?.published_at) {
            const tag = typeof item.tag_name === 'string' ? item.tag_name.slice(0, 40) : '';
            next.push({ repo: project.repo, date: item.published_at, title: releaseTitle(tag), tag, kind: 'release', url: tag ? `https://github.com/${project.repo}/releases/tag/${encodeURIComponent(tag)}` : `https://github.com/${project.repo}/releases` });
          }
        }
      } catch { /* Leave repository counters and previously collected events available. */ }
    }
    if (next.length) live = next;
  }

  async function refresh(listed) {
    // Persist the reserved refresh window before requesting GitHub, so a restart cannot spend it twice.
    await save(listed);
    const priority = key => (!metadata.has(key) && !attempts.has(key) ? -2 : attempts.get(key)?.at ?? -1);
    const sorted = [...listed].sort(([a], [b]) => priority(a) - priority(b));
    const queue = authenticated ? sorted : sorted.slice(0, ANONYMOUS_BATCH);
    const sampled = [];
    for (const [key, project] of queue) {
      if (now() < limitedUntil) break;
      let value;
      try {
        const raw = await request(repoPath(project));
        if (raw && raw.private !== true && (!raw.visibility || raw.visibility === 'public')) {
          value = metrics({ stars: raw.stargazers_count, forks: raw.forks_count, openIssues: raw.open_issues_count, pushedAt: raw.pushed_at });
        }
      } catch { /* Keep the last known counts on network errors and invalid responses. */ }
      const time = now();
      attempts.set(key, { at: time, ok: Boolean(value) });
      if (!value) continue;
      metadata.set(key, value);
      cachedMetadata.set(key, value);
      generatedAt = new Date(time).toISOString();
      sampled.push([key, project]);
    }
    await save(listed);
    if (authenticated && now() >= limitedUntil) {
      const before = limitedUntil;
      await collectTimeline(sampled);
      if (limitedUntil !== before) await save(listed);
    }
  }

  function schedule(projects) {
    const time = now();
    if (!liveGitHub || time < Math.max(nextRefresh, limitedUntil)) return pending || undefined;
    if (pending) return pending;
    const listed = new Map(projects.filter(p => isRefreshableRepository(p.repo)).map(p => [repoKey(p.repo), p]));
    if (!listed.size) return;
    nextRefresh = time + refreshInterval;
    pending = refresh(listed).finally(() => { pending = null; });
    return pending;
  }

  function getStatus(projects) {
    const time = now();
    const refreshable = projects.filter(p => isRefreshableRepository(p.repo));
    const rateLimited = liveGitHub && limitedUntil > time;
    const maxAge = authenticated ? 2 * refreshInterval : (Math.ceil(refreshable.length / ANONYMOUS_BATCH) + 1) * refreshInterval;
    const stale = liveGitHub && refreshable.some(p => {
      const entry = attempts.get(repoKey(p.repo));
      return !entry?.ok || time - entry.at > maxAge;
    });
    const warning = refreshable.length && rateLimited ? 'GitHub 请求已达到上限，部分数字使用上次保存的数据。'
      : stale && !pending ? '部分 GitHub 数字暂未更新；新闻和项目简介仍是站内当前版本。' : '';
    return { generatedAt, stale, rateLimited, rateLimit: { ...rate }, warning, refreshing: Boolean(pending) };
  }

  return { schedule, get: repo => metadata.get(repoKey(repo)), getStatus, getTimeline: () => live, cacheMinutes: refreshInterval / 60_000 };
}

module.exports = { createGitHubStats };
