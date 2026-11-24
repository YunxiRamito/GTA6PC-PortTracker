'use strict';

/* PortWatch VI provided the scoring methodology. See docs/provenance.md. */
(function exposeScore(root) {
  const milestones = [
    ['groundwork', '基础准备', 0],
    ['loads', '程序运行', 25],
    ['boots', '首帧画面', 40],
    ['menu', '主菜单', 55],
    ['ingame', '进入游戏', 70],
    ['fps30', '30 帧', 85],
    ['stable', '稳定游玩', 100],
  ];
  const groundworkParts = [
    ['loader', '加载器与系统库', 20],
    ['shaders', '着色器翻译', 28],
    ['graphics', '图形层', 32],
    ['proven', '其他游戏已验证', 20],
  ];
  const MILESTONES = Object.freeze(milestones.map(([key, label, at]) => Object.freeze({ key, label, at })));
  const GROUNDWORK = Object.freeze(groundworkParts.map(([key, label, points]) => Object.freeze({ key, label, weight: points / 100 })));
  const STABILITY = Object.freeze({ unknown: 0, constant: 0, often: 0.25, sometimes: 0.55, rarely: 0.8, stable: 1 });
  const stageIndex = new Map(MILESTONES.map(({ key }, index) => [key, index]));

  function unit(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(number, 1)) : 0;
  }

  function oneDecimal(value) {
    return Math.round(value * 10) / 10;
  }

  function scoreProject(project) {
    const setup = project?.portProgress?.groundwork;
    const observations = project?.portProgress?.gta;
    const groundworkFraction = GROUNDWORK.reduce((fraction, { key, weight }) => (
      fraction + unit(setup?.[key]) * weight
    ), 0);
    const stages = MILESTONES.slice(1, 5);
    const fractions = stages.map(({ key }) => unit(observations?.[key]));
    const incomplete = fractions.findIndex(fraction => fraction < 1);
    let rank;
    let points;

    if (incomplete >= 0) {
      const lower = incomplete === 0 ? 25 * groundworkFraction : stages[incomplete - 1].at;
      points = lower + fractions[incomplete] * (stages[incomplete].at - lower);
      rank = incomplete;
    } else {
      const speed = unit(Number(observations?.fps) / 30);
      const stability = Object.hasOwn(STABILITY, observations?.stability) ? STABILITY[observations.stability] : 0;
      points = 70 + 15 * speed + 15 * stability;
      rank = speed < 1 ? 4 : stability < 1 ? 5 : 6;
    }

    const { key: reached, label: reachedLabel } = MILESTONES[rank];
    return { score: oneDecimal(points), groundworkFraction, reached, reachedLabel };
  }

  function overall(projects) {
    const entries = Array.isArray(projects) ? projects : [];
    const ranked = entries.flatMap(project => project?.portProgress && project.status !== 'reference'
      ? [{ project, ...scoreProject(project) }]
      : []);
    // Array#sort preserves archive order for equal scores.
    ranked.sort((left, right) => right.score - left.score);
    const [leader = null] = ranked;
    const podium = ranked.slice(0, 3);
    const bestStage = ranked.reduce((best, row) => Math.max(best, stageIndex.get(row.reached)), 0);
    return {
      leader,
      score: leader?.score ?? 0,
      top3avg: podium.length === 0 ? 0 : oneDecimal(podium.reduce((sum, row) => sum + row.score, 0) / podium.length),
      furthestMilestone: MILESTONES[bestStage].key,
      rankedCount: ranked.length,
      bootsCount: ranked.filter(row => unit(row.project.portProgress.gta?.loads) === 1).length,
      ranked,
    };
  }

  const api = { MILESTONES, GROUNDWORK, STABILITY, scoreProject, overall };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PortScore = api;
})(globalThis);
