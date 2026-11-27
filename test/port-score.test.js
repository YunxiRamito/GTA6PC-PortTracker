'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ps = require('../assets/port-score');
const legacyQuality = {
  evidence: { level: 'reproduced', sourceUrl: 'https://localhost/legacy-run', build: 'fixture-v4-build',
    setup: 'Synthetic test configuration', observedOn: '2026-01-12' },
  performance: { fps: 60, minutes: 10 },
  rendering: { scenes: 'complete', characters: 'complete', vehicles: 'complete' },
  stability: { sessions: [{ minutes: 30, outcome: 'clean' }] },
  completeness: { interaction: 'pass', mission: 'pass', saveReload: 'pass', progression: 'pass' },
};
const inGame = { loads: 1, boots: 1, menu: 1, ingame: 1 };
const inPrison = { ...inGame, prison: 1 };
const scoreWith = gta => ps.scoreProject({ portProgress: { gta: { ...inPrison, ...gta } } });
const scoreQuality = qualityV5 => scoreWith({ qualityV5 });
const unknownFactors = { performance: null, rendering: null, stability: null };
const prisonDefaults = { ...unknownFactors, stability: 50 };
const route = ['interior', 'corridor', 'yard'];
const nativeBenchmark = {
  profileId: 'steam-2026-10-v1', routeId: 'prison-v1', preset: 'series-x', width: 1920, height: 1080,
  dynamicResolution: false, upscaling: false, frameGeneration: false, dlss5: false,
};
const evidence = {
  level: 'reproduced', sourceUrl: 'https://localhost/v5-run', build: 'fixture-v5-build',
  setup: 'Steam reference PC, original 1080p', observedOn: '2026-11-25',
};
const benchmarkFor = (fps = 90, seconds = 100) => ({
  ...nativeBenchmark,
  segments: route.map(id => ({ id, runs: Array.from({ length: 3 }, () => ({ frames: Math.round(fps * seconds), seconds })) })),
});
const renderingFor = (...severities) => ({ segments: route.map((id, i) => ({ id, severity: severities[i] ?? 'clean' })) });
const stabilityFor = (entries = [[30], [30], [30]]) => ({
  sessions: entries.map(([minutes, outcome = 'clean', sourceUrl], i) =>
    ({ minutes, outcome, sourceUrl: sourceUrl ?? `https://localhost/reproduction/${i + 1}` })),
});
const qualityV5 = { evidence, benchmark: benchmarkFor(), rendering: renderingFor(), stability: stabilityFor() };

// ---- groundwork fraction ----
test('zero groundwork when field is absent', () => {
  const r = ps.scoreProject({});
  assert.equal(r.score, 0);
  assert.equal(r.reached, 'groundwork');
});

test('full groundwork gives 15 points without reaching the loads stage', () => {
  const r = ps.scoreProject({ portProgress: { groundwork: { loader: 1, shaders: 1, graphics: 1, proven: 1 }, gta: {} } });
  assert.equal(r.score, 15);
  assert.equal(r.reached, 'groundwork');
});

test('partial groundwork is weighted sum × 15', () => {
  const r = ps.scoreProject({ portProgress: { groundwork: { loader: 0.5, shaders: 1, graphics: 0.5, proven: 0 }, gta: {} } });
  assert.equal(r.score, 8.1);
});

// ---- ladder ----
test('loads=1 bumps score to 15 regardless of groundwork', () => {
  const r = ps.scoreProject({ portProgress: { groundwork: { loader: 0, shaders: 0, graphics: 0, proven: 0 }, gta: { loads: 1 } } });
  assert.equal(r.score, 15);
  assert.equal(r.reached, 'loads');
});

test('boots=0.5 interpolates between loads(15) and boots(30)', () => {
  const r = ps.scoreProject({ portProgress: { groundwork: { loader: 1, shaders: 1, graphics: 1, proven: 1 }, gta: { loads: 1, boots: 0.5 } } });
  assert.equal(r.score, 22.5);
  assert.equal(r.reached, 'loads');
});

