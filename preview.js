'use strict';

const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createFixtures } = require('./fixtures/demo');
const { validateContent, projectPublicContent } = require('./api/_content');
const { resolveLocale, localizeDashboard, localizePublicContent } = require('./api/_content-locale');
const { projectDashboard } = require('./api/preview-dashboard');
const { RSS_PATH, buildNewsFeed } = require('./api/_rss');
const { PUBLIC_ASSETS, PUBLIC_PAGES } = require('./site-assets');

const LOOPBACK = '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};
// The read-only mode keeps the same page and asset paths.
const interactive = /\/(?:feedback|danmaku(?:-mount|-translate)?)\.js|\/danmaku\.css/;
const staticFiles = new Map([
  ...PUBLIC_PAGES,
  ...Array.from(PUBLIC_ASSETS, route => [route, route.slice(1)])
    .filter(([route]) => !interactive.test(route) && route !== '/assets/traffic.js'),
]);

function previewPage(data, file) {
  let html = data.toString('utf8').split('\n').filter(line => !interactive.test(line)).join('\n')
    .replace('/assets/traffic.js', '/assets/demo.js')
    .replace('data-i18n="pages.home.trafficMode">本地', 'data-i18n="pages.home.sampleTrafficMode">样例')
    .replace('data-i18n="pages.home.traffic">访问统计 · 本地', 'data-i18n="pages.home.sampleTraffic">访问统计 · 示例');
  if (file === 'feedback.html') {
    html = html.replace(/<main\b[^]*?<\/main>/, [
      '<main id="content" class="demo-info content-width" tabindex="-1">',
      '  <section class="demo-info-panel" aria-labelledby="feedbackTitle">',
      '    <h1 id="feedbackTitle" data-i18n="pages.shared.feedback">反馈说明</h1>',
      '    <p data-i18n="pages.feedback.previewNote">本地站点模式提供反馈表单。</p>',
      '    <a class="text-link" href="/" data-i18n="pages.shared.backHome">返回首页</a>',
      '  </section>',
      '</main>',
    ].join('\n'));
  }
  return html;
}

const headers = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
};

function respond(request, response, status, body = '', extra = {}) {
  response.writeHead(status, { ...headers, ...extra });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function sendContent(request, response, text, mime, locale) {
  const length = Buffer.byteLength(text);
  const hash = createHash('sha256');
  if (locale) hash.update(locale + '\0');
  const etag = '"' + hash.update(text).digest('base64url') + '"';
  const variant = { ETag: etag, ...(locale && { 'Content-Language': locale }) };
  if (request.headers['if-none-match'] === etag) {
    respond(request, response, 304, '', variant);
    return;
  }
  respond(request, response, 200, text, { ...variant, 'Content-Type': mime, 'Content-Length': length });
}

function createDemoServer({ now = Date.now() } = {}) {
  const { content, metadata, history, traffic, trafficHistory, localizedSponsors } = createFixtures(now);
  const errors = validateContent(content);
  if (errors.length) throw new Error(`Invalid demo fixture: ${JSON.stringify(errors)}`);
  const version = content;
  const updatedAt = new Date(now).toISOString();
  const dashboard = projectDashboard(version, { metadata, generatedAt: updatedAt, history });
  const publicContent = projectPublicContent(version);
  const localizedRoutes = new Map(['zh-CN', 'en', 'ja'].map(locale => [locale, new Map([
    ['/api/content', JSON.stringify({ content: localizePublicContent(publicContent, locale), updatedAt })],
    ['/api/dashboard', JSON.stringify(localizeDashboard(dashboard, locale))],
    ['/api/sponsors', JSON.stringify({ sponsors: localizedSponsors(locale) })],
  ])]));
  const jsonRoutes = new Map([
    ['/api/traffic', traffic],
    ['/api/traffic/history', trafficHistory],
  ].map(([route, data]) => [route, JSON.stringify(data)]));

  const server = http.createServer(async (request, response) => {
    try {
      const { port } = server.address();
      const host = request.headers.host;
      if (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`) {
        respond(request, response, 400, 'Use the loopback address shown at startup.');
        return;
      }
      const origin = `http://${host}`;
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) {
        respond(request, response, 400, 'Invalid request path.');
        return;
      }
      const { pathname, search, searchParams } = new URL(request.url, origin);
      const locale = resolveLocale(searchParams.get('lang'));
      const localized = localizedRoutes.get(locale);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        respond(request, response, 405, 'This demo provides read-only routes.', { Allow: 'GET, HEAD' });
        return;
      }
      if (pathname === '/favicon.ico') {
        respond(request, response, 204);
      } else if (pathname === '/thanks' || pathname === '/feedback' || pathname === '/about') {
        respond(request, response, 308, '', { Location: pathname + '/' + search });
      } else if (localized.has(pathname)) {
        sendContent(request, response, localized.get(pathname), 'application/json; charset=utf-8', locale);
      } else if (jsonRoutes.has(pathname)) {
        sendContent(request, response, jsonRoutes.get(pathname), 'application/json; charset=utf-8');
      } else if (pathname === '/api/traffic/events') {
        respond(request, response, 200, `data: ${JSON.stringify(traffic)}\n\n`, {
          'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
        });
      } else if (pathname === RSS_PATH) {
        sendContent(request, response, buildNewsFeed(dashboard.timeline, origin, locale), 'application/rss+xml; charset=utf-8', locale);
      } else if (staticFiles.has(pathname)) {
        const file = staticFiles.get(pathname);
        const raw = await readFile(path.join(__dirname, file));
        const data = file.endsWith('.html') ? previewPage(raw, file) : raw;
        sendContent(request, response, data, MIME[path.extname(file)]);
      } else {
        respond(request, response, 404, 'Not found.');
      }
    } catch {
      if (!response.headersSent) respond(request, response, 500, 'Demo request failed.');
      else response.destroy();
    }
  });
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const server = createDemoServer();
  server.listen(port, LOOPBACK, () => console.log(`GTAVI demo · http://${LOOPBACK}:${server.address().port}`));
}

module.exports = { createDemoServer };
