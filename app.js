/* ============================================================
   GTA6 PC PORT TRACKER — front-end controller
   Fetches /api/dashboard and renders the project archive, news and port progress.
   ============================================================ */
(function () {
  'use strict';

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
      var res = await fetch('/api/dashboard?_=' + Date.now(), {
        headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      var json = await res.json();
      if (!json || !Array.isArray(json.projects)) throw new Error('响应格式无效');
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
    var text = state.projectsExpanded ? '收起项目' : '再看 ' + Math.max(0, matchCount - PROJECT_PREVIEW_LIMIT) + ' 个项目';
    if (label.textContent !== text) label.textContent = text;
  }

  function archiveCardKey(card) {
    return card.dataset.privateRepo ?? (card.dataset.externalProgress !== undefined ? EXTERNAL_PROGRESS_KEY : card.dataset.repo);
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
    // Keep API order within ties and for projects without a ranking score.
    var list = d.projects.map(function (project) {
      var score = portScoreLib && project.portProgress && project.status !== 'reference'
        ? portScoreLib.scoreProject(project).score : -1;
      return { key: project.repo, project: project, score: score };
    });
    var community = d.communityBuild;
    if (portScoreLib && community && typeof community === 'object' && community.portProgress) {
      var scored = portScoreLib.scoreProject(community);
      var card = readExternalProgress({ ...community, score: scored.score });
      if (card) list.push({ key: EXTERNAL_PROGRESS_KEY, external: { ...card, build: community }, score: scored.score });
    }
    if (portScoreLib && Array.isArray(d.privateRepositories)) {
      d.privateRepositories.forEach(function (project) {
        if (!project?.portProgress || typeof project.id !== 'string' ||
            !/^private-repo-(?=[a-z0-9-]{1,48}$)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.id)) return;
        var score = portScoreLib.scoreProject(project).score;
        var card = readExternalProgress({ ...project, score: score });
        if (card) list.push({ key: project.id, external: { ...card, build: project, privateId: project.id }, score: score });
      });
    }
    list.sort(function (a, b) { return b.score - a.score; });
    if (!portScoreLib || !community?.portProgress) {
      var external = readExternalProgress(d.externalProgress);
      if (external) list.unshift({ key: EXTERNAL_PROGRESS_KEY, external: external });
    }

    var info = $('resultsInfo');
    var grid = $('cardsGrid');
    var empty = $('emptyState');
    var toggle = $('projectsToggle');
    var canExpand = Boolean(toggle) && list.length > PROJECT_PREVIEW_LIMIT;
    var shown = canExpand && !state.projectsExpanded ? list.slice(0, PROJECT_PREVIEW_LIMIT) : list;
    var summary = '显示 ' + shown.length + ' / ' + list.length + ' 个项目';
    if (info.textContent !== summary) info.textContent = summary;

    var active = document.activeElement;
    if (toggle) {
      syncProjectsToggle(toggle, canExpand, list.length);
      if (!canExpand && active === toggle) info.focus({ preventScroll: true });
    }
    var statuses = d.statuses || {};
    var markup = new Map(shown.map(function (entry) {
      var html = entry.external ? externalCardHtml(entry.external) : cardHtml(entry.project, statuses, emptyOpenDetails);
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
      var focusedCard = grid.contains(active) ? active.closest('.card[data-repo], .card[data-external-progress], .card[data-private-repo]') : null;
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
          template.innerHTML = entry.external ? externalCardHtml(entry.external, open.portProgress.has(key)) :
            (open.progress.size || open.evidence.size || open.portProgress.size ? cardHtml(entry.project, statuses, open) : html);
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
    return octicon(icon) + '<span class="sr-only">' + label + '：</span>';
  }

  function progressCopy(progress, open) {
    var text = escapeHtml(progress || '暂无进展记录。');
    if (progress.length <= 80) return '<p class="card-progress-text">' + text + '</p>';
    return '<p class="card-progress-text card-progress-preview">' + text + '</p>' +
      '<details class="card-progress-details"' + (open ? ' open' : '') + '>' +
        '<summary class="card-progress-toggle">完整进展</summary>' +
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

  function cardPortProgress(p, open) {
    if (!portScoreLib || !p.portProgress) return '';
    var scored = portScoreLib.scoreProject(p);
    var score = scored.score;
    var milestones = portScoreLib.MILESTONES;
    var ticks = milestones.slice(1).map(function (m) {
      return '<i style="left:' + m.at + '%"></i>';
    }).join('');
    var reachedIndex = milestones.findIndex(function (m) { return m.key === scored.reached; });
    var reachedLabel = milestones[reachedIndex]?.label || scored.reachedLabel;
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
          '<span>' + escapeHtml(g.label) + '</span><b>' + pct + '%</b>' +
          '<div class="card-port-gw-bar"><i class="progress-motion-fill" data-progress-key="' + g.key + '" style="--w:' + pct + '%"></i></div>' +
          '</div>';
      }).join('') + '</div>';
    }
    var pp = p.portProgress;
    var works = Array.isArray(pp.works) && pp.works.length
      ? '<div class="card-port-works"><p class="card-port-works-title">已经能做到</p><ul>' +
        pp.works.slice(0, 6).map(function (w) { return '<li>' + escapeHtml(w) + '</li>'; }).join('') +
        '</ul></div>' : '';
    var blocking = Array.isArray(pp.blocking) && pp.blocking.length
      ? '<div class="card-port-blocking"><p class="card-port-blocking-title">卡在哪里</p><ul>' +
        pp.blocking.slice(0, 6).map(function (b) { return '<li>' + escapeHtml(b) + '</li>'; }).join('') +
        '</ul></div>' : '';
    var verLabels = { verified: '已独立复测', 'self-reported': '自述/未验证', unverified: '待核实' };
    var verCls = { verified: 'card-port-verified', 'self-reported': 'card-port-self', unverified: 'card-port-unverified' };
    var ver = pp.verification ? ownValue(verLabels, pp.verification) : '';
    var verTag = ver ? '<span class="' + (ownValue(verCls, pp.verification) || '') + '">' + escapeHtml(ver) + '</span>' : '';
    var assessed = pp.assessedAt ? '<span>评估于 ' + escapeHtml(pp.assessedAt) + '</span>' : '';
    var meta = (verTag || assessed) ? '<div class="card-port-meta">' + verTag + assessed + '</div>' : '';
    var hasDetails = gwRows || works || blocking || meta;
    return '<div class="card-port-progress">' +
      '<div class="card-port-score-row">' +
        '<span class="card-port-score-num">' + score.toFixed(1) + '<small>%</small></span>' +
        '<span class="card-port-score-milestone">' + escapeHtml(reachedLabel) + '</span>' +
      '</div>' +
      '<div class="card-port-track" role="img" aria-label="移植进度 ' + score.toFixed(1) + '%">' +
        '<div class="card-port-fill progress-motion-fill" data-progress-key="score" style="--w:' + score + '%"></div>' +
        '<div class="card-port-ticks">' + ticks + '</div>' +
      '</div>' +
      '<div class="card-port-labels port-progress-labels">' + labels + '</div>' +
      (hasDetails
        ? '<details class="card-port-details"' + (open ? ' open' : '') + '><summary>详情</summary>' + gwRows + works + blocking + meta + '</details>'
        : '') +
    '</div>';
  }

  function evidenceLevel(evidence) {
    if (!evidence) return '';
    var level = ownValue(evidenceLevels, evidence.level);
    if (!level) return '';
    return evidence.level !== 'unverified' && !safeHttpsUrl(evidence.sourceUrl) ? evidenceLevels.unverified : level;
  }

  function evidenceTag(evidence) {
    var level = evidenceLevel(evidence);
    return level ? '<p class="card-evidence-tag">证据：' + escapeHtml(level) + '</p>' : '';
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
        (blocker ? '<p>限制：' + escapeHtml(blocker) + '</p>' : '') +
        (sourceUrl ? '<a class="card-evidence-link" href="' + escapeAttr(sourceUrl) + '" target="_blank" rel="noopener noreferrer">查看来源</a>' : '') +
      '</div>' +
    '</details>';
  }
  function cardHtml(p, statusMap, open) {
    var title = plainText(p.title) || String(p.repo || '').split('/').pop() || '未命名项目';
    var summary = plainText(p.summary) || '暂无简明介绍，详情请查看原仓库。';
    var type = ownValue(typeLabels, p.type) || p.typeLabel || p.type || '类型未标注';
    var status = ownValue(statusLabels, p.status) || p.statusLabel || (ownValue(statusMap, p.status) || {}).label || p.status || '状态未标注';
    var url = escapeAttr(safeHttpsUrl(p.url));
    var gh = p.github || {};
    var stars = gh.stars != null ? formatNum(gh.stars) : '—';
    var forks = gh.forks != null ? formatNum(gh.forks) : '—';
    var issues = gh.openIssues != null ? gh.openIssues : '—';
    var pushed = gh.pushedAt ? relativeTime(gh.pushedAt) : (p.daysSincePush != null ? p.daysSincePush + '天前' : '—');
    var fallbackIcon = '<svg class="ui-icon card-logo card-logo-fallback" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<use href="/assets/ui/fluent.svg#document"></use></svg>';
    return '<article class="card" data-repo="' + escapeAttr(p.repo) + '">' +
      '<div class="card-identity">' + fallbackIcon +
        (url ? '<a class="card-repo" href="' + url + '" target="_blank" rel="noopener">' + escapeHtml(p.repo) + '</a>' :
          '<span class="card-repo" tabindex="-1">' + escapeHtml(p.repo) + '</span>') +
      '</div>' +
      '<h3 class="card-title">' + escapeHtml(title) + '</h3>' +
      '<p class="card-summary card-block">' + escapeHtml(summary) + '</p>' +
      cardPortProgress(p, open.portProgress.has(p.repo)) +
      '<div class="card-progress">' +
        '<div class="card-progress-header">' +
          '<h4 class="card-progress-label">最新进展</h4>' +
          '<span class="status-badge" style="background:' + safeColor(p.statusColor) + '"><span class="dot" aria-hidden="true"></span>' + escapeHtml(status) + '</span>' +
        '</div>' +
        evidenceTag(p.evidence) +
        progressCopy(plainText(p.progress), open.progress.has(p.repo)) +
        evidenceCopy(p.evidence, open.evidence.has(p.repo)) +
      '</div>' +
      '<footer class="card-foot">' +
        '<div class="card-stats">' +
          '<span class="stat star">' + statLabel('star-16', '星标') + '<b>' + escapeHtml(stars) + '</b></span>' +
          '<span class="stat">' + statLabel('repo-forked-16', '复刻') + '<b>' + escapeHtml(forks) + '</b></span>' +
          '<span class="stat">' + statLabel('issue-opened-16', '未关闭议题') + '<b>' + escapeHtml(issues) + '</b></span>' +
          '<span class="stat">' + statLabel('clock-16', '最近推送') + '<b>' + escapeHtml(pushed) + '</b></span>' +
        '</div>' +
        '<span class="card-type">' + escapeHtml(type) + '</span>' +
        (url ? '<a class="card-link" href="' + url + '" target="_blank" rel="noopener">' + octicon('eye-16') + '查看仓库</a>' : '') +
      '</footer>' +
    '</article>';
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

  function externalCardHtml(progress, open = false) {
    var title = escapeHtml(progress.title);
    var score = String(progress.score);
    var identity = progress.privateId ? ' data-private-repo="' + escapeAttr(progress.privateId) + '"' : ' data-external-progress';
    var sourceTarget = progress.sourceUrl.startsWith('#') ? '' : ' target="_blank" rel="noopener noreferrer"';
    var progressBar = progress.build ? cardPortProgress(progress.build, open) :
      '<div class="card-port-progress">' +
        '<div class="card-port-score-row" aria-hidden="true"><span class="card-port-score-num">' + score + '<small>%</small></span></div>' +
        '<div class="card-port-track" role="progressbar" aria-label="' + title + ' 进度"' +
          ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + score + '">' +
          '<div class="card-port-fill progress-motion-fill" data-progress-key="score" style="--w:' + score + '%"></div>' +
        '</div>' +
      '</div>';
    return '<article class="card card-external"' + identity + '>' +
      '<p class="card-external-label">' + (progress.privateId ? '私有仓库' : '社区构建') + '</p>' +
      '<h3 class="card-title">' + title + '</h3>' +
      '<p class="card-summary card-block">' + escapeHtml(progress.summary) + '</p>' +
      progressBar +
      '<a class="text-link card-external-source" href="' + escapeAttr(progress.sourceUrl) + '"' + sourceTarget + '>' +
        '<span>运行记录 · ' + escapeHtml(progress.sourceLabel) + '</span>' +
        '<svg class="ui-icon" aria-hidden="true"><use href="/assets/ui/fluent.svg#arrow-up-right"></use></svg>' +
      '</a>' +
    '</article>';
  }

  var timelineDateTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });

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

    var content = '<strong class="tl-date-day">' + (day || '日期未记录') + '</strong> ' +
      '<span class="tl-time">' + (minute || '时间未记录') + '</span>';
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
    var html = list.map(function (t) {
      var kind = t.kind === 'commit' ? 'commit' : (t.kind === 'release' ? 'release' : 'milestone');
      var title = escapeHtml(plainText(t.title) || '收录了一条项目动态');
      var url = safeHttpsUrl(t.url);
      var titleHtml = url ? '<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener">' + title + '</a>' : title;
      var repo = t.repo ? '<span class="tl-repo">@' + escapeHtml(t.repo) + '</span>' : '';
      var id = newsAnchorId(t.id);
      if (ids.has(id)) id = '';
      if (id) ids.add(id);
      var correction = id && t.correction === true;
      var anchor = id ? ' id="' + id + '" tabindex="-1" role="group" aria-label="' + (correction ? '更正：' : '') + title + '"' : '';
      return '<div class="timeline-item" data-kind="' + kind + '"' + anchor + '>' +
        timelineDateHtml(t.date) +
        '<div class="tl-title">' + (correction ? '<span class="tl-correction">更正</span>' : '') + titleHtml + repo + '</div>' +
      '</div>';
    }).join('');
    if (timelineHtml !== html) {
      var container = $('timelineList');
      var active = document.activeElement;
      var focused = container.contains(active) && active.closest('.timeline-item[id]');
      var toggle = $('timelineToggle');
      timelineHtml = html;
      container.innerHTML = html || '<div class="timeline-item"><div class="tl-title">暂无时间线数据</div></div>';
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
    toggle.querySelector('.tl-toggle-text').textContent = expanded ? '收起时间线' : '展开全部 ' + total + ' 条';
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

  function relativeTime(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var d = Math.floor(diff / 86400000);
    if (d <= 0) return '今天';
    if (d === 1) return '昨天';
    if (d < 30) return d + '天前';
    if (d < 365) return Math.floor(d / 30) + '月前';
    return Math.floor(d / 365) + '年前';
  }

  /* ---------------- states ---------------- */
  function setEmptyStateCopy(loadFailed) {
    var empty = $('emptyState');
    empty.querySelector('h3').textContent = loadFailed ? '暂时无法读取项目' : '暂无项目';
    empty.querySelector('p').textContent = loadFailed ? '稍后会自动重试。' : '工程档案暂未收录项目。';
  }

  function showLoadFailure() {
    $('cardsGrid').innerHTML = '';
    $('timelineList').innerHTML = '';
    setEmptyStateCopy(true);
    $('emptyState').hidden = false;
    $('resultsInfo').textContent = '暂时无法读取项目。';
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
    grid.addEventListener('error', function (e) {
      if (e.target.matches('img.card-logo')) e.target.hidden = true;
    }, true);
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
    bindEvents();
    window.addEventListener('online', fetchData);
    setInterval(fetchData, DASHBOARD_POLL_MS);
    fetchData();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
