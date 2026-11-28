'use strict';

const PUBLIC_ASSETS = new Set([
  '/app.js', '/styles.css', '/thanks.css', '/thanks.js',
  '/assets/about.css', '/assets/chapters.css', '/assets/dashboard.css',
  '/assets/danmaku-mount.js', '/assets/danmaku-translate.js', '/assets/danmaku.css', '/assets/danmaku.js',
  '/assets/demo.css', '/assets/demo.js', '/assets/feedback.css', '/assets/feedback.js',
  '/assets/i18n.css', '/assets/i18n.js', '/assets/i18n-pages.js', '/assets/i18n-home.js', '/assets/i18n-widgets.js',
  '/assets/hardware-check.css', '/assets/hardware-check.js', '/assets/i18n-hardware-check.js',
  '/assets/hero-opening.css', '/assets/motion.js', '/assets/navigation.js', '/assets/port-score.js',
  '/assets/progress-motion.css', '/assets/project-progress.js', '/assets/site-content.js',
  '/assets/site-scrollbars.css', '/assets/site-scrollbars.js', '/assets/site-topbar.css', '/assets/site-widgets.css',
  '/assets/traffic-history.js', '/assets/traffic.js',
  '/assets/vendor/lenis.min.js', '/assets/vendor/overlayscrollbars-2.17.0.min.css', '/assets/vendor/overlayscrollbars-2.17.0.min.js',
  '/assets/ui/fluent.svg', '/assets/ui/octicons.svg',
  '/assets/ui/barlow-400-latin.woff2', '/assets/ui/barlow-700-latin.woff2',
  '/assets/ui/barlow-condensed-700-latin.woff2', '/assets/ui/barlow-condensed-900-latin.woff2',
]);
const PUBLIC_PAGES = new Map([
  ['/', 'index.html'], ['/index.html', 'index.html'],
  ['/can-i-run', 'hardware-check.html'], ['/can-i-run/', 'hardware-check.html'],
  ['/about', 'about.html'], ['/about/', 'about.html'], ['/about.html', 'about.html'],
  ['/thanks', 'thanks.html'], ['/thanks/', 'thanks.html'], ['/thanks.html', 'thanks.html'],
  ['/feedback', 'feedback.html'], ['/feedback/', 'feedback.html'], ['/feedback.html', 'feedback.html'],
]);
const PAGE_SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
});

module.exports = { PUBLIC_ASSETS, PUBLIC_PAGES, PAGE_SECURITY_HEADERS };