test('ladder stops at the first partial step despite later complete inputs and quality', () => {
  const r = scoreWith({ menu: 0.5, qualityV5 });
  assert.equal(r.score, 32.5);
  assert.equal(r.reached, 'boots');
  assert.deepEqual(r.factors, unknownFactors);
  assert.equal(r.benchmarkFps, null);
});

test('all pre-prison steps reach ingame at 40', () => {
  const r = ps.scoreProject({ portProgress: { gta: inGame } });
  assert.equal(r.score, 40);
  assert.equal(r.reached, 'ingame');
  assert.equal(r.qualityCap, null);
});

test('Example ingame 0.8 scores 39 without completing the ingame milestone', () => {
  const r = ps.scoreProject({
    title: 'Example',
    portProgress: { gta: { loads: 1, boots: 1, menu: 1, ingame: 0.8, fps: 30, stability: 'stable' } },
  });
  assert.equal(r.score, 39);
  assert.equal(r.reached, 'menu');
});

test('prison interpolates from 40 to 50 and only numeric 1 unlocks quality', () => {
  for (const [prison, expected] of [[undefined, 40], [0, 40], [0.5, 45], [0.999, 50],
    [null, 40], [true, 40], ['1', 40], [Infinity, 40], [NaN, 40], [-1, 40], [1.01, 40]]) {
    const r = scoreWith({ prison, qualityV5 });
    assert.equal(r.score, expected, `prison: ${prison}`);
    assert.equal(r.reached, 'ingame');
    assert.equal(r.qualityCap, null);
    assert.equal(r.benchmarkFps, null);
    assert.deepEqual(r.factors, unknownFactors);
  }
  const complete = scoreWith({});
  assert.equal(complete.score, 50);
  assert.equal(complete.reached, 'prison');
  assert.equal(complete.reachedLabel, '进入监狱序章');
  assert.equal(complete.qualityCap, 50);
  assert.equal(complete.benchmarkFps, null);
  assert.deepEqual(complete.factors, prisonDefaults);
});

// ---- V5 rendering / fps / stability ----
test('V4 quality, older FPS/stability and completeness never fill missing V5 factors', () => {
  const legacy = { ...inGame, quality: legacyQuality, rendered: 1, fps: 60, stability: 'stable' };
  const early = ps.scoreProject({ portProgress: { gta: legacy } });
  assert.equal(early.score, 40);
  assert.equal(early.reached, 'ingame');
  assert.deepEqual(early.factors, unknownFactors);
  const atPrison = scoreWith(legacy);
  assert.equal(atPrison.score, 50);
  assert.equal(atPrison.reached, 'prison');
  assert.equal(atPrison.qualityCap, 50);
  assert.equal(atPrison.benchmarkFps, null);
  assert.deepEqual(atPrison.factors, prisonDefaults);
  const v5 = scoreWith({ ...legacy, qualityV5: { evidence, benchmark: nativeBenchmark, rendering: renderingFor() } });
  assert.equal(v5.score, 50);
  assert.deepEqual(v5.factors, { ...prisonDefaults, rendering: 100 });
});

test('FPS curve uses the V5 anchors, linear intervals and a 90 FPS score ceiling', () => {
  for (const [fps, score] of [[0, 0], [2.5, 5], [5, 10], [7.5, 17.5], [10, 25], [12.5, 30], [15, 35],
    [22.5, 47.5], [30, 60], [45, 70], [60, 80], [75, 90], [90, 100], [90.1, 100], [241, 100], [1000, 100]]) {
    assert.equal(ps.fpsScore(fps), score, `fps: ${fps}`);
  }
  for (const fps of [-1, 1000.01, NaN, Infinity, '90', null, undefined]) assert.equal(ps.fpsScore(fps), null);
});

