/* Tracker V5 scoring. See docs/provenance.md for the method and attribution. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PortScore = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  var MODEL_VERSION = 5;
  var MILESTONES = Object.freeze([
    { key: 'groundwork', label: '基础工程', at: 0 },
    { key: 'loads',      label: '加载启动', at: 15 },
    { key: 'boots',      label: '首帧画面', at: 30 },
    { key: 'menu',       label: '进入菜单', at: 35 },
    { key: 'ingame',     label: '进入游戏', at: 40 },
    { key: 'prison',     label: '进入监狱序章', at: 50 },
    { key: 'stable',     label: '画面与帧率达标', at: 100 },
  ].map(Object.freeze));

  var GROUNDWORK = Object.freeze([
    { key: 'loader',   label: '加载器与系统库', weight: 0.2 },
    { key: 'shaders',  label: '着色器翻译',     weight: 0.28 },
    { key: 'graphics', label: '图形层',         weight: 0.32 },
    { key: 'proven',   label: '其他游戏已验证', weight: 0.2 },
  ]);

  var FACTOR_WEIGHTS = Object.freeze({ quality: 0.90, stability: 0.10 });
  var QUALITY_WEIGHTS = Object.freeze({ bottleneck: 0.80, rendering: 0.15, performance: 0.05 });
  var FPS_CURVE = Object.freeze([[0, 0], [5, 10], [10, 25], [15, 35], [30, 60], [60, 80], [90, 100]].map(Object.freeze));
  var MAX_BENCHMARK_FPS = 1000;
  var BENCHMARK_PROFILE = Object.freeze({ id: 'i7-12700-rtx-4060-v1', routeId: 'prison-v1', preset: 'series-x', width: 1920, height: 1080 });
  var BENCHMARK_SEGMENTS = Object.freeze(['interior', 'corridor', 'yard']);
  var BENCHMARK_FLAGS = Object.freeze(['dynamicResolution', 'upscaling', 'frameGeneration', 'dlss5']);
  var BENCHMARK_FIELDS = ['profileId', 'routeId', 'preset', 'width', 'height'].concat(BENCHMARK_FLAGS);
  var OBSERVED_GAMEPLAY_SEGMENTS = Object.freeze(['gameplay']);
  var RATIO_METHODS = Object.freeze(['paired', 'gpu-bound', 'cpu-bound']);
  var V5_RENDER_LEVELS = Object.freeze({
    critical: Object.freeze({ score: 10, cap: 30 }),
    major: Object.freeze({ score: 40, cap: 55 }),
    localized: Object.freeze({ score: 70, cap: 85 }),
    minor: Object.freeze({ score: 92, cap: 95 }),
    clean: Object.freeze({ score: 100, cap: 100 }),
  });
  var V5_SESSION_OUTCOMES = Object.freeze(['clean', 'crash', 'freeze', 'device-loss']);

  // Kept for validation of the archived V4 inputs.
  var RENDER_WEIGHTS = Object.freeze({ scenes: 0.4, characters: 0.35, vehicles: 0.25 });
  var RENDER_LEVELS = Object.freeze({ unknown: 0, missing: 0, partial: 0.5, complete: 1 });
  var COVERAGE_KEYS = Object.freeze(['interaction', 'mission', 'saveReload', 'progression']);
  var EVIDENCE_CAPS = Object.freeze({ unverified: 50, 'self-reported': 75, demonstrated: 95, reproduced: 100 });
  var SESSION_OUTCOMES = Object.freeze(['clean', 'crash', 'freeze', 'device-loss', 'mission-blocked']);
  // Legacy public export; V5 uses only evidence-backed sessions for stability.
  var STABILITY = Object.freeze({ unknown: 0, constant: 0, often: 0.25, sometimes: 0.55, rarely: 0.8, stable: 1 });
  var LADDER = MILESTONES.slice(1, -1).map(function (milestone) { return milestone.key; });
  var TICK = {};
  for (var i = 0; i < MILESTONES.length; i++) TICK[MILESTONES[i].key] = MILESTONES[i].at;

  function clamp01(v) {
    var n = +v;
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  }

  function ladderVal(v) {
    if (v === true) return 1;
    if (v === false || v == null) return 0;
    return clamp01(v);
  }

  function normalizeMilestoneLabel(value) {
    if (typeof value !== 'string') return '';
    var label = value.normalize('NFC');
    // Some Han characters or Unicode letters are punctuation, emoji, or invisible fillers.
    return /^[\p{Script=Han}\p{L}\p{Nd}]{2,8}$/u.test(label) &&
      !/[\p{P}\p{Extended_Pictographic}\p{Default_Ignorable_Code_Point}]/u.test(label) ? label : '';
  }

  function milestoneLabelForScore(value, score, reached) {
    return reached === 'prison' && score > TICK.prison ? normalizeMilestoneLabel(value) : '';
  }

  function fpsScore(fps) {
    if (!Number.isFinite(fps) || fps < 0 || fps > MAX_BENCHMARK_FPS) return null;
    for (var i = 1; i < FPS_CURVE.length; i++) {
      var a = FPS_CURVE[i - 1], b = FPS_CURVE[i];
      if (fps <= b[0]) return a[1] + (fps - a[0]) * (b[1] - a[1]) / (b[0] - a[0]);
    }
    return 100;
  }

  function ownValue(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
  }

  function hasShape(value, required, optional) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      required.every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); }) &&
      Object.keys(value).every(function (key) { return required.includes(key) || (optional && optional.includes(key)); });
  }

  function validPlainText(value, max) {
    return typeof value === 'string' && value.length <= max && value.trim().length > 0 &&
      !/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value);
  }

  function validObservedDay(value) {
    if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var day = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(+day) && day.toISOString().slice(0, 10) === value;
  }

  function canonicalSourceUrl(value) {
    if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
    try {
      var url = new URL(value);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
      url.hash = '';
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function evidenceCap(evidence) {
    if (!hasShape(evidence, ['level', 'sourceUrl', 'build', 'setup', 'observedOn']) || typeof evidence.level !== 'string') return TICK.prison;
    var cap = ownValue(EVIDENCE_CAPS, evidence.level);
    if (!cap || cap === TICK.prison || !canonicalSourceUrl(evidence.sourceUrl) || !validPlainText(evidence.build, 120) ||
        !validPlainText(evidence.setup, 240) || !validObservedDay(evidence.observedOn)) return TICK.prison;
    return cap;
  }

  function benchmarkSettingsMismatch(benchmark) {
    return BENCHMARK_FIELDS.find(function (key) {
      if (key === 'routeId') return false;
      var expected = BENCHMARK_FLAGS.includes(key) ? false : BENCHMARK_PROFILE[key === 'profileId' ? 'id' : key];
      return ownValue(benchmark, key) !== expected;
    });
  }

  function matchesBenchmark(benchmark) {
    return hasShape(benchmark, BENCHMARK_FIELDS, ['segments']) &&
      benchmark.routeId === BENCHMARK_PROFILE.routeId && !benchmarkSettingsMismatch(benchmark);
  }

  function segmentMeasures(segments, measure, route) {
    if (!Array.isArray(segments) || segments.length !== route.length) return null;
    var results = [];
    for (var i = 0; i < segments.length; i++) {
      var segment = ownValue(segments, i);
      var result = measure(segment);
      if (result === null) return null;
      var index = route.indexOf(segment.id);
      if (index === -1 || ownValue(results, index) !== undefined) return null;
      results[index] = result;
    }
    return results;
  }

  function medianOfThree(values) {
    return values.sort(function (a, b) { return a - b; })[1];
  }

  function measurePerformanceSegment(segment) {
    if (!hasShape(segment, ['id', 'runs']) || !Array.isArray(segment.runs) || segment.runs.length !== 3) return null;
    var rates = [];
    var durations = [];
    for (var i = 0; i < 3; i++) {
      var run = ownValue(segment.runs, i);
      if (!hasShape(run, ['frames', 'seconds']) || !Number.isFinite(run.seconds) || run.seconds < 10 || run.seconds > 600 ||
          !Number.isSafeInteger(run.frames) || run.frames < 0 || run.frames > MAX_BENCHMARK_FPS * run.seconds) return null;
      rates.push(run.frames / run.seconds);
      durations.push(run.seconds);
    }
    return { fps: medianOfThree(rates), seconds: medianOfThree(durations) };
  }

  function benchmarkFpsFor(segments) {
    var results = segmentMeasures(segments, measurePerformanceSegment, BENCHMARK_SEGMENTS);
    return results === null ? null : weightedFpsFor(results, 'fps');
  }

  function weightedFpsFor(results, key) {
    var weightedFps = 0, seconds = 0, min = MAX_BENCHMARK_FPS, max = 0;
    for (var i = 0; i < results.length; i++) {
      var segment = results[i];
      var fps = segment[key];
      weightedFps += fps * segment.seconds;
      seconds += segment.seconds;
      min = Math.min(min, fps);
      max = Math.max(max, fps);
    }
    // Keep floating point error from moving the average outside the measured range.
    return Math.min(max, Math.max(min, weightedFps / seconds));
  }

  function publicEvidenceUrl(value) {
    if (typeof value !== 'string' || !/^https:\/\/[^/?#]/i.test(value)) return false;
    var source = canonicalSourceUrl(value);
    if (!source) return false;
    var host = new URL(source).hostname.replace(/\.$/, '');
    // Reject private literals and local names without fetching or resolving the URL.
    if (host.startsWith('[')) return /^\[[23][0-9a-f]{3}:/i.test(host) && !/^\[2001:db8:/i.test(host);
    if (/^\d+(?:\.\d+){3}$/.test(host)) {
      var octets = host.split('.').map(Number);
      var first = octets[0], second = octets[1], third = octets[2];
      if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
      if (first === 100) return second < 64 || second > 127;
      if (first === 169) return second !== 254;
      if (first === 172) return second < 16 || second > 31;
      if (first === 192) return second !== 168 && !(second === 0 && (third === 0 || third === 2));
      if (first === 198) return second !== 18 && second !== 19 && !(second === 51 && third === 100);
      if (first === 203) return second !== 0 || third !== 113;
      return true;
    }
    return host.includes('.') && !/\.(?:localhost|local|internal|home\.arpa|invalid|test|example)$/i.test(host);
  }

  function normalizedRouteSegments(routeId) {
    if (routeId === BENCHMARK_PROFILE.routeId) return BENCHMARK_SEGMENTS;
    if (routeId === 'observed-gameplay-v1') return OBSERVED_GAMEPLAY_SEGMENTS;
    return null;
  }

  function normalizedSettingsError(benchmark) {
    if (!hasShape(benchmark, [], BENCHMARK_FIELDS.concat('hardware', 'segments'))) return '';
    var mismatch = benchmarkSettingsMismatch(benchmark);
    if (mismatch) return '.' + mismatch;
    if (!normalizedRouteSegments(ownValue(benchmark, 'routeId'))) return '.routeId';
    var hardware = ownValue(benchmark, 'hardware');
    if (!hasShape(hardware, [], ['cpu', 'gpu', 'ram', 'details'])) return '.hardware';
    for (var key of ['cpu', 'gpu', 'ram']) {
      if (!validPlainText(ownValue(hardware, key), 120)) return '.hardware.' + key;
    }
    if (Object.prototype.hasOwnProperty.call(hardware, 'details') && !validPlainText(hardware.details, 240)) {
      return '.hardware.details';
    }
    return null;
  }

  function normalizedSegmentError(segment) {
    if (!hasShape(segment, ['id'], ['fps', 'seconds', 'sourceUrl', 'ratio'])) return '';
    var fps = ownValue(segment, 'fps'), seconds = ownValue(segment, 'seconds');
    if (!Number.isFinite(fps) || fps < 0 || fps > MAX_BENCHMARK_FPS) return '.fps';
    if (!Number.isFinite(seconds) || seconds < 10 || seconds > 600) return '.seconds';
    if (!publicEvidenceUrl(ownValue(segment, 'sourceUrl'))) return '.sourceUrl';
    var ratio = ownValue(segment, 'ratio');
    if (!hasShape(ratio, [], ['low', 'high', 'method', 'sourceUrl', 'basis'])) return '.ratio';
    var low = ownValue(ratio, 'low'), high = ownValue(ratio, 'high');
    if (!Number.isFinite(low) || low < 0.05 || low > 10) return '.ratio.low';
    if (!Number.isFinite(high) || high < low || high > 10 || fps * high > MAX_BENCHMARK_FPS) return '.ratio.high';
    if (!RATIO_METHODS.includes(ownValue(ratio, 'method'))) return '.ratio.method';
    if (!publicEvidenceUrl(ownValue(ratio, 'sourceUrl'))) return '.ratio.sourceUrl';
    if (!validPlainText(ownValue(ratio, 'basis'), 800)) return '.ratio.basis';
    return null;
  }

  function inspectNormalizedBenchmark(benchmark) {
    var error = normalizedSettingsError(benchmark);
    if (error !== null) return { error: error, route: null, measurements: null };
    var route = normalizedRouteSegments(benchmark.routeId);
    var segments = ownValue(benchmark, 'segments');
    // Verified full-route visuals can stand alone when no timing sample is available.
    if (!Object.prototype.hasOwnProperty.call(benchmark, 'segments') && route === BENCHMARK_SEGMENTS) {
      return { error: null, route: route, measurements: null };
    }
    if (!Array.isArray(segments) || segments.length !== route.length) {
      return { error: '.segments', route: route, measurements: null };
    }
    var measurements = [];
    for (var i = 0; i < segments.length; i++) {
      var segment = ownValue(segments, i);
      var at = '.segments[' + (i + 1) + ']';
      error = normalizedSegmentError(segment);
      if (error !== null) return { error: at + error, route: route, measurements: null };
      var index = route.indexOf(segment.id);
      if (index === -1 || ownValue(measurements, index) !== undefined) {
        return { error: at + '.id', route: route, measurements: null };
      }
      measurements[index] = {
        low: segment.fps * segment.ratio.low,
        high: segment.fps * segment.ratio.high,
        seconds: segment.seconds,
        method: segment.ratio.method,
      };
    }
    return { error: null, route: route, measurements: measurements };
  }

  function measureRenderingSegment(segment) {
    if (!hasShape(segment, ['id', 'severity']) || typeof segment.severity !== 'string') return null;
    return ownValue(V5_RENDER_LEVELS, segment.severity) || null;
  }

  function renderingScore(rendering, route) {
    if (!hasShape(rendering, ['segments'])) return null;
    var results = segmentMeasures(rendering.segments, measureRenderingSegment, route);
    if (results === null) return null;
    var sum = 0, cap = 100;
    for (var i = 0; i < results.length; i++) {
      sum += results[i].score;
      cap = Math.min(cap, results[i].cap);
    }
    return Math.min(cap, sum / results.length);
  }

  function stabilityScore(stability) {
    var baseline = 50;
    if (!hasShape(stability, ['sessions'])) return baseline;
    var sessions = stability.sessions;
    if (!Array.isArray(sessions) || sessions.length < 1 || sessions.length > 6) return baseline;
    var sources = new Set();
    var cleanMinutes = 0, failures = 0;
    for (var i = 0; i < sessions.length; i++) {
      var session = ownValue(sessions, i);
      if (!hasShape(session, ['minutes', 'outcome', 'sourceUrl']) || !V5_SESSION_OUTCOMES.includes(session.outcome) ||
          !Number.isFinite(session.minutes) || session.minutes < (session.outcome === 'clean' ? 1 : 0) || session.minutes > 240) return baseline;
      var url = canonicalSourceUrl(session.sourceUrl);
      if (!url || sources.has(url)) return baseline;
      sources.add(url);
      if (session.outcome === 'clean') cleanMinutes += Math.min(session.minutes, 30);
      else failures++;
    }
    return Math.max(0, Math.min(100, baseline + 50 * Math.min(90, cleanMinutes) / 90 - 25 * failures));
  }

  function qualityScores(quality, reachedPrison) {
    var scores = { performance: null, rendering: null, stability: reachedPrison ? 50 : null };
    var result = { scores: scores, cap: reachedPrison ? TICK.prison : null,
      benchmarkFps: null, benchmarkFpsUpper: null, benchmarkFpsMethod: null };
    if (!reachedPrison || !hasShape(quality, ['evidence'], ['benchmark', 'normalizedBenchmark', 'rendering', 'stability'])) return result;
    var cap = evidenceCap(quality.evidence);
    if (cap === TICK.prison) return result;

    scores.stability = stabilityScore(ownValue(quality, 'stability'));
    var benchmark = ownValue(quality, 'benchmark');
    var hasNormalized = Object.prototype.hasOwnProperty.call(quality, 'normalizedBenchmark');
    if (hasNormalized && Object.prototype.hasOwnProperty.call(quality, 'benchmark')) return result;

    var route = BENCHMARK_SEGMENTS;
    if (hasNormalized) {
      var sample = inspectNormalizedBenchmark(quality.normalizedBenchmark);
      route = sample.route;
      if (!route || (route === OBSERVED_GAMEPLAY_SEGMENTS && !sample.measurements)) return result;
      if (sample.measurements) {
        result.benchmarkFps = weightedFpsFor(sample.measurements, 'low');
        result.benchmarkFpsUpper = weightedFpsFor(sample.measurements, 'high');
        result.benchmarkFpsMethod = 'normalized';
        var allPaired = sample.measurements.every(function (row) { return row.method === 'paired'; });
        cap = Math.min(cap, route === BENCHMARK_SEGMENTS && allPaired ? 95 : 85);
      }
    } else {
      if (!matchesBenchmark(benchmark)) return result;
      result.benchmarkFps = benchmarkFpsFor(ownValue(benchmark, 'segments'));
      if (result.benchmarkFps !== null) result.benchmarkFpsMethod = 'direct';
    }
    scores.performance = fpsScore(result.benchmarkFps);
    scores.rendering = renderingScore(ownValue(quality, 'rendering'), route);
    if (scores.performance !== null && scores.rendering !== null) result.cap = cap;
    return result;
  }

  function groundworkFraction(gw) {
    if (!gw || typeof gw !== 'object') return 0;
    var sum = 0;
    for (var i = 0; i < GROUNDWORK.length; i++) {
      sum += GROUNDWORK[i].weight * clamp01(gw[GROUNDWORK[i].key]);
    }
    return sum;
  }

  function scoreEffort(pp) {
    var gw = groundworkFraction(pp && pp.groundwork);
    var gta = (pp && pp.gta) || {};
    var score = TICK.loads * gw;
    var reached = 'groundwork';
    var prevTick = score;

    for (var i = 0; i < LADDER.length; i++) {
      var key = LADDER[i];
      var input = gta[key];
      // The new gate requires a real fraction; only earlier stages accept legacy encodings.
      var v = key === 'prison' ? (Number.isFinite(input) && input >= 0 && input <= 1 ? input : 0) : ladderVal(input);
      if (v >= 1) {
        score = TICK[key];
        prevTick = score;
        reached = key;
        continue;
      }
      if (v > 0) score = Math.max(score, prevTick + v * (TICK[key] - prevTick));
      break;
    }

    var quality = qualityScores(ownValue(gta, 'qualityV5'), reached === 'prison');
    var factors = quality.scores;
    if (factors.performance !== null && factors.rendering !== null) {
      var combined = QUALITY_WEIGHTS.bottleneck * Math.min(factors.performance, factors.rendering) +
        QUALITY_WEIGHTS.rendering * factors.rendering + QUALITY_WEIGHTS.performance * factors.performance;
      var span = TICK.stable - TICK.prison;
      score = Math.min(quality.cap, TICK.prison + span / 100 * FACTOR_WEIGHTS.quality * combined +
        span / 100 * FACTOR_WEIGHTS.stability * factors.stability);
      var targetFps = FPS_CURVE[FPS_CURVE.length - 1][0];
      if (quality.cap === TICK.stable && quality.benchmarkFps >= targetFps && factors.rendering === 100 && factors.stability === 100) {
        reached = 'stable';
      }
    }

    score = Math.round(score * 10) / 10;
    var reachedLabel = milestoneLabelForScore(gta.milestoneLabel, score, reached) ||
      MILESTONES.find(function (milestone) { return milestone.key === reached; }).label;
    return { score: score, groundworkFraction: gw, reached: reached, reachedLabel: reachedLabel,
      factors: factors, qualityCap: quality.cap, benchmarkFps: quality.benchmarkFps,
      benchmarkFpsUpper: quality.benchmarkFpsUpper, benchmarkFpsMethod: quality.benchmarkFpsMethod };
  }

  function scoreProject(project) {
    return scoreEffort(project && project.portProgress);
  }

  function overall(projects) {
    if (!Array.isArray(projects)) projects = [];

    var ranked = [];
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      if (!p || !p.portProgress || p.status === 'reference') continue;
      ranked.push(Object.assign({ project: p }, scoreEffort(p.portProgress)));
    }

    // Keep the project order within ties, as the archive does.
    ranked.sort(function (a, b) { return b.score - a.score; });

    var leader = ranked.length ? ranked[0] : null;
    var top3 = ranked.slice(0, 3);
    var top3avg = top3.length
      ? Math.round((top3.reduce(function (s, r) { return s + r.score; }, 0) / top3.length) * 10) / 10
      : 0;

    // Rankings are descending and stable; only a later fixed stage can replace the first match.
    var furthest = null;
    for (var k = 0; k < ranked.length; k++) {
      if (!furthest || TICK[ranked[k].reached] > TICK[furthest.reached]) furthest = ranked[k];
    }

    var bootsCount = 0;
    for (var n = 0; n < ranked.length; n++) {
      var loads = ranked[n].project.portProgress && ranked[n].project.portProgress.gta && ranked[n].project.portProgress.gta.loads;
      if (ladderVal(loads) >= 1) bootsCount++;
    }

    return {
      leader: leader,
      score: leader ? leader.score : 0,
      top3avg: top3avg,
      furthestMilestone: furthest ? furthest.reached : MILESTONES[0].key,
      furthestMilestoneLabel: furthest ? furthest.reachedLabel : MILESTONES[0].label,
      rankedCount: ranked.length,
      bootsCount: bootsCount,
      ranked: ranked,
    };
  }

  return { MODEL_VERSION: MODEL_VERSION, MILESTONES: MILESTONES, GROUNDWORK: GROUNDWORK,
    FACTOR_WEIGHTS: FACTOR_WEIGHTS, QUALITY_WEIGHTS: QUALITY_WEIGHTS, FPS_CURVE: FPS_CURVE,
    BENCHMARK_PROFILE: BENCHMARK_PROFILE, BENCHMARK_SEGMENTS: BENCHMARK_SEGMENTS,
    BENCHMARK_FLAGS: BENCHMARK_FLAGS, MAX_BENCHMARK_FPS: MAX_BENCHMARK_FPS,
    normalizedRouteSegments: normalizedRouteSegments,
    normalizedBenchmarkError: function (benchmark) { return inspectNormalizedBenchmark(benchmark).error; },
    V5_RENDER_LEVELS: V5_RENDER_LEVELS, V5_SESSION_OUTCOMES: V5_SESSION_OUTCOMES,
    RENDER_WEIGHTS: RENDER_WEIGHTS,
    RENDER_LEVELS: RENDER_LEVELS, COVERAGE_KEYS: COVERAGE_KEYS, EVIDENCE_CAPS: EVIDENCE_CAPS,
    SESSION_OUTCOMES: SESSION_OUTCOMES, STABILITY: STABILITY, canonicalSourceUrl: canonicalSourceUrl,
    normalizeMilestoneLabel: normalizeMilestoneLabel, milestoneLabelForScore: milestoneLabelForScore,
    fpsScore: fpsScore, scoreProject: scoreProject, overall: overall };
});
