'use strict';

const { TYPES, STATUSES, projectPrivateRepositories } = require('./_content');
const { overall: portOverall } = require('../assets/port-score');
const { createProgressHistory } = require('./_progress-history');
const { createGitHubStats } = require('./_github-stats');

const repoKey = repo => repo.toLowerCase();
const DAY = 24 * 60 * 60_000;
const LIVE_TIMELINE_LIMIT = 100;
const newestFirst = (a, b) => Date.parse(b.date) - Date.parse(a.date);

function createDashboard({ fetchGitHub = fetch, now = Date.now, initial = new Map(), liveGitHub = false, token = '', progressHistoryPath = null, cachePath = null } = {}) {
  const githubStats = createGitHubStats({ fetchGitHub, now, initial, liveGitHub, token, cachePath });
  const progressHistory = progressHistoryPath ? createProgressHistory({ filePath: progressHistoryPath, now }) : null;
  let lastHistoryKey = '';
  let scheduler = null;
  let readProjects = null;

  function start(projects) {
    if (!liveGitHub || scheduler) return;
    readProjects = typeof projects === 'function' ? projects : () => projects;
    const schedule = () => {
      try { Promise.resolve(githubStats.schedule(readProjects() || [])).catch(() => {}); } catch { /* Keep serving cached stats. */ }
    };
    schedule();
    scheduler = setInterval(schedule, 60_000);
    scheduler.unref?.();
  }

  function stop() {
    if (scheduler) clearInterval(scheduler);
    scheduler = null;
    readProjects = null;
  }

  function get(content) {
    const byType = {}, byStatus = {};
    let totalStars = 0, activeWeek = 0;
    const sevenDaysAgo = now() - 7 * DAY;
    const projects = content.projects.map(p => {
      const gh = githubStats.get(p.repo);
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
    }));
    const currentLive = githubStats.getTimeline().filter(n => repos.has(repoKey(n.repo))).sort(newestFirst).slice(0, LIVE_TIMELINE_LIMIT);
    const timeline = [...editorial, ...currentLive].sort(newestFirst);

    // Port progress overall score
    const community = content.roadmap?.communityBuild;
    const communityBuild = community && {
      id: 'community-build', title: community.title, summary: community.summary,
      sourceLabel: community.sourceLabel, sourceUrl: community.sourceUrl,
      status: 'progress', portProgress: community.portProgress,
    };
    const privateRepositories = projectPrivateRepositories(content.roadmap);
    const portOv = portOverall([...projects, ...(communityBuild ? [communityBuild] : []), ...privateRepositories]);
    const portProgress = {
      score: portOv.score,
      leaderId: portOv.leader ? portOv.leader.project.id : null,
      leaderName: portOv.leader ? portOv.leader.project.title : null,
      leaderReached: portOv.leader ? portOv.leader.reached : null,
      leaderReachedLabel: portOv.leader ? portOv.leader.reachedLabel : null,
      top3avg: portOv.top3avg,
      furthestMilestone: portOv.furthestMilestone,
      rankedCount: portOv.rankedCount,
      bootsCount: portOv.bootsCount,
      ranked: portOv.ranked.map(r => ({ id: r.project.id, score: r.score, reached: r.reached, reachedLabel: r.reachedLabel })),
      history: progressHistory ? progressHistory.read() : [],
    };

    // Record history when score changes or first call each day
    if (progressHistory && portOv.rankedCount > 0) {
      const histKey = `${portOv.score}:${portOv.leader?.project.id ?? ''}`;
      if (histKey !== lastHistoryKey) {
        lastHistoryKey = histKey;
        progressHistory.record({
          leader: portOv.score,
          leaderId: portOv.leader ? portOv.leader.project.id : '',
          top3avg: portOv.top3avg,
          furthest: portOv.furthestMilestone,
          ranked: portOv.rankedCount,
        }).catch(() => {});
      }
    }

    const result = {
      ...githubStats.getStatus(content.projects),
      config: { hasToken: liveGitHub && Boolean(token), cacheMinutes: githubStats.cacheMinutes, liveTimeline: liveGitHub && Boolean(token) },
      types: TYPES, statuses: STATUSES, stats: { total: projects.length, totalStars, activeWeek, byType, byStatus },
      projects, privateRepositories, timeline, progress: portProgress,
      ...(communityBuild ? { communityBuild } : {}),
    };
    const external = content.roadmap?.externalProgress;
    if (external && typeof external === 'object' && !Array.isArray(external)) {
      result.externalProgress = {
        title: external.title,
        score: external.score,
        summary: external.summary,
        sourceLabel: external.sourceLabel,
        sourceUrl: external.sourceUrl,
      };
    }
    return result;
  }
  return { get, start, stop };
}

module.exports = { createDashboard };