test('V5 evidence cannot bypass the entry gate', () => {
  const r = scoreWith({ ingame: 0.8, qualityV5 });
  assert.equal(r.score, 39);
  assert.deepEqual(r.factors, unknownFactors);
  assert.equal(r.qualityCap, null);
  assert.equal(r.benchmarkFps, null);
});

test('a missing factor keeps overall at 50 but preserves each independently verified factor', () => {
  const renderingOnly = scoreQuality({ evidence, benchmark: nativeBenchmark, rendering: renderingFor() });
  assert.equal(renderingOnly.score, 50);
  assert.equal(renderingOnly.qualityCap, 50);
  assert.equal(renderingOnly.benchmarkFps, null);
  assert.deepEqual(renderingOnly.factors, { ...prisonDefaults, rendering: 100 });

  const fpsOnly = scoreQuality({ evidence, benchmark: benchmarkFor(60), stability: stabilityFor() });
  assert.equal(fpsOnly.score, 50);
  assert.equal(fpsOnly.qualityCap, 50);
  assert.equal(fpsOnly.benchmarkFps, 60);
  assert.deepEqual(fpsOnly.factors, { performance: 80, rendering: null, stability: 100 });
});

test('both quality factors require the exact profile, route, preset, native 1080p and four false switches', () => {
  for (const [key, value] of [['profileId', 'other-pc'], ['routeId', 'other-route'], ['preset', 'low'],
    ['width', 1280], ['height', 720], ['width', '1920'], ['dynamicResolution', true], ['upscaling', true],
    ['frameGeneration', true], ['dlss5', true], ['frameGeneration', 0], ['dlss5', 'false']]) {
    const r = scoreQuality({ ...qualityV5, benchmark: { ...qualityV5.benchmark, [key]: value } });
    assert.equal(r.score, 50, key);
    assert.equal(r.qualityCap, 50, key);
    assert.equal(r.benchmarkFps, null, key);
    assert.deepEqual(r.factors, { ...prisonDefaults, stability: 100 }, key);
  }
  const benchmark = benchmarkFor();
  delete benchmark.upscaling;
  for (const invalid of [undefined, null, [], benchmark, { ...qualityV5.benchmark, unspecified: true }]) {
    const r = scoreQuality({ ...qualityV5, benchmark: invalid });
    assert.deepEqual(r.factors, { ...prisonDefaults, stability: 100 });
    assert.equal(r.benchmarkFps, null);
  }
});

test('median FPS per segment discards isolated outliers, keeps repeated lows and weights by median elapsed time', () => {
  const segments = [
    { id: 'yard', runs: [{ frames: 492, seconds: 41 }, { frames: 6000, seconds: 100 }, { frames: 280, seconds: 20 }] },
    { id: 'interior', runs: [{ frames: 1200, seconds: 100 }, { frames: 1770, seconds: 30 }, { frames: 1220, seconds: 20 }] },
    { id: 'corridor', runs: [{ frames: 900, seconds: 30 }, { frames: 450, seconds: 10 }, { frames: 1200, seconds: 40 }] },
  ];
  const expected = (14 * 41 + 59 * 30 + 30 * 30) / (41 + 30 + 30);
  const original = structuredClone(segments);
  const r = scoreQuality({ evidence, benchmark: { ...nativeBenchmark, segments }, rendering: renderingFor() });
  assert.equal(r.benchmarkFps, expected);
  assert.equal(r.factors.performance, ps.fpsScore(expected));
  assert.equal(r.score, 82.7);
  assert.deepEqual(segments, original);
});

test('zero frames and inclusive duration/FPS endpoints are valid', () => {
  const stopped = scoreQuality({ evidence, benchmark: benchmarkFor(0, 10), rendering: renderingFor() });
  assert.equal(stopped.benchmarkFps, 0);
  assert.deepEqual(stopped.factors, { performance: 0, rendering: 100, stability: 50 });
  assert.equal(stopped.qualityCap, 100);
  assert.equal(stopped.score, 59.3);

  const fast = scoreQuality({ evidence, benchmark: benchmarkFor(1000, 600), rendering: renderingFor() });
  assert.equal(fast.benchmarkFps, 1000);
  assert.equal(fast.factors.performance, 100);
  assert.equal(fast.score, 97.5);
});

