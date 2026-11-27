'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createFixtures } = require('../fixtures/demo');
const {
  BENCHMARK_FLAGS, BENCHMARK_SEGMENTS, MAX_BENCHMARK_FPS, V5_RENDER_LEVELS, V5_SESSION_OUTCOMES,
  normalizedRouteSegments, normalizedBenchmarkError,
  RENDER_LEVELS, COVERAGE_KEYS, SESSION_OUTCOMES,
  canonicalSourceUrl, normalizeMilestoneLabel, milestoneLabelForScore, scoreProject,
} = require('../assets/port-score');
const { BUILD_TRANSLATION_FIELDS, NEWS_TRANSLATION_FIELDS, copyTranslations, validateContentTranslations } = require('./_content-locale');
const SECTIONS = ['home', 'countdown', 'roadmap', 'announcements', 'downloads', 'news', 'projects', 'community'];
const PUBLIC_SECTIONS = ['home', 'countdown', 'roadmap', 'announcements', 'downloads', 'community'];
const RETIRED_ROADMAP_FIELDS = new Set(['currentStep', 'note', 'steps']);
const BUILD_FIELDS = ['title', 'summary', 'sourceLabel', 'sourceUrl', 'portProgress', 'translations'];
const PRIVATE_REPOSITORY_FIELDS = new Set(['id', ...BUILD_FIELDS]);
const COMMUNITY_BUILD_FIELDS = new Set(BUILD_FIELDS);
const TYPES = {
  runner: { label: '运行与适配', order: 1 }, tool: { label: '工具', order: 2 },
  resource: { label: '资料', order: 3 }, adjacent: { label: '其他游戏参考', order: 4 },
};
const STATUSES = {
  progress: { label: '开发中', order: 1, color: '#7c3aed' }, early: { label: '早期或暂停', order: 2, color: '#64748b' },
  tool: { label: '辅助工具', order: 3, color: '#0d9488' }, reference: { label: '参考资料', order: 4, color: '#94a3b8' },
};

const EVIDENCE_LEVELS = new Set(['unverified', 'self-reported', 'demonstrated', 'reproduced']);
const PLAYABILITY_STATUSES = new Set(['unplayable', 'unstable', 'playable']);
const GAMEPLAY_STATUSES = new Set(['planned', 'reported', 'completed', 'blocked', 'unknown']);
const PROJECT_GAMEPLAY_STATUSES = new Set(['reported', 'completed', 'blocked']);
const PORT_STABILITY_VALUES = new Set(['unknown', 'constant', 'often', 'sometimes', 'rarely', 'stable']);
const PORT_VERIFICATION_VALUES = new Set(['verified', 'self-reported', 'unverified']);
const BIDI_RE = /[‎‏‪-‮⁦-⁩]/;
function validPlainText(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value) && !BIDI_RE.test(value);
}
function validFraction(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1; }
const GAMEPLAY_ID_RULE = '最多 48 个字符，使用小写英文字母、数字或分隔用的连字符';
function validGameplayId(id) {
  return typeof id === 'string' && id.length <= 48 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}

function validDate(value, withTime = false) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match || (withTime && !match[2]) || !Number.isFinite(Date.parse(value))) return false;
  const day = new Date(match[1] + 'T00:00:00.000Z');
  return Number.isFinite(+day) && day.toISOString().slice(0, 10) === match[1] && Number(match[2]?.slice(0, 2) || 0) < 24;
}

function validRepo(value) {
  return typeof value === 'string' && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i.test(value) &&
    !value.endsWith('/.') && !value.endsWith('/..');
}

