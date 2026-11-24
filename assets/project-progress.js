(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProjectGameplayProgress = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  // Repository gameplay track: one segment per roadmap milestone, coloured by that segment's own record.
  const DEFAULT_SCALE = Object.freeze([
    { id: 'boot', label: '启动游戏' },
    { id: 'main-menu', label: '进入主菜单' },
    { id: 'map', label: '进入地图' },
    { id: 'audio', label: '加载声音' },
    { id: 'prologue', label: '进入序章' },
    { id: 'playable', label: '稳定游玩' },
  ].map(Object.freeze));
  const STATUS_LABELS = {
    unknown: '待核实',
    reported: '自述/未独立验证',
    completed: '已核实',
    blocked: '受阻',
  };
  const RECORD_STATUSES = new Set(['reported', 'completed', 'blocked']);
  const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  function own(object, key) {
    return object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
  }

  function text(value, maximum) {
    if (typeof value !== 'string' || value.includes('\0')) return '';
    const trimmed = value.trim();
    return trimmed && value.length <= maximum ? trimmed : '';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Character scan instead of a regex keeps this file free of escape sequences.
  function safeSource(value) {
    if (typeof value !== 'string' || value.length > 2048) return '';
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 32 || code === 127 || code === 92) return '';
    }
    if (value.slice(0, 8).toLowerCase() !== 'https://') return '';
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) return value;
    } catch (_) { /* Invalid sources are never linked. */ }
    return '';
  }

  function normalizeScale(scale) {
    const result = [];
    const seen = new Set();
    for (const item of Array.isArray(scale) ? scale.slice(0, 12) : []) {
      const id = own(item, 'id') && typeof item.id === 'string' ? item.id : '';
      const label = own(item, 'label') ? text(item.label, 24) : '';
      if (!id || id.length > 48 || !ID_PATTERN.test(id) || !label || seen.has(id)) continue;
      seen.add(id);
      result.push({ id: id, label: label });
    }
    return result.length ? result : DEFAULT_SCALE.map(function (stage) { return { id: stage.id, label: stage.label }; });
  }

  function scaleSignature(scale) {
    return JSON.stringify(normalizeScale(scale).map(function (stage) { return [stage.id, stage.label]; }));
  }

  function normalize(gameplay, scale) {
    const stages = normalizeScale(scale);
    const known = new Set(stages.map(function (stage) { return stage.id; }));
    const notApplicable = own(gameplay, 'notApplicable') ? text(gameplay.notApplicable, 40) : '';
    const records = new Map();
    const list = own(gameplay, 'milestones') && Array.isArray(gameplay.milestones) ? gameplay.milestones.slice(0, 12) : [];
    if (!notApplicable) {
      for (const item of list) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
        const id = typeof item.id === 'string' ? item.id : '';
        // Unknown stages are ignored; the first record for a stage wins.
        if (!known.has(id) || records.has(id) || !RECORD_STATUSES.has(item.status)) continue;
        const evidence = text(item.evidence, 160);
        const sourceUrl = safeSource(item.sourceUrl);
        const valid = Boolean(evidence && sourceUrl);
        records.set(id, {
          claimed: item.status,
          status: valid ? item.status : 'unknown',
          evidence: evidence,
          testedOn: text(item.testedOn, 60),
          sourceUrl: sourceUrl,
          downgraded: !valid,
        });
      }
    }
    const result = stages.map(function (stage) {
      const record = records.get(stage.id);
      return Object.assign({ id: stage.id, label: stage.label, status: 'unknown', recorded: false }, record ? Object.assign({ recorded: true }, record) : {});
    });
    let farthest = null;
    for (const stage of result) if (stage.recorded && !stage.downgraded) farthest = stage;
    return { notApplicable: notApplicable, stages: result, farthest: farthest };
  }

  function renderTrack(gameplay, scale) {
    const model = normalize(gameplay, scale);
    if (model.notApplicable) {
      return '<div class="card-gameplay is-not-applicable"><p class="card-gameplay-summary">不适用：' + escapeHtml(model.notApplicable) + '</p></div>';
    }
    const spoken = model.stages.map(function (stage) { return stage.label + '：' + STATUS_LABELS[stage.status]; }).join('；');
    const label = '仓库游戏里程碑。' + spoken + '。各段只按本段记录着色，不是完成率。';
    const segments = model.stages.map(function (stage) {
      return '<span class="card-gameplay-segment is-' + stage.status + '"></span>';
    }).join('');
    const summary = model.farthest
      ? '最远记录：' + escapeHtml(model.farthest.label) + ' · <span class="card-gameplay-state is-' + model.farthest.status + '">' + STATUS_LABELS[model.farthest.status] + '</span>'
      : '待核实';
    return '<div class="card-gameplay">' +
      '<div class="card-gameplay-track" role="img" aria-label="' + escapeHtml(label) + '">' + segments + '</div>' +
      '<p class="card-gameplay-summary">' + summary + '</p>' +
    '</div>';
  }

  function renderDetails(gameplay, scale, open) {
    const model = normalize(gameplay, scale);
    const recorded = model.stages.filter(function (stage) { return stage.recorded; });
    if (model.notApplicable || !recorded.length) return '';
    const items = recorded.map(function (stage) {
      const claimed = STATUS_LABELS[stage.claimed];
      return '<li class="card-gameplay-record is-' + stage.status + '">' +
        '<p class="card-gameplay-record-head"><b>' + escapeHtml(stage.label) + '</b> <span class="card-gameplay-state is-' + stage.status + '">' + STATUS_LABELS[stage.status] + '</span></p>' +
        (stage.testedOn ? '<p>测试对象：' + escapeHtml(stage.testedOn) + '</p>' : '') +
        (stage.evidence ? '<p>' + escapeHtml(stage.evidence) + '</p>' : '') +
        (stage.downgraded ? '<p class="card-gameplay-caution">原标记为“' + claimed + '”，缺少证据或 HTTPS 来源，已降为待核实。</p>' : '') +
        (stage.sourceUrl ? '<a class="card-gameplay-link" href="' + escapeHtml(stage.sourceUrl) + '" target="_blank" rel="noopener noreferrer">查看来源</a>' : '') +
      '</li>';
    }).join('');
    return '<details class="card-evidence card-gameplay-details"' + (open ? ' open' : '') + '>' +
      '<summary class="card-gameplay-toggle">里程碑依据</summary>' +
      '<div class="card-evidence-body"><ol class="card-gameplay-records">' + items + '</ol></div>' +
    '</details>';
  }

  return {
    DEFAULT_SCALE: DEFAULT_SCALE,
    STATUS_LABELS: STATUS_LABELS,
    normalizeScale: normalizeScale,
    scaleSignature: scaleSignature,
    normalize: normalize,
    renderTrack: renderTrack,
    renderDetails: renderDetails,
  };
});