test('invalid performance runs reject the FPS aggregate, not independent rendering', () => {
  const validRuns = benchmarkFor().segments[0].runs;
  const invalidRuns = [undefined, null, [], validRuns.slice(1), [...validRuns, validRuns[0]],
    [validRuns[0], , validRuns[2]],
    ...[null, { frames: 12.5, seconds: 10 }, { frames: -1, seconds: 10 }, { frames: 10001, seconds: 10 },
      { frames: '100', seconds: 10 }, { frames: NaN, seconds: 10 }, { frames: 100, seconds: 9.99 },
      { frames: 100, seconds: 600.01 }, { frames: 100, seconds: '10' }, { frames: 100, seconds: Infinity },
      { frames: 100, seconds: 10, inferred: true }].map(bad => [validRuns[0], validRuns[1], bad]),
  ];
  for (const runs of invalidRuns) {
    const benchmark = benchmarkFor();
    benchmark.segments[0].runs = runs;
    const r = scoreQuality({ evidence, benchmark, rendering: renderingFor() });
    assert.equal(r.score, 50);
    assert.equal(r.qualityCap, 50);
    assert.equal(r.benchmarkFps, null);
    assert.deepEqual(r.factors, { ...prisonDefaults, rendering: 100 });
  }
});

test('each factor requires exactly one entry for every reference route segment', () => {
  const missingOrInvalid = segments => [null, {}, segments.slice(1), [...segments, segments[0]],
    [segments[0], , segments[2]], [segments[0], segments[0], segments[2]],
    [segments[0], { ...segments[1], id: 'elsewhere' }, segments[2]],
    [segments[0], { ...segments[1], id: ['corridor'] }, segments[2]],
  ];
  for (const segments of missingOrInvalid(qualityV5.benchmark.segments)) {
    const r = scoreQuality({ ...qualityV5, benchmark: { ...qualityV5.benchmark, segments } });
    assert.deepEqual(r.factors, { performance: null, rendering: 100, stability: 100 });
    assert.equal(r.score, 50);
    assert.equal(r.qualityCap, 50);
    assert.equal(r.benchmarkFps, null);
  }
  for (const segments of missingOrInvalid(qualityV5.rendering.segments)) {
    const r = scoreQuality({ ...qualityV5, rendering: { segments } });
    assert.deepEqual(r.factors, { performance: 100, rendering: null, stability: 100 });
    assert.equal(r.score, 50);
    assert.equal(r.qualityCap, 50);
    assert.equal(r.benchmarkFps, 90);
  }
});

test('rendering uses the lower of segment mean and the worst segment cap; the old overall cap of 70 is gone', () => {
  for (const [severities, score] of [
    [['critical', 'clean', 'clean'], 30], [['major', 'clean', 'clean'], 55], [['localized', 'clean', 'clean'], 85],
    [['minor', 'clean', 'clean'], 95], [['clean', 'clean', 'clean'], 100],
    [['critical', 'critical', 'critical'], 10], [['major', 'major', 'major'], 40], [['localized', 'localized', 'localized'], 70],
    [['minor', 'minor', 'minor'], 92], [['localized', 'clean', 'localized'], 80], [['minor', 'minor', 'clean'], 284 / 3],
  ]) {
    const rendering = renderingFor(...severities);
    rendering.segments.reverse();
    const r = scoreQuality({ ...qualityV5, rendering });
    assert.equal(r.factors.rendering, score, severities.join(','));
    assert.equal(r.qualityCap, 100);
  }
  const r = scoreQuality({ ...qualityV5, rendering: renderingFor('major') });
  assert.equal(r.score, 80.8);
});