function validUrl(value, kind = 'https') {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  if (/^#[a-z0-9][a-z0-9-]*$/i.test(value) || (kind === 'announcement' && /^\/(?!\/)/.test(value))) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

function normalizeNewsId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim().toLowerCase();
  return id.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? id : '';
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0'); }
function validateContent(content) {
  if (!object(content)) return ['内容必须是 JSON 对象。'];
  const errors = [];
  const check = (ok, loc, why) => { if (!ok && errors.length < 60) errors.push(`${loc}：${why}`); };
  const required = (value, loc, max) => check(text(value, max), loc, `需要 1–${max} 个字符`);
  const optional = (value, loc, max) => check(value === undefined || value === '' || text(value, max), loc, `最多 ${max} 个字符`);
  const linkErrors = { download: '需要 HTTPS 链接', announcement: '需要本站内路径（如 #downloads）或 HTTP(S) 链接' };
  const link = (value, loc, kind) => check(validUrl(value, kind), loc, linkErrors[kind] || '链接无效或不是 HTTPS');
  const optionalLink = (value, loc, kind) => { if (value !== undefined && value !== '') link(value, loc, kind); };
  const date = (value, loc, withTime = false) => check(validDate(value, withTime), loc, withTime ? '需要有 UTC 偏移的 ISO 时间' : '需要有效日期或带时区的时间');
  function items(value, loc, max, validate, min = 0) {
    if (!Array.isArray(value)) return check(false, loc, '需要列表');
    check(value.length >= min && value.length <= max, loc, `需要 ${min}–${max} 条`);
    value.slice(0, max).forEach((entry, index) => {
      const key = `${loc}[${index + 1}]`;
      if (object(entry)) validate(entry, key);
      else check(false, key, '需要对象');
    });
  }
  function validateBuild(build, loc, fields) {
    for (const key of Object.keys(build)) check(fields.has(key), `${loc}.${key}`, '不是支持字段');
    for (const [field, max] of [['title', 120], ['summary', 800], ['sourceLabel', 80]]) {
      check(validPlainText(build[field], max), loc + '.' + field, '需要 1–' + max + ' 个字符的纯文本');
    }
    link(build.sourceUrl, `${loc}.sourceUrl`);
    validatePortProgress(build.portProgress, `${loc}.portProgress`);
  }
  function shape(value, at, keys) {
    if (!object(value)) return check(false, at, '需要对象');
    for (const key of Object.keys(value)) check(keys.includes(key), `${at}.${key}`, '不允许的字段');
    return true;
  }
  const range = (value, min, max, at) => check(Number.isFinite(value) && value >= min && value <= max,
    at, `需要 ${min}–${max} 的有限数字`);

  function validateQualityEvidence(evidence, at, { legacy = false } = {}) {
    if (!shape(evidence, at, ['level', 'sourceUrl', 'build', 'setup', 'observedOn'])) return;
    check(EVIDENCE_LEVELS.has(evidence.level), `${at}.level`, '证据等级无效');
    if (legacy) link(evidence.sourceUrl, `${at}.sourceUrl`);
    else check(Boolean(canonicalSourceUrl(evidence.sourceUrl)), `${at}.sourceUrl`, '需要绝对 HTTPS 链接，不含登录凭据');
    check(validPlainText(evidence.build, 120), `${at}.build`, '需要 1–120 字构建标识');
    check(validPlainText(evidence.setup, 240), `${at}.setup`, '需要 1–240 字测试配置');
    check(typeof evidence.observedOn === 'string' && evidence.observedOn.length === 10 && validDate(evidence.observedOn),
      `${at}.observedOn`, '需要 YYYY-MM-DD 日期');
  }

  // Archived quality records remain editable without contributing to V5.
  function validateLegacyQuality(quality, at) {
    if (!shape(quality, at, ['evidence', 'performance', 'rendering', 'stability', 'completeness'])) return;
    const { evidence, performance, rendering, stability, completeness } = quality;
    validateQualityEvidence(evidence, `${at}.evidence`, { legacy: true });
    if (performance !== undefined && shape(performance, `${at}.performance`, ['fps', 'minutes'])) {
      range(performance.fps, 0, 240, `${at}.performance.fps`);
      range(performance.minutes, 1, 120, `${at}.performance.minutes`);
    }
    const renderKeys = ['scenes', 'characters', 'vehicles'];
    if (rendering !== undefined && shape(rendering, `${at}.rendering`, renderKeys)) {
      for (const key of renderKeys) {
        const level = rendering[key];
        if (level !== undefined) check(typeof level === 'string' && Object.hasOwn(RENDER_LEVELS, level),
          `${at}.rendering.${key}`, '渲染等级无效');
      }
    }
    if (stability !== undefined && shape(stability, `${at}.stability`, ['sessions'])) {
      items(stability.sessions, `${at}.stability.sessions`, 3, (session, row) => {
        shape(session, row, ['minutes', 'outcome']);
        range(session.minutes, session.outcome === 'clean' ? 1 : 0, 240, `${row}.minutes`);
        check(SESSION_OUTCOMES.includes(session.outcome), `${row}.outcome`, '运行结果无效');
      }, 1);
    }
    if (completeness !== undefined && shape(completeness, `${at}.completeness`, COVERAGE_KEYS)) {
      for (const key of COVERAGE_KEYS) {
        if (completeness[key] !== undefined) check(['unknown', 'fail', 'pass'].includes(completeness[key]),
          `${at}.completeness.${key}`, '覆盖结果无效');
      }
    }
  }

  function validateV5Segments(segments, at, field, validate, route = BENCHMARK_SEGMENTS) {
    const seen = new Set();
    items(segments, at, route.length, (segment, row) => {
      shape(segment, row, ['id', field]);
      check(route.includes(segment.id) && !seen.has(segment.id), `${row}.id`, '需要不重复的标准路段标识');
      seen.add(segment.id);
      validate(segment[field], `${row}.${field}`);
    }, route.length);
  }

  function validateV5Quality(quality, at) {
    if (!shape(quality, at, ['evidence', 'benchmark', 'normalizedBenchmark', 'rendering', 'stability'])) return;
    const { evidence, benchmark, normalizedBenchmark, rendering, stability } = quality;
    if (Object.hasOwn(quality, 'normalizedBenchmark')) {
      const normalized = `${at}.normalizedBenchmark`;
      check(!Object.hasOwn(quality, 'benchmark'), normalized, '不能和参考机直测同时录入');
      const error = normalizedBenchmarkError(normalizedBenchmark);
      if (error !== null) check(false, normalized + error, '异机归一化取证字段无效');
    }
    validateQualityEvidence(evidence, `${at}.evidence`);
    const bench = `${at}.benchmark`;
    const ids = ['profileId', 'routeId', 'preset'];
    const sizes = ['width', 'height'];
    if (benchmark !== undefined && shape(benchmark, bench, [...ids, ...sizes, ...BENCHMARK_FLAGS, 'segments'])) {
      for (const key of ids) check(validGameplayId(benchmark[key]), `${bench}.${key}`, GAMEPLAY_ID_RULE);
      for (const key of sizes) check(Number.isInteger(benchmark[key]) && benchmark[key] >= 1 && benchmark[key] <= 16384,
        `${bench}.${key}`, '需要 1–16384 的整数');
      for (const key of BENCHMARK_FLAGS) check(typeof benchmark[key] === 'boolean', `${bench}.${key}`, '需要布尔值');
      // An otherwise valid configuration can be saved while the reference runs are pending.
      if (benchmark.segments !== undefined) validateV5Segments(benchmark.segments, `${bench}.segments`, 'runs', (runs, row) => {
        items(runs, row, 3, (run, trial) => {
          shape(run, trial, ['frames', 'seconds']);
          range(run.seconds, 10, 600, `${trial}.seconds`);
          check(Number.isSafeInteger(run.frames) && run.frames >= 0 && run.frames <= run.seconds * MAX_BENCHMARK_FPS,
            `${trial}.frames`, `需要非负整数，且实际帧率不超过 ${MAX_BENCHMARK_FPS} FPS`);
        }, 3);
      });
    }
    const render = `${at}.rendering`;
    if (rendering !== undefined && shape(rendering, render, ['segments'])) {
      validateV5Segments(rendering.segments, `${render}.segments`, 'severity', (severity, row) => {
        check(typeof severity === 'string' && Object.hasOwn(V5_RENDER_LEVELS, severity), row, '画面缺陷等级无效');
      }, normalizedRouteSegments(normalizedBenchmark?.routeId) ?? BENCHMARK_SEGMENTS);
    }
    const stable = `${at}.stability`;
    if (stability !== undefined && shape(stability, stable, ['sessions'])) {
      const sources = new Set();
      items(stability.sessions, `${stable}.sessions`, 6, (session, row) => {
        shape(session, row, ['minutes', 'outcome', 'sourceUrl']);
        range(session.minutes, session.outcome === 'clean' ? 1 : 0, 240, `${row}.minutes`);
        check(V5_SESSION_OUTCOMES.includes(session.outcome), `${row}.outcome`, '运行结果无效');
        const source = canonicalSourceUrl(session.sourceUrl);
        check(Boolean(source), `${row}.sourceUrl`, '需要绝对 HTTPS 链接，不含登录凭据');
        if (source) {
          check(!sources.has(source), `${row}.sourceUrl`, '这一来源已录入');
          sources.add(source);
        }
      }, 1);
    }
  }

  function validatePortProgress(pp, kpp) {
    check(object(pp), kpp, '需要对象');
    if (object(pp)) {
      const allowedTopKeys = new Set(['groundwork', 'gta', 'provenOn', 'works', 'blocking', 'verification', 'assessedAt']);
      for (const uk of Object.keys(pp)) check(allowedTopKeys.has(uk), `${kpp}.${uk}`, '不允许的字段');
      if (pp.groundwork !== undefined) {
        check(object(pp.groundwork), `${kpp}.groundwork`, '需要对象');
        if (object(pp.groundwork)) {
          const allowedGwKeys = new Set(['loader', 'shaders', 'graphics', 'proven']);
          for (const uk of Object.keys(pp.groundwork)) check(allowedGwKeys.has(uk), `${kpp}.groundwork.${uk}`, '不允许的字段');
          for (const gk of ['loader', 'shaders', 'graphics', 'proven']) {
            if (pp.groundwork[gk] !== undefined)
              check(validFraction(pp.groundwork[gk]), `${kpp}.groundwork.${gk}`, '需要 0–1 之间的数字');
          }
        }
      }
      if (pp.gta !== undefined) {
        check(object(pp.gta), `${kpp}.gta`, '需要对象');
        if (object(pp.gta)) {
          const stages = ['loads', 'boots', 'menu', 'ingame', 'prison', 'rendered'];
          const allowedGtaKeys = new Set([...stages, 'fps', 'stability', 'quality', 'qualityV5', 'milestoneLabel']);
          for (const uk of Object.keys(pp.gta)) check(allowedGtaKeys.has(uk), `${kpp}.gta.${uk}`, '不允许的字段');
          for (const lk of stages)
            if (pp.gta[lk] !== undefined) check(validFraction(pp.gta[lk]), `${kpp}.gta.${lk}`, '需要 0–1 之间的数字');

          if (pp.gta.milestoneLabel !== undefined)
            check(Boolean(normalizeMilestoneLabel(pp.gta.milestoneLabel)), `${kpp}.gta.milestoneLabel`, '需要 2–8 个汉字、字母或十进制数字');
          if (pp.gta.quality !== undefined) validateLegacyQuality(pp.gta.quality, `${kpp}.gta.quality`);
          if (pp.gta.qualityV5 !== undefined) validateV5Quality(pp.gta.qualityV5, `${kpp}.gta.qualityV5`);
          if (pp.gta.fps !== undefined)
            check(typeof pp.gta.fps === 'number' && Number.isFinite(pp.gta.fps) && pp.gta.fps >= 0 && pp.gta.fps <= 240, `${kpp}.gta.fps`, '需要 0–240 之间的数字');
          if (pp.gta.stability !== undefined)
            check(PORT_STABILITY_VALUES.has(pp.gta.stability), `${kpp}.gta.stability`, `可用：${[...PORT_STABILITY_VALUES].join(', ')}`);
        }
      }
      if (pp.provenOn !== undefined) check(pp.provenOn === null || validPlainText(pp.provenOn, 80), `${kpp}.provenOn`, '需要纯文本字符串或 null，最多 80 个字符');
      for (const listKey of ['works', 'blocking']) {
        if (pp[listKey] !== undefined) {
          check(Array.isArray(pp[listKey]) && pp[listKey].length <= 6, `${kpp}.${listKey}`, '需要最多 6 条的列表');
          if (Array.isArray(pp[listKey])) pp[listKey].forEach((item, idx) => {
            check(validPlainText(item, 160), `${kpp}.${listKey}[${idx + 1}]`, '需要 1–160 个字符的纯文本');
          });
        }
      }
      if (pp.verification !== undefined) check(PORT_VERIFICATION_VALUES.has(pp.verification), `${kpp}.verification`, `可用：${[...PORT_VERIFICATION_VALUES].join(', ')}`);
      if (pp.assessedAt !== undefined) check(validDate(pp.assessedAt), `${kpp}.assessedAt`, '需要 YYYY-MM-DD 格式的日期');
    }
  }
  for (const key of Object.keys(content)) check(SECTIONS.includes(key), key, '不是可维护的内容分区');
  for (const key of SECTIONS) check(Object.hasOwn(content, key), key, '缺少分区');
  const { home, countdown, roadmap, announcements, downloads, news, projects, community } = content;
  if (object(home)) {
    required(home.latestUpdate, 'home.latestUpdate', 130);
    check(home.autoNewsCount === undefined || home.autoNewsCount === 1 || home.autoNewsCount === 2,
      'home.autoNewsCount', '自动显示的新闻数量必须是 1 或 2');
    if (home.newsIds !== undefined) {
      const validList = Array.isArray(home.newsIds) && home.newsIds.length <= 2;
      check(validList, 'home.newsIds', '最多选择两条新闻');
      if (validList) {
        const ids = home.newsIds.map(normalizeNewsId);
        check(ids.every(Boolean), 'home.newsIds', '需要有效的新闻 ID');
        check(new Set(ids).size === ids.length, 'home.newsIds', '不能重复选择同一条新闻');
      }
    }
  } else check(false, 'home', '需要对象');
  if (object(countdown)) {
    check(!Object.hasOwn(countdown, 'enabled') || typeof countdown.enabled === 'boolean', 'countdown.enabled', '需要 true 或 false');
    required(countdown.label, 'countdown.label', 110);
    date(countdown.target, 'countdown.target', true);
    required(countdown.source, 'countdown.source', 380);
    if (countdown.buttons === undefined) link(countdown.officialUrl, 'countdown.officialUrl');
    else {
      optionalLink(countdown.officialUrl, 'countdown.officialUrl');
      items(countdown.buttons, 'countdown.buttons', 3, (p, k) => {
        required(p.label, k + '.label', 25);
        link(p.url, k + '.url');
      });
    }
  } else check(false, 'countdown', '需要对象');
  if (object(roadmap)) {
    if (roadmap.playability !== undefined) {
      check(object(roadmap.playability), 'roadmap.playability', '需要对象');
      if (object(roadmap.playability)) {
        required(roadmap.playability.summary, 'roadmap.playability.summary', 110);
        optionalLink(roadmap.playability.sourceUrl, 'roadmap.playability.sourceUrl');
        if (roadmap.playability.status !== undefined) {
          check(PLAYABILITY_STATUSES.has(roadmap.playability.status), 'roadmap.playability.status', '可用：unplayable、unstable、playable');
        }
      }
    }
    if (roadmap.communityBuild !== undefined) {
      const at = 'roadmap.communityBuild';
      const build = roadmap.communityBuild;
      check(object(build), at, '需要对象');
      if (object(build)) validateBuild(build, at, COMMUNITY_BUILD_FIELDS);
    }
    if (roadmap.privateRepositories !== undefined) {
      const ids = new Set();
      items(roadmap.privateRepositories, 'roadmap.privateRepositories', 160, (build, loc) => {
        if (!validGameplayId(build.id)) check(false, `${loc}.id`, GAMEPLAY_ID_RULE);
        else {
          check(!ids.has(build.id), `${loc}.id`, '私有仓库 ID 不得重复');
          ids.add(build.id);
        }
        validateBuild(build, loc, PRIVATE_REPOSITORY_FIELDS);
      });
    }
    if (roadmap.externalProgress !== undefined) {
      const loc = 'roadmap.externalProgress';
      check(object(roadmap.externalProgress), loc, '需要对象');
      if (object(roadmap.externalProgress)) {
        const allowed = new Set(['title', 'score', 'summary', 'sourceLabel', 'sourceUrl', 'translations']);
        for (const key of Object.keys(roadmap.externalProgress)) {
          check(allowed.has(key), `${loc}.${key}`, '不是支持字段');
        }
        required(roadmap.externalProgress.title, `${loc}.title`, 120);
        check(typeof roadmap.externalProgress.score === 'number' && Number.isFinite(roadmap.externalProgress.score) &&
          roadmap.externalProgress.score >= 0 && roadmap.externalProgress.score <= 100,
        `${loc}.score`, '需要 0–100 的有限数字');
        required(roadmap.externalProgress.summary, `${loc}.summary`, 800);
        required(roadmap.externalProgress.sourceLabel, `${loc}.sourceLabel`, 80);
        link(roadmap.externalProgress.sourceUrl, `${loc}.sourceUrl`);
      }
    }
    const { gameplayProgress } = roadmap;
    if (gameplayProgress !== undefined) {
      const loc = 'roadmap.gameplayProgress';
      check(object(gameplayProgress), loc, '需要对象');
      if (object(gameplayProgress)) {
        optional(gameplayProgress.title, `${loc}.title`, 24);
        optional(gameplayProgress.note, `${loc}.note`, 240);
        const ids = new Set();
        items(gameplayProgress.milestones, `${loc}.milestones`, 12, (p, k) => {
          const { id, label, status, evidence, sourceUrl } = p;
          const validId = validGameplayId(id);
          check(validId, `${k}.id`, GAMEPLAY_ID_RULE);
          if (validId) {
            check(!ids.has(id), `${k}.id`, '节点 ID 不得重复');
            ids.add(id);
          }
          required(label, `${k}.label`, 24);
          check(GAMEPLAY_STATUSES.has(status), `${k}.status`, '可用：' + [...GAMEPLAY_STATUSES].join(', '));
          if (status === 'reported' || status === 'completed') {
            required(evidence, `${k}.evidence`, 160);
            link(sourceUrl, `${k}.sourceUrl`);
          } else {
            optional(evidence, `${k}.evidence`, 160);
            optionalLink(sourceUrl, `${k}.sourceUrl`);
          }
        }, 1);
      }
    }
  } else check(false, 'roadmap', '需要对象');
  if (object(announcements)) {
    link(announcements.source, 'announcements.source');
    check(typeof announcements.checkedOn === 'string' && announcements.checkedOn.length === 10 && validDate(announcements.checkedOn), 'announcements.checkedOn', '需要有效日期 YYYY-MM-DD');
    items(announcements.items, 'announcements.items', 120, (p, k) => {
      date(p.datetime, `${k}.datetime`); required(p.title, `${k}.title`, 120); required(p.summary, `${k}.summary`, 1200);
      if (p.buttons !== undefined) items(p.buttons, `${k}.buttons`, 3, (button, loc) => {
        required(button.label, `${loc}.label`, 35);
        link(button.url, `${loc}.url`, 'announcement');
      });
    });
  } else check(false, 'announcements', '需要对象');
  if (object(downloads)) {
    optional(downloads.note, 'downloads.note', 240);
    items(downloads.items, 'downloads.items', 40, (p, k) => {
      required(p.title, k + '.title', 100);
      optional(p.description, k + '.description', 220);
      if (p.channels === undefined) link(p.url, k + '.url', 'download');
      else {
        optionalLink(p.url, k + '.url', 'download');
        items(p.channels, k + '.channels', 12, (channel, loc) => {
          required(channel.label, loc + '.label', 35);
          link(channel.url, loc + '.url', 'download');
        }, 1);
      }
    });
  } else check(false, 'downloads', '需要对象');
  const newsIds = new Set();
  items(news, 'news', 400, (p, k) => {
    if (p.id !== undefined) {
      const id = normalizeNewsId(p.id);
      check(Boolean(id), k + '.id', '最多 64 个英文字母、数字或分隔用的连字符');
      if (id) {
        check(!newsIds.has(id), k + '.id', '新闻 ID 不得重复');
        newsIds.add(id);
      }
    }
    check(p.correction === undefined || typeof p.correction === 'boolean', k + '.correction', '需要 true 或 false');
    date(p.date, `${k}.date`); required(p.title, `${k}.title`, 190);
    if (p.repo) check(validRepo(p.repo), `${k}.repo`, '仓库格式为 owner/name');
    else check(p.repo === undefined || p.repo === '', `${k}.repo`, '仓库格式为 owner/name');
    if (p.sourceUrl) link(p.sourceUrl, `${k}.sourceUrl`);
  });
  const repos = new Set();
  items(projects, 'projects', 160, (p, k) => {
    check(validRepo(p.repo), `${k}.repo`, '仓库格式为 owner/name');
    if (validRepo(p.repo)) {
      const key = p.repo.toLowerCase();
      check(!repos.has(key), `${k}.repo`, '同一个仓库不能重复');
      repos.add(key);
    }
    check(typeof p.type === 'string' && Object.hasOwn(TYPES, p.type), `${k}.type`, `可用：${Object.keys(TYPES).join(', ')}`);
    check(typeof p.status === 'string' && Object.hasOwn(STATUSES, p.status), `${k}.status`, `可用：${Object.keys(STATUSES).join(', ')}`);
    required(p.title, `${k}.title`, 90); required(p.summary, `${k}.summary`, 360); optional(p.progress, `${k}.progress`, 250);
    if (p.evidence !== undefined) {
      check(object(p.evidence), k + '.evidence', '需要对象');
      if (object(p.evidence)) {
        const { tested, level, blocker, sourceUrl } = p.evidence;
        required(tested, k + '.evidence.tested', 80);
        check(EVIDENCE_LEVELS.has(level), k + '.evidence.level', '可用：' + [...EVIDENCE_LEVELS].join(', '));
        optional(blocker, k + '.evidence.blocker', 150);
        if (level === 'demonstrated' || level === 'reproduced') link(sourceUrl, k + '.evidence.sourceUrl');
        else optionalLink(sourceUrl, k + '.evidence.sourceUrl');
      }
    }
    if (p.portProgress !== undefined) validatePortProgress(p.portProgress, `${k}.portProgress`);
    for (const field of ['game', 'state', 'approach', 'highlight']) optional(p[field], `${k}.${field}`, 3200);
    if (p.logo) check(typeof p.logo === 'string' && /^\/assets\/logos\/[a-z\d_.-]+\.(?:png|jpe?g|webp)$/i.test(p.logo), `${k}.logo`, '需要本站项目标识路径');
    if (p.tags !== undefined) check(Array.isArray(p.tags) && p.tags.length <= 40 && p.tags.every(tag => text(tag, 95)), `${k}.tags`, '需要不超过 40 个文本标签');
  });
  check(
    object(community) && Object.keys(community).length === 1 && Object.hasOwn(community, 'groups') &&
      Array.isArray(community.groups) && community.groups.length === 0,
    'community.groups', '演示版必须使用空列表',
  );
  if (errors.length < 60) validateContentTranslations(content, check, RETIRED_ROADMAP_FIELDS);
  return errors;
}

function withNewsIds(content) {
  // Reserve explicit IDs first so generated legacy IDs never displace them.
  const used = new Set(content.news.map(item => normalizeNewsId(item.id)).filter(Boolean));
  const news = content.news.map(item => {
    let id = normalizeNewsId(item.id);
    if (!id) {
      const fingerprint = JSON.stringify([item.date, item.repo || '', item.title, item.sourceUrl || '']);
      const hash = createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
      const stem = item.date.slice(0, 10) + '-' + hash;
      id = stem;
      for (let suffix = 2; used.has(id); suffix++) id = stem + '-' + suffix;
      used.add(id);
    }
    return item.id === id ? item : { ...item, id };
  });
  const selection = content.home.newsIds?.map(normalizeNewsId);
  const selectionChanged = selection?.some((id, index) => id !== content.home.newsIds[index]);
  if (!selectionChanged && news.every((item, index) => item === content.news[index])) return content;
  const home = selectionChanged ? { ...content.home, newsIds: selection } : content.home;
  return { ...content, home, news };
}

function withMilestoneLabel(record, select) {
  const pp = record.portProgress;
  const current = pp?.gta?.milestoneLabel;
  if (current === undefined) return record;
  const label = select(current);
  if (label && label === current) return record;
  const gta = { ...pp.gta };
  if (label) gta.milestoneLabel = label;
  else delete gta.milestoneLabel;
  return { ...record, portProgress: { ...pp, gta } };
}

function mapRoadmapBuilds(roadmap, project) {
  const { communityBuild, privateRepositories } = roadmap;
  const legacy = communityBuild && project(communityBuild);
  const repositories = privateRepositories?.map(project);
  const privateChanged = repositories?.some((build, index) => build !== privateRepositories[index]);
  if (legacy === communityBuild && !privateChanged) return roadmap;
  return { ...roadmap, ...(legacy !== communityBuild && { communityBuild: legacy }),
    ...(privateChanged && { privateRepositories: repositories }) };
}

function normalizeMilestoneLabels(content) {
  const normalize = record => withMilestoneLabel(record, normalizeMilestoneLabel);
  const projects = content.projects.map(normalize);
  const roadmap = mapRoadmapBuilds(content.roadmap, normalize);
  return roadmap === content.roadmap && projects.every((project, index) => project === content.projects[index])
    ? content : { ...content, projects, roadmap };
}

function projectMilestoneLabel(record) {
  return withMilestoneLabel(record, label => {
    const { score, reached } = scoreProject(record);
    return milestoneLabelForScore(label, score, reached);
  });
}

function projectPublicContent(content) {
  const result = Object.fromEntries(PUBLIC_SECTIONS.map(key => [key, content[key]]));
  result.community = { groups: [] };
  result.roadmap = mapRoadmapBuilds(content.roadmap, projectMilestoneLabel);
  const { newsIds, autoNewsCount = 2, ...home } = content.home;
  let selected;
  if (newsIds === undefined) {
    selected = [...content.news].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, autoNewsCount);
  } else {
    const byId = new Map(content.news.map(item => [item.id, item]));
    selected = newsIds.map(id => byId.get(id)).filter(Boolean);
  }
  result.home = { ...home, latestNews: selected.map(item => ({
    id: item.id, title: item.title, correction: item.correction === true, ...copyTranslations(item, NEWS_TRANSLATION_FIELDS),
  })) };
  return result;
}

function projectPrivateRepositories(roadmap) {
  return (roadmap?.privateRepositories ?? []).map(item => {
    const { id, title, summary, sourceLabel, sourceUrl, portProgress } = item;
    return {
      id: 'private-repo-' + id, title, summary, sourceLabel, sourceUrl, portProgress,
      ...copyTranslations(item, BUILD_TRANSLATION_FIELDS),
    };
  });
}

function mergeCompatibleRoadmap(saved, proposed) {
  const fields = new Map(Object.entries(saved));
  for (const field of fields.keys()) {
    // Omission by an older editor is not a request to clear the private list.
    if (!RETIRED_ROADMAP_FIELDS.has(field) && field !== 'privateRepositories' && !Object.hasOwn(proposed, field)) fields.delete(field);
  }
  for (const [field, value] of Object.entries(proposed)) {
    if (!RETIRED_ROADMAP_FIELDS.has(field)) fields.set(field, value);
  }
  return Object.fromEntries(fields);
}

function withCountdownDefault(content, enabled = true) {
  if (Object.hasOwn(content.countdown, 'enabled')) return content;
  return { ...content, countdown: { ...content.countdown, enabled } };
}

class ContentError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function createContentStore({
  filePath = path.join(process.env.GTAVI_RUNTIME_DIR || path.join(ROOT, '.runtime'), 'content.json'),
  seedPath,
  now = Date.now,
} = {}) {
  let recordPath = filePath;
  let record;
  try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
    recordPath = seedPath;
    record = seedPath ? JSON.parse(fs.readFileSync(seedPath, 'utf8')) : { content: createFixtures(now()).content, updatedAt: new Date(now()).toISOString() };
  }
  const enveloped = object(record) && Object.hasOwn(record, 'content');
  let { content, updatedAt } = enveloped ? record : { content: record, updatedAt: fs.statSync(recordPath).mtime.toISOString() };
  if (!validDate(updatedAt, true)) throw new Error('无法读取站点内容的更新时间');
  // Earlier runtime records may predate the editable project progress field.
  // Add only missing defaults, without replacing any administrator edits.
  if (seedPath && recordPath !== seedPath && Array.isArray(content?.projects) && content.projects.some(p => object(p) && p.progress === undefined)) {
    const defaults = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const progress = new Map((defaults.content || defaults).projects.map(p => [p.repo.toLowerCase(), p.progress]));
    content.projects = content.projects.map(p => {
      const fallback = validRepo(p?.repo) ? progress.get(p.repo.toLowerCase()) : undefined;
      return p?.progress === undefined && fallback !== undefined ? { ...p, progress: fallback } : p;
    });
  }
  const errors = validateContent(content);
  if (errors.length) throw new Error(`无法读取站点内容：${errors.join('；')}`);
  const normalized = normalizeMilestoneLabels(withNewsIds(content));
  let needsNormalization = normalized !== content;
  content = withCountdownDefault(normalized);
  let etag = revision(content);
  let queue = Promise.resolve();

  function read(section) {
    if (section && !SECTIONS.includes(section)) throw new ContentError(404, '没有这个分区');
    return { content: structuredClone(section ? content[section] : content), etag, updatedAt };
  }

  function write(proposed, ifMatch, section) {
    const work = queue.then(async () => {
      if (section && !SECTIONS.includes(section)) throw new ContentError(404, '没有这个分区');
      if (!ifMatch) throw new ContentError(428, '请先获取当前版本，再使用 If-Match 保存');
      if (ifMatch !== etag) throw new ContentError(412, '内容已被别人更新。请先获取最新版，再合并你的修改');
      const candidate = section ? { ...content, [section]: proposed } : proposed;
      const details = validateContent(candidate);
      if (details.length) throw new ContentError(422, '有些内容未通过检查', details);
      const compatible = candidate.roadmap === content.roadmap ? candidate : {
        ...candidate, roadmap: mergeCompatibleRoadmap(content.roadmap, candidate.roadmap),
      };
      const next = withCountdownDefault(normalizeMilestoneLabels(withNewsIds(compatible)), content.countdown.enabled);
      const nextRevision = revision(next);
      const changed = nextRevision !== etag;
      if (changed || needsNormalization) {
        const directory = path.dirname(filePath);
        const temp = path.join(directory, `.content-${randomUUID()}.tmp`);
        const savedAt = changed ? new Date(now()).toISOString() : updatedAt;
        try {
          await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
          await fs.promises.writeFile(temp, JSON.stringify({ updatedAt: savedAt, content: next }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          await fs.promises.rename(temp, filePath);
        } catch (err) {
          await fs.promises.unlink(temp).catch(() => {});
          console.error('Content save failed:', err.code || 'write error');
          throw new ContentError(503, '无法写入内容，请检查服务器存储');
        }
        content = next;
        updatedAt = savedAt;
        etag = nextRevision;
        needsNormalization = false;
      }
      return read(section);
    });
    queue = work.catch(() => {});
    return work;
  }
  return { read, write };
}

function revision(content) {
  return '"' + createHash('sha256').update(JSON.stringify(content)).digest('hex') + '"';
}

module.exports = { createContentStore, validateContent, projectPublicContent, projectPrivateRepositories, projectMilestoneLabel, ContentError, SECTIONS, PUBLIC_SECTIONS, TYPES, STATUSES };
