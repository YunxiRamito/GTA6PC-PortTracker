'use strict';

const path = require('node:path');
const { TYPES, STATUSES, projectPrivateRepositories, projectMilestoneLabel } = require('./_content');
const { BUILD_TRANSLATION_FIELDS, NEWS_TRANSLATION_FIELDS, copyTranslations } = require('./_content-locale');
const { MODEL_VERSION, MILESTONES, FACTOR_WEIGHTS, QUALITY_WEIGHTS, FPS_CURVE, overall: portOverall } =
  require('../assets/port-score');
const { createProgressHistory, todayBeijing } = require('./_progress-history');

const repoKey = repo => repo.toLowerCase();
const DAY = 24 * 60 * 60_000;
const LIVE_TIMELINE_LIMIT = 100;
const newestFirst = (a, b) => Date.parse(b.date) - Date.parse(a.date);

function releaseTitle(tag) {
  const version = tag.trim();
  return '发布了新版本' + (version.length <= 30 && /^v?\d+(?:\.\d+){0,3}(?:[-+][\w.-]+)?$/i.test(version) ? ` · ${version}` : '');
}

function projectPortProgress(projects, history = []) {
  const { leader, score, top3avg, furthestMilestone, furthestMilestoneLabel, rankedCount, bootsCount, ranked } = portOverall(projects);
  return {
    modelVersion: MODEL_VERSION, milestones: MILESTONES, factorWeights: FACTOR_WEIGHTS, qualityWeights: QUALITY_WEIGHTS, fpsCurve: FPS_CURVE,
    score, leaderId: leader?.project.id ?? null, leaderName: leader?.project.title ?? null,
    leaderReached: leader?.reached ?? null, leaderReachedLabel: leader?.reachedLabel ?? null,
    top3avg, furthestMilestone, furthestMilestoneLabel, rankedCount, bootsCount,
    ranked: ranked.map(({ project, score, reached, reachedLabel, factors, qualityCap, benchmarkFps, benchmarkFpsMethod, benchmarkFpsUpper }) => ({
      id: project.id, score, reached, reachedLabel, factors, qualityCap, benchmarkFps, benchmarkFpsMethod, benchmarkFpsUpper,
    })),
    rank: Object.fromEntries(ranked.map(({ project }, index) => [project.id, index + 1])),
    history,
  };
}