test('unknown and invalid severities cannot stand in for verified rendering', () => {
  for (const severity of [undefined, 'unknown', 'constructor', 'partial', ['clean'], 0, null]) {
    const rendering = renderingFor();
    rendering.segments[0].severity = severity;
    const r = scoreQuality({ ...qualityV5, rendering });
    assert.equal(r.score, 50);
    assert.equal(r.qualityCap, 50);
    assert.equal(r.factors.rendering, null);
    assert.equal(r.benchmarkFps, 90);
  }
});

test('bottleneck dominates the four scenarios, favoring picture quality for equivalent shortfalls', () => {
  for (const [fps, severity, picture, performance, score] of [
    [15, 'critical', 30, 35, 66.1], [60, 'critical', 30, 80, 67.1],
    [15, 'minor', 95, 35, 72.3], [60, 'minor', 95, 80, 89.5],
    [12.5, 'minor', 95, 30, 70.4], [82.5, 'critical', 30, 95, 67.5],
  ]) {
    const r = scoreQuality({ evidence, benchmark: benchmarkFor(fps), rendering: renderingFor(severity) });
    assert.equal(r.benchmarkFps, fps);
    assert.deepEqual(r.factors, { performance, rendering: picture, stability: 50 });
    assert.equal(r.score, score, `${fps} FPS / ${severity}`);
  }
});

test('evidence caps the total but not verified individual factors', () => {
  for (const [level, score] of [['unverified', 50], ['self-reported', 75], ['demonstrated', 95], ['reproduced', 100]]) {
    const r = scoreQuality({ ...qualityV5, evidence: { ...evidence, level } });
    assert.equal(r.score, score);
    assert.equal(r.qualityCap, score);
    assert.equal(r.benchmarkFps, level === 'unverified' ? null : 90);
    assert.deepEqual(r.factors, level === 'unverified' ? prisonDefaults : { performance: 100, rendering: 100, stability: 100 });
    assert.equal(r.reached, level === 'reproduced' ? 'stable' : 'prison');
  }
});

test('malformed shared evidence fails closed for all three factors', () => {
  for (const [key, value] of [['level', 'constructor'], ['level', ['reproduced']], ['sourceUrl', 'https://'],
    ['sourceUrl', 'http://localhost/run'], ['sourceUrl', 'https://' + 'user:pass@localhost/run'], ['build', ' '],
    ['setup', 'PC\nsettings'], ['observedOn', '2026-02-30'], ['observedOn', '2026-11-25T00:00:00Z']]) {
    const r = scoreQuality({ ...qualityV5, evidence: { ...evidence, [key]: value } });
    assert.equal(r.score, 50, key);
    assert.equal(r.qualityCap, 50, key);
    assert.deepEqual(r.factors, prisonDefaults, key);
    assert.equal(r.benchmarkFps, null, key);
  }
  for (const missing of [undefined, null, [], {}]) {
    const r = scoreQuality({ ...qualityV5, evidence: missing });
    assert.deepEqual(r.factors, prisonDefaults);
    assert.equal(r.benchmarkFps, null);
  }
});

test('stability starts at 50, caps clean time per source and overall, and subtracts each crash/freeze/device loss', () => {
  const measure = entries => scoreQuality({ evidence, stability: stabilityFor(entries) }).factors.stability;
  assert.equal(measure([]), 50);
  assert.equal(measure([[1]]), 50 + 50 / 90);
  assert.equal(measure([[240]]), 50 + 50 * 30 / 90);
  assert.equal(measure([[30], [30], [30], [240]]), 100);
  for (const outcome of ['crash', 'freeze', 'device-loss']) {
    assert.equal(measure([[0, outcome]]), 25);
    assert.equal(measure([[240], [30], [240, outcome]]), 50 + 50 * 60 / 90 - 25);
  }
  assert.equal(measure([[0, 'crash'], [0, 'freeze'], [0, 'device-loss']]), 0);
  assert.equal(measure([[30], [30], [30], [0, 'crash'], [0, 'freeze'], [0, 'device-loss']]), 25);
  const r = scoreQuality({ ...qualityV5, stability: stabilityFor([[0, 'crash']]) });
  assert.equal(r.score, 96.3);
  assert.equal(r.reached, 'prison');
});

