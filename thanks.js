(() => {
  'use strict';

  const t = (key, fallback, params) => window.SiteI18n?.t(key, fallback, params) ??
    (params ? fallback.replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token) : fallback);

  const get = id => document.getElementById(id);
  const state = get('sponsorState');
  const list = get('sponsorList');
  const count = get('sponsorCount');
  const retryButton = get('retrySponsors');
  // 头像只接受本站鸣谢接口路径，其他值一律回退为首字
  const avatarPath = /^\/api\/sponsors\/[a-f0-9-]{36}\/avatar$/;

  function setState(value) {
    state.dataset.state = value;
    for (const panel of state.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== value;
    state.hidden = value === 'ready';
    list.hidden = value !== 'ready';
    list.setAttribute('aria-busy', String(value === 'loading'));
  }

  function makeAvatar(avatar, name) {
    const frame = document.createElement('span');
    frame.className = 'roll-avatar';
    frame.setAttribute('aria-hidden', 'true');
    const fallback = document.createElement('span');
    fallback.className = 'roll-avatar-fallback';
    fallback.textContent = [...name][0] || '·';
    frame.append(fallback);
    if (avatarPath.test(avatar)) {
      const image = document.createElement('img');
      image.alt = '';
      image.decoding = 'async';
      image.loading = 'lazy';
      image.width = image.height = 128;
      image.onload = () => { if (image.naturalWidth) frame.classList.add('has-image'); };
      image.onerror = () => image.remove();
      image.src = avatar;
      frame.append(image);
    }
    return frame;
  }

  const nicknameOf = sponsor => typeof sponsor.nickname === 'string' && sponsor.nickname.trim()
    ? sponsor.nickname
    : t('widgets.thanks.unnamed', '未设置昵称');

  function makeEntry(sponsor, index) {
    const name = nicknameOf(sponsor);
    const message = typeof sponsor.message === 'string' ? sponsor.message : '';
    const item = document.createElement('li');
    item.className = 'roll-entry';
    // 入场错峰只覆盖前 24 项，之后同时出现，避免长名单等待过久
    item.style.setProperty('--delay', `${Math.min(index, 24) * 45}ms`);

    const body = document.createElement('div');
    body.className = 'roll-body';
    const title = document.createElement('p');
    title.className = 'roll-name';
    title.textContent = name;
    body.append(title);
    if (message.trim()) {
      const quote = document.createElement('p');
      quote.className = 'roll-message';
      quote.textContent = message;
      body.append(quote);
    }
    item.append(makeAvatar(sponsor.avatar, name), body);
    return item;
  }

  // 首屏星空：赞助者化作带头像的星光。放得下就全员常驻，放不下就轮流闪现
  const sky = (() => {
    const layer = get('thanksSky');
    const hero = layer.parentElement;
    const copy = hero.querySelector('.thanks-hero-copy');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const glows = ['244, 161, 192', '255, 180, 162', '255, 211, 154', '207, 195, 233', '160, 221, 201'];
    let pool = [];
    let queue = [];
    const live = new Map();
    let timers = new Set();
    let capacity = 0;
    let bounds = null;
    let resizeFrame = 0;

    const rand = (min, max) => min + Math.random() * (max - min);
    const later = (fn, ms) => {
      const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
      timers.add(id);
    };
    const cycling = () => !reduced.matches && pool.length > capacity;
    // 正在淡出的星不占名额，接班的星可以提前亮起
    const shining = () => [...live.values()].filter(star => !star.fading).length;

    function measure() {
      const box = layer.getBoundingClientRect();
      const text = copy.getBoundingClientRect();
      const top = 96;
      const bottom = box.height * (box.width < 640 ? .52 : .7);
      // 标题区域左右各留余量，星星不压字
      const avoid = { left: text.left - box.left - 24, right: text.left - box.left + Math.min(text.width, 980) + 24, top: text.top - box.top - 40 };
      const usable = Math.max(0, (box.width - 32) * (Math.min(bottom, avoid.top) - top));
      const cell = box.width < 640 ? 92 : 150;
      bounds = { width: box.width, top, bottom, avoid, small: box.width < 640 };
      capacity = Math.max(3, Math.min(28, Math.floor(usable / (cell * cell))));
      layer.dataset.capacity = String(capacity);
    }

    function freeSpot(size) {
      for (let attempt = 0; attempt < 60; attempt++) {
        const x = rand(size, bounds.width - size);
        const y = rand(bounds.top + size / 2, bounds.bottom - size);
        const inText = y + size > bounds.avoid.top && x + size > bounds.avoid.left && x - size < bounds.avoid.right;
        if (inText) continue;
        let clear = true;
        for (const star of live.values()) {
          if (Math.hypot(star.x - x, star.y - y) < (star.size + size) * 1.15 + 18) { clear = false; break; }
        }
        if (clear) return { x, y };
      }
      return null;
    }

    function nextSponsor() {
      if (!queue.length) queue = pool.slice().sort(() => Math.random() - .5);
      for (let i = 0; i < queue.length; i++) {
        if (!live.has(queue[i].id)) return queue.splice(i, 1)[0];
      }
      return null;
    }

    function spawn() {
      if (shining() >= capacity || document.hidden) return;
      const sponsor = nextSponsor();
      if (!sponsor) return;
      const size = Math.round(bounds.small ? rand(34, 46) : rand(40, 64));
      const spot = freeSpot(size);
      if (!spot) {
        queue.unshift(sponsor);
        later(spawn, 700);
        return;
      }

      const star = document.createElement('div');
      star.className = 'sky-star';
      const style = star.style;
      style.setProperty('--x', `${spot.x}px`);
      style.setProperty('--y', `${spot.y}px`);
      style.setProperty('--size', `${size}px`);
      style.setProperty('--glow', glows[Math.floor(Math.random() * glows.length)]);
      style.setProperty('--twinkle', `${rand(3, 6).toFixed(2)}s`);
      style.setProperty('--phase', `${(-rand(0, 6)).toFixed(2)}s`);
      style.setProperty('--drift', `${rand(10, 18).toFixed(1)}s`);
      style.setProperty('--dx', `${rand(-10, 10).toFixed(1)}px`);
      style.setProperty('--dy', `${rand(-10, 10).toFixed(1)}px`);

      const face = document.createElement('span');
      face.className = 'sky-star-face';
      const initial = document.createElement('span');
      initial.textContent = [...sponsor.name][0] || '·';
      face.append(initial);
      if (avatarPath.test(sponsor.avatar)) {
        const image = document.createElement('img');
        image.alt = '';
        image.decoding = 'async';
        image.onerror = () => image.remove();
        image.src = sponsor.avatar;
        face.append(image);
      }
      const name = document.createElement('span');
      name.className = 'sky-star-name';
      name.textContent = sponsor.name;
      star.append(face, name);
      layer.append(star);
      live.set(sponsor.id, { el: star, x: spot.x, y: spot.y, size });
      requestAnimationFrame(() => requestAnimationFrame(() => star.classList.add('is-lit')));

      if (cycling()) later(() => fade(sponsor.id), rand(5200, 10500));
    }

    function fade(id) {
      const star = live.get(id);
      if (!star) return;
      // 悬停查看昵称时先不走，稍后再试
      if (star.el.matches(':hover')) { later(() => fade(id), 1500); return; }
      star.fading = true;
      star.el.classList.add('is-fading');
      later(spawn, rand(200, 900));
      later(() => {
        star.el.remove();
        live.delete(id);
      }, 1200);
    }

    function clear() {
      for (const id of timers) clearTimeout(id);
      timers = new Set();
      for (const star of live.values()) star.el.remove();
      live.clear();
    }

    function heartbeat() {
      if (cycling() && !document.hidden && shining() < capacity) spawn();
      later(heartbeat, 1600);
    }

    function start() {
      clear();
      if (!pool.length) return;
      measure();
      if (!reduced.matches) later(heartbeat, 2400);
      const count = Math.min(capacity, pool.length);
      for (let i = 0; i < count; i++) {
        if (reduced.matches) spawn();
        else later(spawn, i * rand(120, 260));
      }
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && cycling()) for (let i = live.size; i < capacity; i++) later(spawn, rand(100, 900));
    });
    window.addEventListener('resize', () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        const before = bounds && bounds.width;
        measure();
        if (Math.abs(layer.getBoundingClientRect().width - before) > 40) start();
      });
    });
    reduced.addEventListener?.('change', start);

    return {
      show(sponsors) {
        pool = sponsors.map(item => ({ id: item.id, name: item.name, avatar: item.avatar }));
        queue = [];
        start();
      },
    };
  })();

  async function loadSponsors() {
    const fromRetry = document.activeElement === retryButton;
    setState('loading');
    count.textContent = '';
    try {
      const response = await fetch(window.SiteI18n?.url('/api/sponsors') ?? '/api/sponsors', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Sponsor list unavailable');
      const { sponsors } = await response.json();
      if (!Array.isArray(sponsors)) throw new Error('Invalid sponsor response');
      const entries = sponsors.filter(item => item && typeof item.id === 'string');
      list.replaceChildren(...entries.map(makeEntry));
      sky.show(entries.map(item => ({
        id: item.id,
        name: nicknameOf(item),
        avatar: item.avatar,
      })));
      count.textContent = entries.length === 1 ? t('widgets.thanks.countOne', '共 1 位')
        : entries.length ? t('widgets.thanks.count', '共 {count} 位', { count: entries.length }) : '';
      setState(entries.length ? 'ready' : 'empty');
    } catch {
      list.replaceChildren();
      setState('error');
      if (fromRetry) retryButton.focus();
    }
  }

  retryButton.addEventListener('click', loadSponsors);
  loadSponsors();
})();
