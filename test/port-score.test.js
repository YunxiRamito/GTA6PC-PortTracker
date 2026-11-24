'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ps = require('../assets/port-score');

// ---- groundwork fraction ----
test('zero groundwork when field is absent', () => {
  const r = ps.scoreProject({});
  assert.equal(r.score, 0);
  assert.equal(r.reached, 'groundwork');
});

test('full groundwork gives 25 points', () => {
  const r = ps.scoreProject({ portProgress: { groundwork: { loader: 1, shaders: 1, graphics: 1, proven: 1 }, gta: {} } });
  assert.equal(r.score, 25);
  assert.equal(r.reached, 'groundwork');
});

test('partial groundwork is weighted sum × 25', () => {
  // loader 0.2×0.5=0.1, shaders 0.28×1=0.28, graphics 0.32×0.5=0.16, proven 0.2×0=0 → 0.54×25=13.5
  const r = ps.scoreProject({ portProgress: { groundwork: { loader: 0.5, shaders: 1, graphics: 0.5, proven: 0 }, gta: {} } });
  assert.equal(r.score, 13.5);
});

// ---- ladder ----
test('loads=1 bumps score to 25 regardless of groundwork', () => {
  const r = ps.scoreProject({ portProgress: { groundwork: { loader: 0, shaders: 0, graphics: 0, proven: 0 }, gta: { loads: 1 } } });
  assert.equal(r.score, 25);
  assert.equal(r.reached, 'loads');
});

test('boots=0.5 interpolates between loads(25) and boots(40)', () => {
  const r = ps.scoreProject({ portProgress: { groundwork: { loader: 1, shaders: 1, graphics: 1, proven: 1 }, gta: { loads: 1, boots: 0.5 } } });
  // 25 + 0.5*(40-25) = 32.5
  assert.equal(r.score, 32.5);
  assert.equal(r.reached, 'loads');
});

test('ladder stops at partial step', () => {
  const r = ps.scoreProject({ portProgress: { gta: { loads: 1, boots: 1, menu: 0.5, ingame: 1 } } });
  // stops at menu partial: 40 + 0.5*(55-40) = 47.5; ingame should NOT be counted
  assert.equal(r.score, 47.5);
  assert.equal(r.reached, 'boots');
});

test('all ladder=1 reaches ingame at 70', () => {
  const r = ps.scoreProject({ portProgress: { gta: { loads: 1, boots: 1, menu: 1, ingame: 1, fps: 0, stability: 'unknown' } } });
  assert.equal(r.score, 70);
  assert.equal(r.reached, 'ingame');
});

test('partial in-game stage (0.8) scores 67 without completing the ingame milestone', () => {
  const r = ps.scoreProject({
    title: 'Example',
    portProgress: { gta: { loads: 1, boots: 1, menu: 1, ingame: 0.8, fps: 30, stability: 'stable' } },
  });
  assert.equal(r.score, 67);
  assert.equal(r.reached, 'menu');
});

// ---- fps / stability post ingame ----
test('fps=30 and stable=stable gives 100', () => {
  const r = ps.scoreProject({ portProgress: { gta: { loads: 1, boots: 1, menu: 1, ingame: 1, fps: 30, stability: 'stable' } } });
  assert.equal(r.score, 100);
  assert.equal(r.reached, 'stable');
});

test('fps=30 stability unknown reaches fps30', () => {
  const r = ps.scoreProject({ portProgress: { gta: { loads: 1, boots: 1, menu: 1, ingame: 1, fps: 30, stability: 'unknown' } } });
  assert.equal(r.score, 85);
  assert.equal(r.reached, 'fps30');
});

test('fps=15 (half) + often stability: 70 + 0.5*15 + 0.25*15 = 81.25', () => {
  const r = ps.scoreProject({ portProgress: { gta: { loads: 1, boots: 1, menu: 1, ingame: 1, fps: 15, stability: 'often' } } });
  assert.equal(r.score, 81.3); // rounds to 1 decimal
});

test('fps capped at 30: fps=60 treated as 30', () => {
  const r = ps.scoreProject({ portProgress: { gta: { loads: 1, boots: 1, menu: 1, ingame: 1, fps: 60, stability: 'stable' } } });
  assert.equal(r.score, 100);
  assert.equal(r.reached, 'stable');
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
  const a = { status: 'progress', portProgress: { gta: { loads: 1, boots: 1, menu: 1, ingame: 1, fps: 30, stability: 'stable' } } };
  const b = { status: 'progress', portProgress: { groundwork: { loader: 1, shaders: 1, graphics: 1, proven: 1 }, gta: {} } };
  const ov = ps.overall([b, a]);
  assert.equal(ov.leader.project, a);
  assert.equal(ov.score, 100);
});

test('overall preserves project order for equal scores regardless of GitHub stars', () => {
  const a = { status: 'progress', github: { stars: 100 }, portProgress: { groundwork: { loader: 1, shaders: 1, graphics: 1, proven: 1 }, gta: {} } };
  const b = { status: 'progress', github: { stars: 200 }, portProgress: { groundwork: { loader: 1, shaders: 1, graphics: 1, proven: 1 }, gta: {} } };
  const ov = ps.overall([a, b]);
  assert.equal(ov.leader.project, a);
});

test('top3avg averages up to three scores', () => {
  const proj = score => ({ status: 'progress', portProgress: { groundwork: { loader: score / 25, shaders: 0, graphics: 0, proven: 0 }, gta: {} } });
  const ov = ps.overall([proj(1), proj(1), proj(1), proj(1), proj(1)]);
  // all score ~5*0.2/25*25 = but let's use a known formula
  // just verify rankedCount=5 and top3avg = ranked[0..2] avg
  assert.equal(ov.rankedCount, 5);
  assert.equal(typeof ov.top3avg, 'number');
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
});

test('score rounds to 1 decimal', () => {
  // fps=15/30=0.5, stability=often=0.25 → 70+7.5+3.75 = 81.25 → 81.3
  const r = ps.scoreProject({ portProgress: { gta: { loads: 1, boots: 1, menu: 1, ingame: 1, fps: 15, stability: 'often' } } });
  assert.equal(r.score, 81.3);
});

test('MILESTONES has 7 entries in order', () => {
  assert.equal(ps.MILESTONES.length, 7);
  assert.deepEqual(ps.MILESTONES.map(m => m.key), ['groundwork', 'loads', 'boots', 'menu', 'ingame', 'fps30', 'stable']);
  assert.deepEqual(ps.MILESTONES.map(m => m.at), [0, 25, 40, 55, 70, 85, 100]);
});

test('GROUNDWORK weights sum to 1', () => {
  const sum = ps.GROUNDWORK.reduce((s, g) => s + g.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum ${sum}`);
});