test('stability strips URL hashes and canonicalizes duplicates but keeps query strings', () => {
  const measure = entries => scoreQuality({ evidence, stability: stabilityFor(entries) }).factors.stability;
  const source = 'https://localhost/issue';
  assert.equal(measure([[30, 'clean', `${source}#a`], [1, 'crash', 'https://localhost:443/issue#b']]), 50);
  assert.equal(measure([[30, 'clean', source], [30, 'clean', source]]), 50);
  assert.equal(measure([[30, 'clean', `${source}?id=1#proof`], [30, 'clean', `${source}?id=2#proof`]]), 50 + 50 * 60 / 90);
});

test('invalid stability lists fall back to 50 without applying partially accepted reports', () => {
  const measure = stability => scoreQuality({ ...qualityV5, stability }).factors.stability;
  for (const record of [null, { minutes: 0.99, outcome: 'clean' }, { minutes: '20', outcome: 'clean' },
    { minutes: -1, outcome: 'crash' }, { minutes: Infinity, outcome: 'freeze' }, { minutes: 240.01, outcome: 'device-loss' },
    { minutes: 30, outcome: 'mission-blocked' }, { minutes: 30, outcome: 'crash', sourceUrl: 'javascript:invalid' }]) {
    const { sessions } = stabilityFor();
    const invalid = record && { sourceUrl: 'https://localhost/bad-report', ...record };
    assert.equal(measure({ sessions: [...sessions, invalid] }), 50);
  }
  const { sessions } = stabilityFor();
  for (const invalid of [undefined, null, {}, { sessions: new Array(2) }, { sessions: Array.from({ length: 7 }, (_, i) =>
    ({ minutes: 30, outcome: 'clean', sourceUrl: `https://localhost/report/${i}` })) },
  { sessions: [...sessions, { minutes: 20, outcome: 'clean' }] }]) assert.equal(measure(invalid), 50);
});

// ---- labels ----
test('milestone labels are NFC-normalized and allow 2–8 Han, Unicode letters or decimal digits', () => {
  for (const [label, normalized = label] of [['着色器完成'], ['到达30帧'], ['内存占用优化'], ['α٢'], ['〇四'],
    ['𠀀'.repeat(8)], ['Cafe\u0301', 'Café']]) {
    assert.equal(ps.normalizeMilestoneLabel(label), normalized);
  }
  for (const label of [undefined, null, 30, [], '', '帧', '𠀀'.repeat(9), ' 到达30帧', '到达30帧 ',
    '到达 30帧', '到达30帧\n', '帧\u200d数', '帧\u202e数', '加载，完成', 'AA!', 'A𖿢', 'Aℹ', 'A\u3164', 'A²', '😎完成', '<b>完成</b>']) {
    assert.equal(ps.normalizeMilestoneLabel(label), '', JSON.stringify(label));
  }
});

test('labels do not change fixed stages and appear only above displayed 50 before real stable', () => {
  const partialQuality = { ...qualityV5, evidence: { ...evidence, level: 'demonstrated' } };
  for (const [gta, expected] of [
    [{ prison: 0.5 }, [45, 'ingame', '进入游戏']],
    [{ prison: 0.999, qualityV5 }, [50, 'ingame', '进入游戏']],
    [{}, [50, 'prison', '进入监狱序章']],
    [{ qualityV5: partialQuality }, [95, 'prison', 'Café']],
    [{ qualityV5: partialQuality, milestoneLabel: '加载完成!' }, [95, 'prison', '进入监狱序章']],
    [{ qualityV5 }, [100, 'stable', '画面与帧率达标']],
  ]) {
    const { score, reached, reachedLabel } = scoreWith({ milestoneLabel: 'Cafe\u0301', ...gta });
    assert.deepEqual([score, reached, reachedLabel], expected);
  }
});

