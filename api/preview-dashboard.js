'use strict';

const { TYPES, STATUSES } = require('./_content');
const { overall: portOverall } = require('../assets/port-score');
const DAY = 24 * 60 * 60 * 1000;
const repoKey = repo => repo.toLowerCase();
const newestFirst = (a, b) => Date.parse(b.date) - Date.parse(a.date);

function projectDashboard(content, { metadata, generatedAt, history }) {
  const byType = {}, byStatus = {};
  let totalStars = 0, activeWeek = 0;
  const sevenDaysAgo = Date.parse(generatedAt) - 7 * DAY;
  const projects = content.projects.map(p => {
    const gh = metadata.get(repoKey(p.repo));
    const github = gh ? { stars: gh.stars, forks: gh.forks, openIssues: gh.openIssues, pushedAt: gh.pushedAt } : null;
    totalStars += github?.stars || 0;
    if (github?.pushedAt && Date.parse(github.pushedAt) >= sevenDaysAgo) activeWeek++;
    byType[p.type] = (byType[p.type] || 0) + 1;
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    return {
      ...p, id: p.repo.replace('/', '__'),
      typeLabel: TYPES[p.type].label, statusLabel: STATUSES[p.status].label, statusColor: STATUSES[p.status].color,
      daysSincePush: github?.pushedAt ? Math.max(0, Math.floor((Date.parse(generatedAt) - Date.parse(github.pushedAt)) / DAY)) : null, github,
    };
  });
  const editorial = content.news.map(n => ({
    id: n.id, correction: n.correction === true, repo: n.repo || '', date: n.date, title: n.title, kind: 'milestone',
    url: n.sourceUrl || '',
  }));
  const timeline = [...editorial].sort(newestFirst);

  // Port progress overall score
  const community = content.roadmap?.communityBuild;
  const communityBuild = community && {
    id: 'community-build', title: community.title, summary: community.summary,
    sourceLabel: community.sourceLabel, sourceUrl: community.sourceUrl,
    status: 'progress', portProgress: community.portProgress,
  };
  const portOv = portOverall(communityBuild ? [...projects, communityBuild] : projects);
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
    history,
  };

  return {
    generatedAt, stale: false, rateLimited: false, refreshing: false,
    types: TYPES, statuses: STATUSES, stats: { total: projects.length, totalStars, activeWeek, byType, byStatus },
    projects, timeline, progress: portProgress,
  };
}

module.exports = { projectDashboard };
