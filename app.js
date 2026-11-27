/* ============================================================
   GTA6 PC PORT TRACKER — front-end controller
   Fetches /api/dashboard and renders the project archive, news and port progress.
   ============================================================ */
(function () {
  'use strict';

  const t = (key, fallback, params) => window.SiteI18n?.t?.(key, fallback, params) ??
    (params ? fallback.replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(params, name) ? params[name] : token) : fallback);
  const localizedUrl = url => window.SiteI18n?.url?.(url) ?? url;
  const locale = window.SiteI18n?.locale || 'zh-CN';

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    data: null,
    projectsExpanded: false,
    timelineExpanded: false,
    loading: false,
  };

  var DASHBOARD_POLL_MS = 180_000;

  /* ---------------- fetch ---------------- */
  async function fetchData() {
    if (state.loading) return;
    state.loading = true;
    try {
      var url = '/api/dashboard?_=' + Date.now();
      var res = await fetch(window.SiteI18n?.withLocale?.(url) ?? url, {
        headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      var json = await res.json();
      if (!json || !Array.isArray(json.projects)) throw new Error(t('home.archive.invalidResponse', '响应格式无效'));
      state.data = json;
      renderAll();
    } catch (err) {
      console.warn('Dashboard data could not be loaded.', err);
      if (!state.data) showLoadFailure();
    } finally {
      state.loading = false;
    }
  }

  /* ---------------- render ---------------- */
  function renderAll() {
    var d = state.data;
    setEmptyStateCopy(false);
    renderCards();
    renderTimeline(d.timeline || []);
    // Port progress block: delegate to site-content.js renderer exposed on window
    if (typeof window.renderPortProgress === 'function') {
      window.renderPortProgress(d);
    }
  }

  function formatNum(n) { return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n); }

  var typeLabels = { runner: '运行器与兼容层', tool: '工具', resource: '配套资源', adjacent: '其他平台参考' };
  var statusLabels = { progress: '活跃开发中', early: '早期或停滞', tool: '不运行游戏的工具', reference: '仅供参考' };

  var PROJECT_PREVIEW_LIMIT = 3;
  var EXTERNAL_PROGRESS_KEY = Symbol('external-progress');
  var LEGACY_EXTERNAL_KEY = Symbol('legacy-external-progress');
  var renderedCards = null;
  var appearedFills = new WeakSet();
  var emptyOpenDetails = { progress: new Set(), evidence: new Set(), portProgress: new Set() };
  var previousFills = new Map();
  var resultsMotion = null;
  var reduceMotion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function cancelResultsMotion() {
    if (!resultsMotion) return;
    if (resultsMotion.entry) resultsMotion.entry.cancel();
    if (resultsMotion.exit) resultsMotion.exit.cancel();
    if (resultsMotion.layer) resultsMotion.layer.remove();
    resultsMotion = null;
  }

  function captureResultsExit(outgoing, removed) {
    var rect = outgoing.getBoundingClientRect();
    var top = removed[0].getBoundingClientRect().top;
    var root = document.documentElement;
    // Only keep the visible portion of the outgoing view; especially useful for tall grids.
    var clipX = Math.max(rect.left, 0);
    var clipY = Math.max(top, 0);
    var clipRight = Math.min(rect.right, root.clientWidth);
    var clipBottom = Math.min(rect.bottom, root.clientHeight);
    if (clipRight <= clipX || clipBottom <= clipY) return null;

    // This is only a visual echo: move the old cards off the live grid without cloning images.
    var layer = document.createElement('div');
    layer.setAttribute('aria-hidden', 'true');
    layer.inert = true;
    Object.assign(layer.style, {
      position: 'absolute', left: (clipX + window.scrollX) + 'px', top: (clipY + window.scrollY) + 'px',
      width: (clipRight - clipX) + 'px', height: (clipBottom - clipY) + 'px', overflow: 'hidden',
      pointerEvents: 'none', zIndex: '1',
    });
    var view = outgoing.cloneNode(false);
    view.removeAttribute('id');
    Object.assign(view.style, {
      position: 'absolute', left: (rect.left - clipX) + 'px', top: (top - clipY) + 'px',
      width: rect.width + 'px', margin: '0',
    });
    view.append.apply(view, removed);
    layer.appendChild(view);
    // Keep the visual layer inside the dashboard's scoped styles.
    $('dashboard').appendChild(layer);
    return layer;
  }

  function animateResults(incoming, layer) {
    var exit = null;
    if (layer) {
      exit = layer.firstElementChild.animate([
        { opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-5px)' },
      ], { duration: 90, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
    }
    var entry = incoming && incoming.animate([
      { opacity: 0.55, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 160, easing: 'cubic-bezier(.2,.75,.25,1)' });
    var motion = { entry: entry, exit: exit, layer: layer };
    resultsMotion = motion;
    (entry || exit).onfinish = function () {
      if (resultsMotion === motion) cancelResultsMotion();
    };
  }

  function syncProjectsToggle(toggle, canExpand, matchCount) {
    toggle.hidden = !canExpand;
    toggle.setAttribute('aria-expanded', canExpand && state.projectsExpanded ? 'true' : 'false');
    if (!canExpand) return;
    var label = controlLabel(toggle, '#projectsToggleLabel');
    var text = state.projectsExpanded ? t('home.archive.collapse', '收起项目') :
      t('home.archive.expand', '再看 {count} 个项目', { count: Math.max(0, matchCount - PROJECT_PREVIEW_LIMIT) });
    if (label.textContent !== text) label.textContent = text;
  }

  function archiveCardKey(card) {
    return card.dataset.archiveKey || (card.dataset.externalProgress !== undefined ? EXTERNAL_PROGRESS_KEY : card.dataset.repo);
  }

  function projectAnchorId(repo) {
    var value = typeof repo === 'string' ? repo.trim().toLowerCase() : '';
    if (!value) return '';
    var slug = value.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug ? 'project-' + slug : '';
  }

  function privateRepositoryAnchor(item) {
    var slug;
    if (item && typeof item === 'object' && typeof item.slug === 'string') {
      slug = item.slug.trim().toLowerCase();
    } else {
      slug = typeof item === 'string' ? item : item && item.id;
      slug = typeof slug === 'string' ? slug.trim().toLowerCase().replace(/^private-repo-/, '') : '';
    }
    slug = slug.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug ? 'private-repo-' + slug : '';
  }

  function scrollToArchiveAnchor(id, focus) {
    var card = id ? document.getElementById(id) : null;
    if (!card) return false;
    if (window.history && window.history.replaceState) window.history.replaceState(null, '', '#' + id);
    var behavior = reduceMotion && reduceMotion.matches ? 'instant' : 'smooth';
    card.scrollIntoView({ block: 'start', behavior: behavior });
    if (focus) {
      var target = card.querySelector('.card-repo, .card-external-source');
      if (target) {
        target.focus({ preventScroll: true });
        window.setTimeout(function () {
          var current = document.getElementById(id);
          var next = current && current.querySelector('.card-repo, .card-external-source');
          if (next) next.focus({ preventScroll: true });
        }, 0);
      }
    }
    return true;
  }

  function scrollToProjectCard(repo, focus) {
    return scrollToArchiveAnchor(projectAnchorId(repo), focus);
  }

  function focusProjectArchive(repo) {
    if (!state.data || typeof repo !== 'string') return false;
    var id = projectAnchorId(repo);
    if (!state.projectsExpanded && !document.getElementById(id)) {
      state.projectsExpanded = true;
      renderCards(true);
    }
    return scrollToProjectCard(repo, true);
  }

  function focusCommunityBuild() {
    if (state.data && !state.projectsExpanded && !document.getElementById('community-build')) {
      state.projectsExpanded = true;
      renderCards(true);
    }
    return scrollToArchiveAnchor('community-build', true);
  }

  function focusPrivateRepository(item) {
    var id = privateRepositoryAnchor(item);
    if (!id) return false;
    if (state.data && !state.projectsExpanded && !document.getElementById(id)) {
      state.projectsExpanded = true;
      renderCards(true);
    }
    return scrollToArchiveAnchor(id, true);
  }

  function rememberCardFills(card) {
    var widths = new Map();
    card.querySelectorAll('.progress-motion-fill').forEach(function (fill) {
      var closed = fill.closest('details:not([open])');
      if (closed && !appearedFills.has(fill) && !fill.classList.contains('progress-motion-static')) return;
      var target = fill.style.getPropertyValue('--w');
      var trackWidth = fill.parentElement.getBoundingClientRect().width;
      var width = trackWidth && !closed
        ? (fill.getBoundingClientRect().width / trackWidth * 100) + '%' : target;
      widths.set(fill.dataset.progressKey, { width: width, target: target });
    });
    if (widths.size) previousFills.set(archiveCardKey(card), widths);
  }

  function restoreCardFills(card) {
    var widths = previousFills.get(archiveCardKey(card));
    if (widths) card.querySelectorAll('.progress-motion-fill').forEach(function (fill) {
      var from = widths.get(fill.dataset.progressKey);
      if (!from) return;
      var target = fill.style.getPropertyValue('--w');
      fill.style.setProperty('--progress-from', target === from.target ? target : from.width);
      fill.classList.add('progress-motion-static');
    });
  }

  function cardOpenDetails(card, repo) {
    return {
      progress: new Set(card.querySelector('.card-progress-details[open]') ? [repo] : []),
      evidence: new Set(card.querySelector('.card-evidence-details[open]') ? [repo] : []),
      portProgress: new Set(card.querySelector('.card-port-details[open]') ? [repo] : []),
    };
  }

  function renderCards(interactive) {
    var d = state.data;
    if (!d) return;
    var ranked = new Map((Array.isArray(d.progress?.ranked) ? d.progress.ranked : []).map(function (item, index) {
      return [item && item.id, { score: Number(item && item.score), index: index }];
    }));
    var order = 0;
    function scoreFor(id, project) {
      var api = ranked.get(id);
      if (api && Number.isFinite(api.score)) return api.score;
      return portScoreLib && project && project.portProgress && project.status !== 'reference'
        ? portScoreLib.scoreProject(project).score : -1;
    }
    function entryOrder(id) {
      var api = ranked.get(id);
      return api ? api.index : order++;
    }
    function compare(a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.order - b.order;
    }
    var list = (Array.isArray(d.projects) ? d.projects : []).map(function (project) {
      return { key: project.repo, project: project, score: scoreFor(project.id || project.repo, project), order: entryOrder(project.id || project.repo) };
    });
    var privateInput = Array.isArray(d.privateRepositories) ? d.privateRepositories :
      (d.privateRepositories === undefined && d.communityBuild ? [Object.assign({}, d.communityBuild, { legacyCommunity: true })] : []);
    var privateKeys = new Set();
    privateInput.forEach(function (item) {
      var privateCard = readPrivateRepository(item);
      if (!privateCard || privateKeys.has(privateCard.key)) return;
      privateKeys.add(privateCard.key);
      list.push({
        key: privateCard.key,
        external: privateCard,
        score: scoreFor(privateCard.id, privateCard),
        order: entryOrder(privateCard.id),
      });
    });
    list.sort(compare);
    var external = readExternalProgress(d.externalProgress);
    if (external) list.unshift({ key: LEGACY_EXTERNAL_KEY, external: Object.assign({}, external, { legacyExternal: true }), score: -Infinity, order: -1 });

    var info = $('resultsInfo');
    var grid = $('cardsGrid');
    var empty = $('emptyState');
    var toggle = $('projectsToggle');
    var canExpand = Boolean(toggle) && list.length > PROJECT_PREVIEW_LIMIT;
    var shown = canExpand && !state.projectsExpanded ? list.slice(0, PROJECT_PREVIEW_LIMIT) : list;
    var summary = t('home.archive.count', '显示 {shown} / {total} 个项目', { shown: shown.length, total: list.length });
    if (info.textContent !== summary) info.textContent = summary;

    var active = document.activeElement;
    if (toggle) {
      syncProjectsToggle(toggle, canExpand, list.length);
      if (!canExpand && active === toggle) info.focus({ preventScroll: true });
    }
    var statuses = d.statuses || {};
    var markup = new Map(shown.map(function (entry) {
      var html = entry.external ? externalCardHtml(entry.external, false, d.progress) : cardHtml(entry.project, statuses, emptyOpenDetails, d.progress);
      return [entry.key, html];
    }));
    var firstRender = !renderedCards;
    var existing = new Map(firstRender ? [] : Array.from(grid.children, function (card) {
      return [archiveCardKey(card), card];
    }));
    var removed = Array.from(existing.values()).filter(function (card) { return !markup.has(archiveCardKey(card)); });
    var shouldAnimate = reduceMotion && !reduceMotion.matches && typeof grid.animate === 'function';
    var layer = null;
    if (interactive) cancelResultsMotion();
    existing.forEach(function (card, key) {
      if (markup.get(key) !== renderedCards.get(key)) rememberCardFills(card);
    });

    if (!existing.size && !previousFills.size) {
      grid.innerHTML = Array.from(markup.values()).join('');
    } else {
      var focusedCard = grid.contains(active) ? active.closest('.card[data-repo], .card[data-external-progress]') : null;
      var focusedControl = focusedCard && ['.card-progress-toggle', '.card-evidence-toggle', '.card-evidence-link',
        '.card-port-details > summary', '.card-repo', '.card-link', '.card-external-source'].find(function (selector) {
        return active.matches(selector);
      });
      var focusedHref = focusedControl ? active.getAttribute('href') : null;
      var template = document.createElement('template');
      var revealIndex = 0;
      var nextCards = new Map();
      shown.forEach(function (entry) {
        var key = entry.key;
        var html = markup.get(key);
        var previous = existing.get(key);
        var card = previous;
        if (!previous || renderedCards.get(key) !== html) {
          var open = previous ? cardOpenDetails(previous, key) : emptyOpenDetails;
          template.innerHTML = entry.external ? externalCardHtml(entry.external, open.portProgress.has(key), d.progress) :
            (open.progress.size || open.evidence.size || open.portProgress.size ? cardHtml(entry.project, statuses, open, d.progress) : html);
          card = template.content.firstElementChild;
          restoreCardFills(card);
          if (previous) previous.replaceWith(card);
          else if (shouldAnimate && (interactive || key === EXTERNAL_PROGRESS_KEY)) {
            card.classList.add('card-revealing');
            card.style.setProperty('--i', String(revealIndex++));
          }
        }
        nextCards.set(key, card);
      });
      var exiting = interactive ? removed : removed.filter(function (card) { return archiveCardKey(card) === EXTERNAL_PROGRESS_KEY; });
      if (shouldAnimate && exiting.length && 'inert' in grid) {
        if (!interactive) cancelResultsMotion();
        layer = captureResultsExit(grid, exiting);
      }
      removed.forEach(function (card) { if (card.parentNode === grid) card.remove(); });
      var before = null;
      Array.from(nextCards.values()).reverse().forEach(function (card) {
        if (card.parentNode !== grid || card.nextElementSibling !== before) {
          if (card.parentNode === grid && typeof grid.moveBefore === 'function') grid.moveBefore(card, before);
          else grid.insertBefore(card, before);
        }
        before = card;
      });
      if (focusedCard && document.activeElement !== active) {
        var nextCard = nextCards.get(archiveCardKey(focusedCard));
        if (nextCard) focusCardControl(nextCard, focusedControl, focusedHref);
        else info.focus({ preventScroll: true });
      }
    }
    renderedCards = markup;
    empty.hidden = shown.length > 0;
    if (shouldAnimate && (firstRender || layer)) animateResults(firstRender ? (shown.length ? grid : empty) : null, layer);
  }

  function focusCardControl(card, selector, href) {
    var matches = selector ? card.querySelectorAll(selector) : [];
    var target = href && Array.prototype.find.call(matches, function (el) { return el.getAttribute('href') === href; });
    (target || matches[0] || card.querySelector('.card-repo, .card-external-source')).focus({ preventScroll: true });
  }

  function octicon(name) {
    var sprite = document.body.dataset.octicons || '/assets/ui/octicons.svg';
    return '<svg class="ui-icon octicon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<use href="' + escapeAttr(sprite + '#' + name) + '"></use></svg>';
  }

  function statLabel(icon, label) {
    return octicon(icon) + '<span class="sr-only">' + escapeHtml(t('home.label', '{label}：', { label: label })) + '</span>';
  }

  function progressCopy(progress, open) {
    var text = escapeHtml(progress || t('home.archive.noProgress', '暂无进展记录。'));
    if (progress.length <= 80) return '<p class="card-progress-text">' + text + '</p>';
    return '<p class="card-progress-text card-progress-preview">' + text + '</p>' +
      '<details class="card-progress-details"' + (open ? ' open' : '') + '>' +
        '<summary class="card-progress-toggle">' + escapeHtml(t('home.archive.fullProgress', '完整进展')) + '</summary>' +
        '<p class="card-progress-text">' + text + '</p>' +
      '</details>';
  }

  var evidenceLevels = {
    unverified: '待核实',
    'self-reported': '自述/未独立验证',
    demonstrated: '有公开演示',
    reproduced: '已独立复测',
  };

  var portScoreLib = window.PortScore;
  var GROUNDWORK_DEFS = portScoreLib ? portScoreLib.GROUNDWORK : [];

  function portMilestones(progress) {
    var labels = progress && progress.labels && typeof progress.labels === 'object' ? progress.labels : {};
    var source = progress && Array.isArray(progress.milestones) && progress.milestones.length
      ? progress.milestones : (portScoreLib && Array.isArray(portScoreLib.MILESTONES) ? portScoreLib.MILESTONES : []);
    var result = [];
    var seen = new Set();
    source.slice(0, 16).forEach(function (item, index) {
      var key = item && typeof item.key === 'string' ? item.key.trim() : (item && typeof item.id === 'string' ? item.id.trim() : '');
      if (!key || seen.has(key)) return;
      var label = item && typeof item.label === 'string' && item.label.trim() ? item.label.trim() :
        (typeof labels[key] === 'string' && labels[key].trim() ? labels[key].trim() : key);
      var at = Number.isFinite(Number(item && item.at)) ? Math.min(100, Math.max(0, Number(item.at))) :
        (source.length > 1 ? index / (source.length - 1) * 100 : 0);
      seen.add(key);
      result.push({ key: key, label: label, at: at });
    });
    var rendered = result.some(function (item) { return /render|渲染/i.test(item.key) || /render|渲染/i.test(item.label); });
    if (!rendered) {
      var before = result.find(function (item) { return item.key === 'ingame'; });
      var after = result.find(function (item) { return item.key === 'fps30' || /30/.test(item.key); });
      if (before && after && after.at > before.at) {
        result.push({ key: 'rendered', label: '完全渲染', at: before.at + (after.at - before.at) / 2 });
        result.sort(function (a, b) { return a.at - b.at; });
      }
    }
    return result.map(function (item) {
      return { key: item.key, label: builtinMilestoneLabel(item.key, item.label), at: item.at };
    });
  }

  function builtinMilestoneLabel(key, label) {
    // Older dashboards can still use these built-in names during a rolling update.
    if (key === 'menu' && label === '主菜单') return t('home.port.stage.mainMenu', label);
    if (key === 'stable' && label === '稳定游玩') return t('home.port.stage.stableGameplay', label);
    if (key === 'stable' && label === '完整可玩') return t('home.port.stage.stable', label);
    if (key === 'stable' && label === '画面与帧率达标') return t('home.port.stage.qualityTarget', label);
    var builtin = key === 'rendered' ? '完全渲染' : portScoreLib?.MILESTONES?.find(function (item) { return item.key === key; })?.label;
    // API and editorial labels take precedence over the built-in labels.
    return builtin && (label === builtin || label === key) ? t('home.port.stage.' + key, label) : label;
  }

  function factorText(value, fallback) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (var key of ['label', 'status', 'text', 'value']) {
        if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
        if (typeof value[key] === 'number' && Number.isFinite(value[key])) return String(value[key]);
      }
    }
    return fallback;
  }

  var cardStabilityLabels = {
    unknown: '待核实', constant: '频繁崩溃', often: '经常崩溃',
    sometimes: '偶尔崩溃', rarely: '很少崩溃', stable: '稳定',
  };

  function cardFactorRows(rows) {
    return '<div class="card-port-factors" aria-label="' + escapeAttr(t('home.port.factors', '项目进度说明')) + '">' + rows.map(function (row) {
      return '<div class="card-port-factor"><span>' + escapeHtml(row[0]) + '</span><b>' + escapeHtml(row[1]) + '</b></div>';
    }).join('') + '</div>';
  }

  function cardPortFactors(pp, scored, version) {
    if (version === 5) {
      if (scored.reached !== 'prison' && scored.reached !== 'stable') return '';
      var verified = scored.factors || {};
      var number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
      var outOf100 = function (value, pending) {
        return typeof value === 'number' && Number.isFinite(value) ? number.format(value) + '/100' : pending;
      };
      var benchmark = formatV5Benchmark(scored, number, t);
      var performance = verified.performance;
      var performanceText = benchmark && Number.isFinite(performance) && performance >= 0 && performance <= 100
        ? outOf100(performance) + ' · ' + benchmark : t('home.port.factor.benchmarkPending', '参考机待测');
      return cardFactorRows([
        [t('home.port.factor.renderingScore', '画面分'), outOf100(verified.rendering, t('home.port.factor.renderingPending', '画面待核实'))],
        [t('home.port.factor.performanceScore', '帧率分'), performanceText],
        [t('home.port.factor.stability', '稳定性'), outOf100(verified.stability, t('home.status.unknown', '待核实'))],
      ]);
    }
    var gta = pp && pp.gta && typeof pp.gta === 'object' ? pp.gta : {};
    var factors = pp && (pp.factors || pp.factorSummary) && typeof (pp.factors || pp.factorSummary) === 'object'
      ? (pp.factors || pp.factorSummary) : {};
    var unknown = t('home.status.unknown', '待核实');
    var rendered = typeof gta.rendered === 'number' && Number.isFinite(gta.rendered)
      ? Math.round(Math.min(1, Math.max(0, gta.rendered)) * 100) + '%'
      : gta.rendered === true ? t('home.port.stage.rendered', '完全渲染') : unknown;
    var stability = factorText(factors.stability, factorText(gta.stability, 'unknown'));
    var stabilityLabel = ownValue(cardStabilityLabels, stability);
    var rows = [
      [t('home.port.factor.performance', '性能'), factorText(factors.performance || factors.fps, typeof gta.fps === 'number' ? gta.fps + ' FPS' : unknown)],
      [t('home.port.factor.rendering', '渲染'), factorText(factors.rendering || factors.render, rendered)],
      [t('home.port.factor.stability', '稳定性'), stabilityLabel ? t('home.port.stability.' + stability, stabilityLabel) : stability],
      [t('home.port.factor.completeness', '完整性'), factorText(factors.completeness || factors.integrity, factorText(pp.completeness, unknown))],
    ];
    var hasSource = Object.keys(factors).length || Object.keys(gta).length || pp.completeness !== undefined;
    return hasSource ? cardFactorRows(rows) : '';
  }

  function cardPortProgress(p, open, progress) {
    if (!portScoreLib || !p.portProgress) return '';
    var scored = portScoreLib.scoreProject(p);
    var score = scored.score;
    var milestones = portMilestones(progress);
    var ticks = milestones.slice(1).map(function (m) {
      return '<i style="left:' + m.at + '%"></i>';
    }).join('');
    var reachedIndex = milestones.findIndex(function (m) { return m.key === scored.reached; });
    var reachedLabel = milestones[reachedIndex]?.label || builtinMilestoneLabel(scored.reached, scored.reachedLabel);
    var labels = milestones.map(function (m, index) {
      var mobileKey = index === 0 || index === milestones.length - 1 || m.key === 'ingame';
      return '<div class="ppl-item' + (index <= reachedIndex ? ' is-reached' : '') +
        (mobileKey ? ' is-mobile-key' : '') + '" style="left:' + m.at + '%">' +
        '<b class="ppl-percent">' + m.at + '%</b><span class="ppl-dot"></span>' +
        '<span class="ppl-label">' + escapeHtml(m.label) + '</span></div>';
    }).join('');
    var gw = p.portProgress.groundwork;
    var gwRows = '';
    if (gw) {
      gwRows = '<div class="card-port-gw-rows">' + GROUNDWORK_DEFS.map(function (g) {
        var v = typeof gw[g.key] === 'number' ? Math.min(1, Math.max(0, gw[g.key])) : 0;
        var pct = Math.round(v * 100);
        return '<div class="card-port-gw-row">' +
          '<span>' + escapeHtml(t('home.port.groundwork.' + g.key, g.label)) + '</span><b>' + pct + '%</b>' +
          '<div class="card-port-gw-bar"><i class="progress-motion-fill" data-progress-key="' + g.key + '" style="--w:' + pct + '%"></i></div>' +
          '</div>';
      }).join('') + '</div>';
    }
    var pp = p.portProgress;
    var factors = cardPortFactors(pp, scored, progress?.modelVersion ?? portScoreLib.MODEL_VERSION);
    var works = Array.isArray(pp.works) && pp.works.length
      ? '<div class="card-port-works"><p class="card-port-works-title">' + escapeHtml(t('home.port.works', '已经能做到')) + '</p><ul>' +
        pp.works.slice(0, 6).map(function (w) { return '<li>' + escapeHtml(w) + '</li>'; }).join('') +
        '</ul></div>' : '';
    var blocking = Array.isArray(pp.blocking) && pp.blocking.length
      ? '<div class="card-port-blocking"><p class="card-port-blocking-title">' + escapeHtml(t('home.port.blockers', '卡在哪里')) + '</p><ul>' +
        pp.blocking.slice(0, 6).map(function (b) { return '<li>' + escapeHtml(b) + '</li>'; }).join('') +
        '</ul></div>' : '';
    var verLabels = { verified: '已独立复测', 'self-reported': '自述/未验证', unverified: '待核实' };
    var verCls = { verified: 'card-port-verified', 'self-reported': 'card-port-self', unverified: 'card-port-unverified' };
    var ver = pp.verification ? ownValue(verLabels, pp.verification) : '';
    var verTag = ver ? '<span class="' + (ownValue(verCls, pp.verification) || '') + '">' +
      escapeHtml(t('home.port.verification.' + pp.verification, ver)) + '</span>' : '';
    var assessed = pp.assessedAt ? '<span>' + escapeHtml(t('home.port.assessed', '评估于 {date}', { date: assessmentDate(pp.assessedAt) })) + '</span>' : '';
    var meta = (verTag || assessed) ? '<div class="card-port-meta">' + verTag + assessed + '</div>' : '';
    var hasDetails = gwRows || works || blocking || meta;
    return '<div class="card-port-progress">' +
      '<div class="card-port-score-row">' +
        '<span class="card-port-score-num">' + score.toFixed(1) + '<small>%</small></span>' +
        '<span class="card-port-score-milestone">' + escapeHtml(reachedLabel) + '</span>' +
      '</div>' +
      '<div class="card-port-track" role="img" aria-label="' + escapeAttr(t('home.port.score', '移植进度 {score}%', { score: score.toFixed(1) })) + '">' +
        '<div class="card-port-fill progress-motion-fill" data-progress-key="score" style="--w:' + score + '%"></div>' +
        '<div class="card-port-ticks">' + ticks + '</div>' +
      '</div>' +
      '<div class="card-port-labels port-progress-labels">' + labels + '</div>' +
      factors +
      (hasDetails
        ? '<details class="card-port-details"' + (open ? ' open' : '') + '><summary>' + escapeHtml(t('home.port.details', '详情')) + '</summary>' + gwRows + works + blocking + meta + '</details>'
        : '') +
    '</div>';
  }

  function evidenceLevel(evidence) {
    if (!evidence) return '';
    if (!ownValue(evidenceLevels, evidence.level)) return '';
    var level = evidence.level !== 'unverified' && !safeHttpsUrl(evidence.sourceUrl) ? 'unverified' : evidence.level;
    return t('home.evidence.' + level, evidenceLevels[level]);
  }

  function evidenceTag(evidence) {
    var level = evidenceLevel(evidence);
    if (!level) return '';
    if (locale === 'zh-CN') return '<p class="card-evidence-tag">证据：' + escapeHtml(level) + '</p>';
    return '<p class="card-evidence-tag">' + escapeHtml(t('home.evidence.label', '证据：{level}', { level: level })) + '</p>';
  }

  function evidenceCopy(evidence, open) {
    if (!evidence) return '';
    var tested = plainText(evidence.tested);
    var sourceUrl = safeHttpsUrl(evidence.sourceUrl);
    if (!tested || !evidenceLevel(evidence)) return '';

    // The level is shown once, in the 证据 tag beside the progress header.
    var line = escapeHtml(tested);
    var blocker = plainText(evidence.blocker);
    if (!blocker && !sourceUrl) return '<p class="card-evidence">' + line + '</p>';
    return '<details class="card-evidence card-evidence-details"' + (open ? ' open' : '') + '>' +
      '<summary class="card-evidence-toggle">' + line + '</summary>' +
      '<div class="card-evidence-body">' +
        (blocker ? '<p>' + escapeHtml(t('home.evidence.limitation', '限制：{text}', { text: blocker })) + '</p>' : '') +
        (sourceUrl ? '<a class="card-evidence-link" href="' + escapeAttr(localizedUrl(sourceUrl)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(t('home.source.view', '查看来源')) + '</a>' : '') +
      '</div>' +
    '</details>';
  }
  function cardHtml(p, statusMap, open, progress) {
    var title = plainText(p.title) || String(p.repo || '').split('/').pop() || t('home.archive.untitled', '未命名项目');
    var summary = plainText(p.summary) || t('home.archive.noSummary', '暂无简明介绍，详情请查看原仓库。');
    var type = ownValue(typeLabels, p.type);
    type = type ? t('home.archive.type.' + p.type, type) : p.typeLabel || p.type || t('home.archive.noType', '类型未标注');
    var status = ownValue(statusLabels, p.status);
    status = status ? t('home.archive.status.' + p.status, status) : p.statusLabel || (ownValue(statusMap, p.status) || {}).label || p.status || t('home.archive.noStatus', '状态未标注');
    var url = escapeAttr(localizedUrl(safeHttpsUrl(p.url)));
    var gh = p.github || {};
    var stars = gh.stars != null ? formatNum(gh.stars) : '—';
    var forks = gh.forks != null ? formatNum(gh.forks) : '—';
    var issues = gh.openIssues != null ? gh.openIssues : '—';
    var pushed = gh.pushedAt ? relativeTime(gh.pushedAt) : (p.daysSincePush != null ? timeAgo(p.daysSincePush, 'day', '天') : '—');
    var fallbackIcon = '<svg class="ui-icon card-logo card-logo-fallback" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<use href="/assets/ui/fluent.svg#document"></use></svg>';
    var anchorId = projectAnchorId(p.repo);
    return '<article class="card"' + (anchorId ? ' id="' + escapeAttr(anchorId) + '" data-project-anchor="' + escapeAttr(anchorId) + '"' : '') + ' data-repo="' + escapeAttr(p.repo) + '">' +
      '<div class="card-identity">' + fallbackIcon +
        (url ? '<a class="card-repo" href="' + url + '" target="_blank" rel="noopener">' + escapeHtml(p.repo) + '</a>' :
          '<span class="card-repo" tabindex="-1">' + escapeHtml(p.repo) + '</span>') +
      '</div>' +
      '<h3 class="card-title">' + escapeHtml(title) + '</h3>' +
      '<p class="card-summary card-block">' + escapeHtml(summary) + '</p>' +
      cardPortProgress(p, open.portProgress.has(p.repo), progress) +
      '<div class="card-progress">' +
        '<div class="card-progress-header">' +
          '<h4 class="card-progress-label">' + escapeHtml(t('home.archive.latestProgress', '最新进展')) + '</h4>' +
          '<span class="status-badge" style="background:' + safeColor(p.statusColor) + '"><span class="dot" aria-hidden="true"></span>' + escapeHtml(status) + '</span>' +
        '</div>' +
        evidenceTag(p.evidence) +
        progressCopy(plainText(p.progress), open.progress.has(p.repo)) +
        evidenceCopy(p.evidence, open.evidence.has(p.repo)) +
      '</div>' +
      '<footer class="card-foot">' +
        '<div class="card-stats">' +
          '<span class="stat star">' + statLabel('star-16', t('home.archive.stat.stars', '星标')) + '<b>' + escapeHtml(stars) + '</b></span>' +
          '<span class="stat">' + statLabel('repo-forked-16', t('home.archive.stat.forks', '复刻')) + '<b>' + escapeHtml(forks) + '</b></span>' +
          '<span class="stat">' + statLabel('issue-opened-16', t('home.archive.stat.issues', '未关闭议题')) + '<b>' + escapeHtml(issues) + '</b></span>' +
          '<span class="stat">' + statLabel('clock-16', t('home.archive.stat.lastPush', '最近推送')) + '<b>' + escapeHtml(pushed) + '</b></span>' +
        '</div>' +
        '<span class="card-type">' + escapeHtml(type) + '</span>' +
        (url ? '<a class="card-link" href="' + url + '" target="_blank" rel="noopener">' + octicon('eye-16') + escapeHtml(t('home.archive.viewRepo', '查看仓库')) + '</a>' : '') +
      '</footer>' +
    '</article>';
  }

  function readPrivateRepository(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    var id = typeof item.id === 'string' && /^private-repo-[a-z0-9][a-z0-9-]*$/i.test(item.id.trim())
      ? item.id.trim() : '';
    var anchorId = item.legacyCommunity ? 'community-build' : privateRepositoryAnchor(item);
    if (!id && item.legacyCommunity) id = 'community-build';
    var title = plainText(item.title);
    var summary = plainText(item.summary);
    var sourceLabel = plainText(item.sourceLabel);
    var sourceUrl = safeHttpsUrl(item.sourceUrl);
    if (!id || !anchorId || !title || !summary || !sourceLabel || !sourceUrl || !item.portProgress || typeof item.portProgress !== 'object') return null;
    var score = portScoreLib ? portScoreLib.scoreProject(item).score : null;
    if (!Number.isFinite(score)) return null;
    return {
      id: id,
      key: id,
      anchorId: anchorId,
      title: title,
      summary: summary,
      sourceLabel: sourceLabel,
      sourceUrl: sourceUrl,
      score: score,
      build: item,
      portProgress: item.portProgress,
      status: item.status || 'progress',
      privateRepository: !item.legacyCommunity,
      legacyCommunity: Boolean(item.legacyCommunity),
    };
  }

  function readExternalProgress(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    var title = plainText(item.title);
    var summary = plainText(item.summary);
    var sourceLabel = plainText(item.sourceLabel);
    var sourceUrl = safeHttpsUrl(item.sourceUrl);
    var score = item.score;
    if (!title || !summary || !sourceLabel || !sourceUrl || !Number.isFinite(score) || score < 0 || score > 100) return null;
    return { title: title, score: score, summary: summary, sourceLabel: sourceLabel, sourceUrl: sourceUrl };
  }

  function externalCardHtml(progress, open = false, progressScale) {
    var title = escapeHtml(progress.title);
    var score = String(progress.score);
    var label = progress.privateRepository ? t('home.archive.privateRepo', '私有仓库') :
      progress.legacyCommunity ? t('home.archive.communityBuild', '社区构建') : t('home.archive.externalAssessment', '外部评估');
    var anchor = progress.anchorId ? ' id="' + escapeAttr(progress.anchorId) + '" data-project-anchor="' + escapeAttr(progress.anchorId) + '"' : '';
    var archiveKey = progress.key ? ' data-archive-key="' + escapeAttr(progress.key) + '"' : '';
    var progressBar = progress.build ? cardPortProgress(progress.build, open, progressScale) :
      '<div class="card-port-progress">' +
        '<div class="card-port-score-row" aria-hidden="true"><span class="card-port-score-num">' + score + '<small>%</small></span></div>' +
        '<div class="card-port-track" role="progressbar" aria-label="' + escapeAttr(t('home.archive.externalProgress', '{title} 进度', { title: progress.title })) + '"' +
          ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + score + '">' +
          '<div class="card-port-fill progress-motion-fill" data-progress-key="score" style="--w:' + score + '%"></div>' +
        '</div>' +
      '</div>';
    return '<article class="card card-external' + (progress.privateRepository ? ' card-private-repository' : '') + '"' + anchor + archiveKey + ' data-external-progress>' +
      '<p class="card-external-label">' + escapeHtml(label) + '</p>' +
      '<h3 class="card-title">' + title + '</h3>' +
      '<p class="card-summary card-block">' + escapeHtml(progress.summary) + '</p>' +
      progressBar +
      '<a class="text-link card-external-source" href="' + escapeAttr(localizedUrl(progress.sourceUrl)) + '" target="_blank" rel="noopener noreferrer">' +
        '<span>' + escapeHtml(t('home.archive.runSource', '运行记录 · {source}', { source: progress.sourceLabel })) + '</span>' +
        '<svg class="ui-icon" aria-hidden="true"><use href="/assets/ui/fluent.svg#arrow-up-right"></use></svg>' +
      '</a>' +
    '</article>';
  }

  var timelineDateTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });

  var timelineLocalDay = locale === 'zh-CN' ? null : new Intl.DateTimeFormat(locale, {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  });

  function assessmentDate(value) {
    if (!timelineLocalDay || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    var date = new Date(value);
    return isNaN(date.getTime()) ? value : timelineLocalDay.format(date);
  }

  function timelineDateHtml(value) {
    var recorded = String(value == null ? '' : value).trim();
    var day = '', minute = '', datetime = '';
    var iso = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(recorded);
    if (iso) {
      var date = new Date(iso[1]);
      if (!isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso[1]) day = datetime = iso[1];

      var timestamp = iso[2] && new Date(recorded.replace(' ', 'T') + (iso[3] ? '' : '+08:00'));
      if (day && timestamp && !isNaN(timestamp.getTime())) {
        if (iso[3]) {
          var parts = {};
          timelineDateTime.formatToParts(timestamp).forEach(function (part) { parts[part.type] = part.value; });
          day = parts.year + '-' + parts.month + '-' + parts.day;
          minute = parts.hour + ':' + parts.minute;
        } else {
          // An unzoned timestamp records a wall time, not a viewer-local instant.
          minute = iso[2];
        }
        datetime = recorded;
      }
    }

    if (day && timelineLocalDay) day = timelineLocalDay.format(new Date(day + 'T00:00:00+08:00'));
    var content = '<strong class="tl-date-day">' + escapeHtml(day || t('home.date.missing', '日期未记录')) + '</strong> ' +
      '<span class="tl-time">' + escapeHtml(minute || t('home.time.missing', '时间未记录')) + '</span>';
    return datetime ? '<time class="tl-date" datetime="' + escapeAttr(datetime) + '">' + content + '</time>'
      : '<span class="tl-date">' + content + '</span>';
  }

  var TIMELINE_PREVIEW_LIMIT = 6;
  var timelineHtml = null;
  var pendingNewsId = '';
  var initialLayoutReady = !window.PortInitialLayout;
  var newsNavigationFrame = 0;
  var highlightedNews = null;

  function newsAnchorId(slug) {
    return typeof slug === 'string' && /^[a-z0-9-]{1,64}$/.test(slug) ? 'news-' + slug : '';
  }

  function newsIdFromHash(hash) {
    return hash.startsWith('#news-') ? newsAnchorId(hash.slice(6)) : '';
  }

  function newsRow(id) {
    var row = id && $(id);
    return row && row.parentElement === $('timelineList') ? row : null;
  }

  function outsideTimelinePreview(row) {
    return row && Array.prototype.indexOf.call(row.parentElement.children, row) >= TIMELINE_PREVIEW_LIMIT;
  }

  function renderTimeline(items) {
    // Retain the existing limit for GitHub updates, and keep every editorial link addressable.
    var ordered = items.slice().sort(function (a, b) {
      return new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
    });
    var list = ordered.filter(function (t, i) { return i < 40 || newsAnchorId(t.id); });
    var ids = new Set();
    var html = list.map(function (item) {
      var kind = item.kind === 'commit' ? 'commit' : (item.kind === 'release' ? 'release' : 'milestone');
      var title = plainText(item.title) || t('home.timeline.untitled', '收录了一条项目动态');
      var url = safeHttpsUrl(item.url);
      var titleHtml = url ? '<a href="' + escapeAttr(localizedUrl(url)) + '" target="_blank" rel="noopener">' + escapeHtml(title) + '</a>' : escapeHtml(title);
      var repo = item.repo ? '<span class="tl-repo">@' + escapeHtml(item.repo) + '</span>' : '';
      var id = newsAnchorId(item.id);
      if (ids.has(id)) id = '';
      if (id) ids.add(id);
      var correction = id && item.correction === true;
      var label = correction ? t('home.timeline.correctedTitle', '更正：{title}', { title: title }) : title;
      var anchor = id ? ' id="' + id + '" tabindex="-1" role="group" aria-label="' + escapeAttr(label) + '"' : '';
      return '<div class="timeline-item" data-kind="' + kind + '"' + anchor + '>' +
        timelineDateHtml(item.date) +
        '<div class="tl-title">' + (correction ? '<span class="tl-correction">' + escapeHtml(t('home.timeline.correction', '更正')) + '</span>' : '') + titleHtml + repo + '</div>' +
      '</div>';
    }).join('');
    if (timelineHtml !== html) {
      var container = $('timelineList');
      var active = document.activeElement;
      var focused = container.contains(active) && active.closest('.timeline-item[id]');
      var toggle = $('timelineToggle');
      timelineHtml = html;
      container.innerHTML = html || '<div class="timeline-item"><div class="tl-title">' +
        escapeHtml(t('home.timeline.empty', '暂无时间线数据')) + '</div></div>';
      var restored = focused && newsRow(focused.id);
      if (outsideTimelinePreview(restored)) state.timelineExpanded = true;
      if (toggle) syncTimeline(toggle, list.length);
      if (restored) {
        var control = active.matches('.tl-title a') ? restored.querySelector('.tl-title a') : null;
        (control || restored).focus({ preventScroll: true });
      } else if (focused || (toggle && active === toggle && toggle.hidden)) {
        (toggle && !toggle.hidden ? toggle : $('timeline')).focus({ preventScroll: true });
      }
    }
    scrollToPendingNews();
  }

  function syncTimeline(toggle, total) {
    var shortList = total <= TIMELINE_PREVIEW_LIMIT;
    var expanded = shortList || state.timelineExpanded;
    var list = $('timelineList');
    var active = document.activeElement;
    if (!expanded && list.contains(active) && outsideTimelinePreview(active.closest('.timeline-item'))) {
      toggle.focus({ preventScroll: true });
    }
    list.classList.toggle('expanded', expanded);
    list.classList.toggle('collapsed', !expanded);
    $('timelineWrap').classList.toggle('is-expanded', expanded);
    toggle.hidden = shortList;
    toggle.dataset.total = total;
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.querySelector('.tl-toggle-text').textContent = expanded ? t('home.timeline.collapse', '收起时间线') :
      t('home.timeline.expand', '展开全部 {total} 条', { total: total });
  }

  function syncNewsHighlight() {
    var row = newsRow(newsIdFromHash(window.location.hash));
    if (highlightedNews !== row) {
      if (highlightedNews) highlightedNews.classList.remove('is-news-target');
      if (row) row.classList.add('is-news-target');
      highlightedNews = row;
    }
    return row;
  }

  function followNewsHash() {
    pendingNewsId = newsIdFromHash(window.location.hash);
    scrollToPendingNews();
  }

  function scrollToPendingNews() {
    var target = syncNewsHighlight();
    if (!initialLayoutReady || !target || target.id !== pendingNewsId || newsNavigationFrame) return;
    newsNavigationFrame = window.requestAnimationFrame(function () {
      newsNavigationFrame = 0;
      var row = syncNewsHighlight();
      if (!row || row.id !== pendingNewsId) return;
      pendingNewsId = '';
      if (outsideTimelinePreview(row) && !state.timelineExpanded) {
        state.timelineExpanded = true;
        var toggle = $('timelineToggle');
        if (toggle) syncTimeline(toggle, Number(toggle.dataset.total));
      }
      row.focus({ preventScroll: true });
      var motion = window.PortMotion;
      if (motion && typeof motion.scrollTo === 'function') {
        // Scroll limits can still reflect the skeleton or the six-row preview.
        if (!document.documentElement.classList.contains('menu-open')) motion.resume?.();
        motion.scrollTo(row);
      } else {
        var nav = document.querySelector('.site-topbar');
        window.scrollTo({
          top: row.getBoundingClientRect().top + window.scrollY - (nav ? nav.offsetHeight : 0) - 10,
          behavior: reduceMotion && !reduceMotion.matches ? 'smooth' : 'instant',
        });
      }
    });
  }

  function bindNewsLinks() {
    // Capture only news links so the chapter navigation can keep handling its own anchors.
    document.addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var link = event.target.closest('a[href^="#news-"]');
      if (!link || link.hasAttribute('download') || (link.target && link.target.toLowerCase() !== '_self')) return;
      if (!newsIdFromHash(link.hash)) return;
      event.preventDefault();
      if (window.location.hash !== link.hash) window.history.pushState(null, '', link.hash);
      followNewsHash();
    }, true);
    // Fragment changes from native anchors and history traversal take the same path.
    window.addEventListener('hashchange', followNewsHash);
    document.addEventListener('focusin', function () {
      // Chapter links use pushState without a hashchange and then focus their section.
      if (highlightedNews && '#' + highlightedNews.id !== window.location.hash) syncNewsHighlight();
    });
    // The countdown and progress sections can change the height above a shared news link.
    window.PortInitialLayout?.then(function () {
      initialLayoutReady = true;
      scrollToPendingNews();
    });
    followNewsHash();
  }

  var timeAgoFormatter = locale === 'zh-CN' ? null : new Intl.RelativeTimeFormat(locale);

  function timeAgo(count, unit, chineseUnit) {
    if (!Number.isFinite(Number(count))) return '—';
    return timeAgoFormatter ? timeAgoFormatter.format(-Number(count), unit) : count + chineseUnit + '前';
  }

  function relativeTime(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var d = Math.floor(diff / 86400000);
    if (d <= 0) return t('home.time.today', '今天');
    if (d === 1) return t('home.time.yesterday', '昨天');
    if (d < 30) return timeAgo(d, 'day', '天');
    if (d < 365) return timeAgo(Math.floor(d / 30), 'month', '月');
    return timeAgo(Math.floor(d / 365), 'year', '年');
  }

  /* ---------------- states ---------------- */
  function setEmptyStateCopy(loadFailed) {
    var empty = $('emptyState');
    empty.querySelector('h3').textContent = loadFailed ? t('home.archive.failed', '暂时无法读取项目') : t('home.archive.empty', '暂无项目');
    empty.querySelector('p').textContent = loadFailed ? t('home.archive.retry', '稍后会自动重试。') :
      t('home.archive.emptyNote', '工程档案暂未收录项目。');
  }

  function showLoadFailure() {
    $('cardsGrid').innerHTML = '';
    $('timelineList').innerHTML = '';
    setEmptyStateCopy(true);
    $('emptyState').hidden = false;
    $('resultsInfo').textContent = t('home.archive.failedSummary', '暂时无法读取项目。');
  }

  /* ---------------- utils ---------------- */
  function ownValue(map, key) {
    return map && typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
  }
  function plainText(value) { return typeof value === 'string' ? value.trim() : ''; }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function safeHttpsUrl(value) {
    if (typeof value === 'string' && /^#[a-z0-9][a-z0-9-]*$/i.test(value)) return value;
    if (typeof value !== 'string' || !/^https:\/\//i.test(value) || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return '';
    try {
      var url = new URL(value);
      if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) return value;
    } catch { /* Invalid URLs are rendered as text. */ }
    return '';
  }
  function safeColor(c) { return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#7c3aed'; }
  function controlLabel(control, selector) {
    var label = control.querySelector(selector) || Array.prototype.find.call(control.childNodes, function (node) {
      return node.nodeType === 3 && node.textContent.trim();
    }) || control.querySelector('span:not([aria-hidden="true"])');
    if (!label) {
      label = document.createTextNode('');
      control.prepend(label);
    }
    return label;
  }

  /* ---------------- events ---------------- */
  function bindProjectsToggle() {
    var toggle = $('projectsToggle');
    if (!toggle) return;
    var info = $('resultsInfo');
    toggle.addEventListener('click', function () {
      if (toggle.hidden || !state.data) return;
      state.projectsExpanded = !state.projectsExpanded;
      renderCards(true);
      if (state.projectsExpanded) {
        // The button moves beneath the new cards. Continue at the first one revealed.
        var card = $('cardsGrid').children[PROJECT_PREVIEW_LIMIT];
        var link = card && card.querySelector('.card-repo');
        if (link) {
          link.scrollIntoView({ block: 'nearest', behavior: 'instant' });
          link.focus({ preventScroll: true });
        }
      } else {
        info.scrollIntoView({ block: 'start', behavior: 'instant' });
        info.focus({ preventScroll: true });
      }
    });
  }

  function bindEvents() {
    var grid = $('cardsGrid');
    grid.addEventListener('animationstart', function (e) {
      if (e.animationName === 'progress-motion-shimmer') appearedFills.add(e.target);
    });
    function finishShimmer(e) {
      if (e.animationName !== 'progress-motion-shimmer') return;
      e.target.style.setProperty('--progress-from', e.target.style.getPropertyValue('--w'));
      e.target.classList.add('progress-motion-static');
    }
    grid.addEventListener('animationend', finishShimmer);
    grid.addEventListener('animationcancel', finishShimmer);
    $('emptyState').style.animation = 'none'; // Result replacements use the coordinated motion above.
    bindProjectsToggle();
    if (reduceMotion && reduceMotion.addEventListener) {
      reduceMotion.addEventListener('change', function (e) { if (e.matches) cancelResultsMotion(); });
    }
    document.addEventListener('click', function (event) {
      var link = event.target.closest && event.target.closest('.port-progress-leader-link');
      if (!link || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var href = link.getAttribute('href') || '';
      var handled = href === '#community-build'
        ? focusCommunityBuild()
        : href.indexOf('#private-repo-') === 0
          ? focusPrivateRepository(href.slice(1))
          : href.indexOf('#project-') === 0 ? scrollToArchiveAnchor(href.slice(1), true) : false;
      if (handled) event.preventDefault();
    }, true);
    // 进度时间线：默认收起，点击展开/收起
    var tlToggle = $('timelineToggle');
    if (tlToggle) tlToggle.addEventListener('click', function () {
      if (!tlToggle.dataset.total) return;
      state.timelineExpanded = !state.timelineExpanded;
      syncTimeline(tlToggle, Number(tlToggle.dataset.total));
    });
    bindNewsLinks();
  }

  /* ---------------- init ---------------- */
  function init() {
    window.focusProjectArchive = focusProjectArchive;
    window.focusCommunityBuild = focusCommunityBuild;
    window.focusPrivateRepository = focusPrivateRepository;
    bindEvents();
    window.addEventListener('online', fetchData);
    setInterval(fetchData, DASHBOARD_POLL_MS);
    fetchData();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