// ---- overall ----
test('overall filters out reference status and missing portProgress', () => {
  const ov = ps.overall([
    { status: 'progress', portProgress: { gta: { loads: 1 } } },
    { status: 'reference', portProgress: { gta: { loads: 1, boots: 1, menu: 1, ingame: 1, fps: 30, stability: 'stable' } } },
    { status: 'early' },
    { status: 'early', portProgress: { groundwork: { loader: 0.5, shaders: 0.5, graphics: 0.5, proven: 0.5 } } },
  ]);
  assert.equal(ov.rankedCount, 2);
});

test('overall leader is highest scorer', () => {
  const a = { status: 'progress', portProgress: { gta: { ...inPrison, qualityV5 } } };
  const b = { status: 'progress', portProgress: { groundwork: { loader: 1, shaders: 1, graphics: 1, proven: 1 }, gta: {} } };
  const ov = ps.overall([b, a]);
  assert.equal(ov.leader.project, a);
  assert.equal(ov.score, 100);
  assert.deepEqual(ov.ranked.map(row => [row.benchmarkFps, row.qualityCap, row.factors]), [
    [90, 100, { performance: 100, rendering: 100, stability: 100 }], [null, null, unknownFactors],
  ]);
  assert.equal(ov.leader.benchmarkFps, 90);
});

test('overall preserves project order for equal scores regardless of GitHub stars', () => {
  const a = { status: 'progress', github: { stars: 100 }, portProgress: { groundwork: { loader: 1, shaders: 1, graphics: 1, proven: 1 }, gta: {} } };
  const b = { status: 'progress', github: { stars: 200 }, portProgress: { groundwork: { loader: 1, shaders: 1, graphics: 1, proven: 1 }, gta: {} } };
  const ov = ps.overall([a, b]);
  assert.equal(ov.leader.project, a);
});

test('top3avg averages up to three scores', () => {
  const project = gta => ({ portProgress: { gta } });
  const entries = [project({ loads: 1 }), project(inPrison), project(inGame), project({ loads: 1, boots: 1 })];
  assert.equal(ps.overall(entries).top3avg, 40);
  assert.equal(ps.overall(entries.slice(0, 2)).top3avg, 32.5);
});

test('bootsCount counts projects where loads >= 1', () => {
  const a = { status: 'progress', portProgress: { gta: { loads: 1 } } };
  const b = { status: 'progress', portProgress: { gta: { loads: 0.5 } } };
  const c = { status: 'progress', portProgress: { gta: {} } };
  const ov = ps.overall([a, b, c]);
  assert.equal(ov.bootsCount, 1);
});

test('empty input returns neutral overall', () => {
  const ov = ps.overall([]);
  assert.equal(ov.leader, null);
  assert.equal(ov.score, 0);
  assert.equal(ov.rankedCount, 0);
  assert.equal(ov.top3avg, 0);
  assert.equal(ov.furthestMilestone, 'groundwork');
  assert.equal(ov.furthestMilestoneLabel, '基础工程');
});

test('neither display nor floating point rounded maximum grants the final milestone below 90 FPS', () => {
  const lastBelowTarget = benchmarkFor(90, 30);
  for (const { runs } of lastBelowTarget.segments) {
    for (const run of runs) run.seconds += 2 ** -48;
  }
  for (const benchmark of [benchmarkFor(89.99), lastBelowTarget]) {
    const near = scoreWith({ milestoneLabel: '着色器完成', qualityV5: { ...qualityV5, benchmark } });
    assert.ok(near.benchmarkFps < 90);
    assert.equal(near.score, 100);
    assert.equal(near.reached, 'prison');
    assert.equal(near.reachedLabel, '着色器完成');
  }
});