function createDashboard({ fetchGitHub = fetch, now = Date.now, initial = new Map(), liveGitHub = false, token = '', progressHistoryPath = null } = {}) {
  const QUIET_MS = token ? 5 * 60_000 : 65 * 60_000;
  // Keep older series on disk untouched; scores from different models are not comparable.
  const historyPath = progressHistoryPath && path.parse(progressHistoryPath);
  const progressHistory = historyPath ? createProgressHistory({
    filePath: path.join(historyPath.dir, `${historyPath.name}.v${MODEL_VERSION}${historyPath.ext}`), now,
  }) : null;
  let lastHistoryKey = '';
  let metadata = new Map(initial);
  let live = [];
  let generatedAt = new Date(now()).toISOString();
  let stale = liveGitHub;
  let rate = { limit: 0, remaining: 0, reset: 0, authenticated: Boolean(token) };
  let nextRefresh = 0;
  let lastAttempt = -Infinity;
  let limitedUntil = 0;
  let pending = null;
  let warning = '';

  async function request(apiPath) {
    const headers = { 'User-Agent': 'gta6-pc-port-tracker', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchGitHub(`https://api.github.com${apiPath}`, { headers, signal: AbortSignal.timeout(7500) });
    const limit = Number(response.headers.get('x-ratelimit-limit'));
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const retryHeader = response.headers.get('retry-after');
    const retrySeconds = retryHeader !== null && /^\d+$/.test(retryHeader) ? Number(retryHeader) : 0;
    if (limit > 0) {
      // Parallel responses may arrive out of order; don't report the quota as restored.
      if (rate.reset !== reset || rate.limit !== limit) rate = { limit, remaining, reset, authenticated: Boolean(token) };
      else rate.remaining = Math.min(rate.remaining, remaining);
    }
    if (response.status === 429 || (response.status === 403 && (remaining === 0 || retrySeconds))) {
      limitedUntil = Math.max(reset || 0, now() + Math.max(120, retrySeconds) * 1000);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    return response.json();
  }

  function repoPath(project) { return '/repos/' + project.repo.split('/').map(encodeURIComponent).join('/'); }
  async function workers(items, task) {
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(items.length, 5) }, async () => {
      while (index < items.length && now() >= limitedUntil) {
        const item = items[index++];
        try { await task(item); } catch { /* Keep last known metadata for unavailable repos. */ }
      }
    }));
  }

  async function refresh(projects) {
    const fresh = new Map();
    const newLive = [];
    try {
      await workers(projects, async project => {
        const gh = await request(repoPath(project));
        if (!gh || typeof gh.stargazers_count !== 'number') return;
        fresh.set(repoKey(project.repo), {
          stars: gh.stargazers_count,
          forks: Number.isInteger(gh.forks_count) ? gh.forks_count : null,
          openIssues: Number.isInteger(gh.open_issues_count) ? gh.open_issues_count : null,
          pushedAt: typeof gh.pushed_at === 'string' ? gh.pushed_at : null,
        });
      });
      if (token) {
        const eligible = projects.filter(p => fresh.has(repoKey(p.repo)) && (p.type === 'runner' || p.type === 'tool'));
        await workers(eligible, async project => {
          const root = repoPath(project);
          const commits = await request(`${root}/commits?per_page=2`);
          for (const item of Array.isArray(commits) ? commits : []) {
            if (!item.commit?.author?.date) continue;
            const url = /^[a-f0-9]{7,40}$/i.test(item.sha || '') ? `https://github.com/${project.repo}/commit/${item.sha}` : `https://github.com/${project.repo}`;
            newLive.push({ repo: project.repo, date: item.commit.author.date, title: '项目更新了代码', kind: 'commit', url });
          }
          if (project.type === 'runner' && now() >= limitedUntil) {
            const releases = await request(`${root}/releases?per_page=1`);
            const item = Array.isArray(releases) ? releases[0] : null;
            if (item?.published_at) {
              const tag = typeof item.tag_name === 'string' ? item.tag_name.slice(0, 40) : '';
              newLive.push({ repo: project.repo, date: item.published_at, title: releaseTitle(tag), tag, kind: 'release', url: tag ? `https://github.com/${project.repo}/releases/tag/${encodeURIComponent(tag)}` : `https://github.com/${project.repo}/releases` });
            }
          }
        });
      }
      if (fresh.size) {
        for (const [key, entry] of fresh) metadata.set(key, entry);
        generatedAt = new Date(now()).toISOString();
      }
      if (newLive.length) live = newLive;
      stale = fresh.size !== projects.length;
      warning = limitedUntil > now() ? 'GitHub 请求已达到上限，部分数字使用上次保存的数据。'
        : stale ? '部分 GitHub 数字暂未更新；新闻和项目简介仍是站内当前版本。' : '';
    } finally {
      nextRefresh = Math.max(limitedUntil, now() + (stale && token ? 60_000 : QUIET_MS));
    }
  }

  function schedule(projects, force) {
    const time = now();
    if (!projects.length || pending || time < limitedUntil) return;
    const canForce = force && token && time - lastAttempt >= 60_000;
    if (!canForce && time < nextRefresh) return;
    lastAttempt = time;
    pending = refresh(projects).catch(() => {
      stale = true;
      warning = 'GitHub 数字暂未更新。';
    }).finally(() => { pending = null; });
  }

  function get(content, { force = false } = {}) {
    if (liveGitHub) schedule(content.projects, force);
    const byType = {}, byStatus = {};
    let totalStars = 0, activeWeek = 0;
    const sevenDaysAgo = now() - 7 * DAY;
    const projects = content.projects.map(p => {
      const gh = metadata.get(repoKey(p.repo));
      const github = gh ? { stars: gh.stars, forks: gh.forks, openIssues: gh.openIssues, pushedAt: gh.pushedAt } : null;
      totalStars += github?.stars || 0;
      if (github?.pushedAt && Date.parse(github.pushedAt) >= sevenDaysAgo) activeWeek++;
      byType[p.type] = (byType[p.type] || 0) + 1;
      byStatus[p.status] = (byStatus[p.status] || 0) + 1;
      return {
        ...p, id: p.repo.replace('/', '__'), url: p.repo.startsWith('demo-workshop/') ? '' : `https://github.com/${p.repo}`,
        typeLabel: TYPES[p.type].label, statusLabel: STATUSES[p.status].label, statusColor: STATUSES[p.status].color,
        daysSincePush: github?.pushedAt ? Math.max(0, Math.floor((now() - Date.parse(github.pushedAt)) / DAY)) : null, github,
      };
    });
    const repos = new Set(projects.map(p => repoKey(p.repo)));
    const editorial = content.news.map(n => ({
      id: n.id, correction: n.correction === true, repo: n.repo || '', date: n.date, title: n.title, kind: 'milestone',
      url: n.sourceUrl || (n.repo && !n.repo.startsWith('demo-workshop/') ? `https://github.com/${n.repo}` : ''),
      ...copyTranslations(n, NEWS_TRANSLATION_FIELDS),
    }));
    const currentLive = live.filter(n => repos.has(repoKey(n.repo))).sort(newestFirst).slice(0, LIVE_TIMELINE_LIMIT);
    const timeline = [...editorial, ...currentLive].sort(newestFirst);

    // Port progress overall score
    const community = content.roadmap?.communityBuild;
    const communityBuild = community && {
      id: 'community-build', title: community.title, summary: community.summary,
      sourceLabel: community.sourceLabel, sourceUrl: community.sourceUrl,
      status: 'progress', portProgress: community.portProgress, ...copyTranslations(community, BUILD_TRANSLATION_FIELDS),
    };
    const privateRepositories = projectPrivateRepositories(content.roadmap);
    const portProgress = projectPortProgress(
      [...projects, ...(communityBuild ? [communityBuild] : []), ...privateRepositories], progressHistory?.read());

    // Record the first sample of each Beijing day and refresh it when a tracked value changes.
    if (progressHistory && portProgress.rankedCount > 0) {
      const { score, leaderId, top3avg, furthestMilestone, rankedCount } = portProgress;
      const histKey = JSON.stringify([todayBeijing(now()), score, leaderId, top3avg, furthestMilestone, rankedCount]);
      if (histKey !== lastHistoryKey) {
        lastHistoryKey = histKey;
        progressHistory.record({ leader: score, leaderId, top3avg, furthest: furthestMilestone, ranked: rankedCount }).catch(() => {});
      }
    }

    const result = {
      generatedAt, stale: projects.length ? stale : false, rateLimited: limitedUntil > now(), rateLimit: rate,
      warning: projects.length ? warning : '', refreshing: Boolean(pending),
      config: { hasToken: liveGitHub && Boolean(token), cacheMinutes: QUIET_MS / 60_000, liveTimeline: liveGitHub && Boolean(token) },
      types: TYPES, statuses: STATUSES, stats: { total: projects.length, totalStars, activeWeek, byType, byStatus },
      projects: projects.map(projectMilestoneLabel), privateRepositories: privateRepositories.map(projectMilestoneLabel),
      timeline, progress: portProgress,
      ...(communityBuild ? { communityBuild: projectMilestoneLabel(communityBuild) } : {}),
    };
    const external = content.roadmap?.externalProgress;
    if (external && typeof external === 'object' && !Array.isArray(external)) {
      result.externalProgress = {
        title: external.title,
        score: external.score,
        summary: external.summary,
        sourceLabel: external.sourceLabel,
        sourceUrl: external.sourceUrl,
        ...copyTranslations(external, BUILD_TRANSLATION_FIELDS),
      };
    }
    return result;
  }
  return { get };
}

module.exports = { createDashboard, projectPortProgress };
