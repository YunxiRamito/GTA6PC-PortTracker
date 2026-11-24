(() => {
  'use strict';

  const motion = window.matchMedia('(prefers-reduced-motion: no-preference)');
  const wheel = window.matchMedia('(hover: hover) and (pointer: fine)');
  const desktopPoster = window.matchMedia('(min-width: 761px)');
  const poster = document.getElementById('posterShot');
  const groups = [...document.querySelectorAll('[data-reveal]')];
  const root = document.documentElement;
  let observer, lenis;
  let frame = 0;
  let posterHeight = 0;
  let lastProgress = -1;
  let paused = false;

  const hasDesktopMotion = () => motion.matches && wheel.matches && desktopPoster.matches;
  function syncPoster() {
    if (!hasDesktopMotion()) clearPosterPaint();
    else if (posterHeight) queuePaint();
  }

  const reveal = group => {
    group.classList.add('is-visible');
    observer?.unobserve(group);
  };

  function paint() {
    frame = 0;
    if (!posterHeight || !hasDesktopMotion()) return;
    const progress = Math.min(Math.max(0, window.scrollY - 12) / posterHeight, 1);
    if (progress === lastProgress) return;
    lastProgress = progress;
    poster.style.setProperty('--poster-opacity', Math.max(.23, 1 - progress * .77).toFixed(3));
    poster.style.setProperty('--poster-offset', `${Math.round(progress * 42)}px`);
    poster.style.setProperty('--poster-scale', (1 - progress * .09).toFixed(4));
  }

  function queuePaint() {
    if (!frame && hasDesktopMotion()) frame = window.requestAnimationFrame(paint);
  }

  function measure() {
    posterHeight = poster.offsetHeight;
    queuePaint();
  }

  function syncWheel() {
    if (!motion.matches || !wheel.matches) {
      lenis?.destroy();
      lenis = undefined;
      return;
    }
    if (lenis || typeof window.Lenis !== 'function') return;
    lenis = new window.Lenis({
      autoRaf: true,
      smoothWheel: true,
      syncTouch: false,
      lerp: .075,
      wheelMultiplier: 1.08,
      // navigation.js owns hash history, focus, and fixed-header offsets.
      anchors: false,
    });
    if (paused || root.classList.contains('menu-open')) lenis.stop();
  }

  function start() {
    if (window.IntersectionObserver) {
      observer = new IntersectionObserver(entries => {
        for (const { isIntersecting, target } of entries) if (isIntersecting) reveal(target);
      }, { rootMargin: '0px 0px -20px 0px', threshold: 0 });
      for (const group of groups) if (!group.classList.contains('is-visible')) observer.observe(group);
      root.classList.add('has-reveals');
    }
    if (poster) {
      window.addEventListener('scroll', queuePaint, { passive: true });
      window.addEventListener('resize', measure, { passive: true });
      measure();
    }
    syncWheel();
  }

  function clearPosterPaint() {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    lastProgress = -1;
    for (const variable of ['--poster-opacity', '--poster-offset', '--poster-scale']) poster?.style.removeProperty(variable);
  }

  function stop() {
    root.classList.remove('has-reveals');
    observer?.disconnect();
    observer = undefined;
    window.removeEventListener('scroll', queuePaint);
    window.removeEventListener('resize', measure);
    syncPoster();
    syncWheel();
  }

  const navHeight = () => (document.querySelector('.site-nav')?.offsetHeight || 43) + 10;
  function scrollTo(target) {
    if (paused || root.classList.contains('menu-open')) return;
    const offset = target.id === 'top' ? 0 : -navHeight();
    if (lenis) lenis.scrollTo(target, { offset });
    else window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY + offset, behavior: 'instant' });
  }
  window.PortMotion = {
    scrollTo,
    pause() {
      paused = true;
      lenis?.stop();
    },
    resume() {
      if (root.classList.contains('menu-open')) return;
      paused = false;
      lenis?.start();
      lenis?.resize();
    },
  };

  document.addEventListener('focusin', event => {
    const group = event.target.closest?.('[data-reveal]');
    if (group) reveal(group);
  });
  motion.addEventListener('change', ({ matches }) => matches ? start() : stop());
  wheel.addEventListener('change', () => { syncPoster(); syncWheel(); });
  desktopPoster.addEventListener('change', syncPoster);
  if (motion.matches) {
    start();
  }
})();