test('furthest label comes from the highest ranked row at the furthest fixed stage', () => {
  const project = gta => ({ portProgress: { gta: { ...inPrison, ...gta } } });
  const justShort = project({ prison: 0.999, milestoneLabel: '到达30帧' });
  const prison = project({ milestoneLabel: '着色器完成' });
  const tied = ps.overall([justShort, prison]);
  assert.equal(tied.leader.project, justShort);
  assert.equal(tied.furthestMilestone, 'prison');
  assert.equal(tied.furthestMilestoneLabel, '进入监狱序章');

  const qualityAt = fps => ({ ...qualityV5, benchmark: benchmarkFor(fps) });
  const lower = project({ qualityV5: qualityAt(30), milestoneLabel: '到达30帧' });
  const higher = project({ qualityV5: qualityAt(60), milestoneLabel: '内存占用优化' });
  const unnamed = project({ qualityV5: qualityAt(70) });
  assert.equal(ps.overall([lower, higher]).furthestMilestoneLabel, '内存占用优化');
  assert.equal(ps.overall([lower, unnamed]).furthestMilestoneLabel, '进入监狱序章');

  const rounded = project({ qualityV5: qualityAt(89.99), milestoneLabel: '着色器完成' });
  const stable = project({ qualityV5, milestoneLabel: '内存占用优化' });
  const final = ps.overall([rounded, stable]);
  assert.equal(final.leader.project, rounded);
  assert.equal(final.furthestMilestone, 'stable');
  assert.equal(final.furthestMilestoneLabel, '画面与帧率达标');
});

test('MILESTONES exposes total anchors without treating FPS as an overall milestone', () => {
  assert.equal(ps.MODEL_VERSION, 5);
  assert.deepEqual(ps.MILESTONES.map(({ key, label, at }) => [key, label, at]), [
    ['groundwork', '基础工程', 0], ['loads', '加载启动', 15], ['boots', '首帧画面', 30], ['menu', '进入菜单', 35],
    ['ingame', '进入游戏', 40], ['prison', '进入监狱序章', 50], ['stable', '画面与帧率达标', 100],
  ]);
});

test('exports the reference profile, V5 tables and unchanged V4 validation constants', () => {
  assert.deepEqual(ps.FACTOR_WEIGHTS, { quality: 0.9, stability: 0.1 });
  assert.deepEqual(ps.QUALITY_WEIGHTS, { bottleneck: 0.8, rendering: 0.15, performance: 0.05 });
  assert.deepEqual(ps.BENCHMARK_PROFILE, { id: 'steam-2026-10-v1', routeId: 'prison-v1', preset: 'series-x', width: 1920, height: 1080 });
  assert.deepEqual(ps.BENCHMARK_SEGMENTS, route);
  assert.deepEqual(ps.V5_RENDER_LEVELS, {
    critical: { score: 10, cap: 30 }, major: { score: 40, cap: 55 }, localized: { score: 70, cap: 85 },
    minor: { score: 92, cap: 95 }, clean: { score: 100, cap: 100 },
  });
  assert.deepEqual(ps.V5_SESSION_OUTCOMES, ['clean', 'crash', 'freeze', 'device-loss']);
  assert.deepEqual(ps.RENDER_WEIGHTS, { scenes: 0.4, characters: 0.35, vehicles: 0.25 });
  assert.deepEqual(ps.RENDER_LEVELS, { unknown: 0, missing: 0, partial: 0.5, complete: 1 });
  assert.deepEqual(ps.COVERAGE_KEYS, ['interaction', 'mission', 'saveReload', 'progression']);
  assert.deepEqual(ps.SESSION_OUTCOMES, ['clean', 'crash', 'freeze', 'device-loss', 'mission-blocked']);
});

test('GROUNDWORK weights sum to 1', () => {
  const sum = ps.GROUNDWORK.reduce((s, g) => s + g.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum ${sum}`);
});
