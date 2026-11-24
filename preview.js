'use strict';

const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createFixtures } = require('./fixtures/demo');
const { validateContent, projectPublicContent } = require('./api/_content');
const { projectDashboard } = require('./api/preview-dashboard');
const { RSS_PATH, buildNewsFeed } = require('./api/_rss');

const LOOPBACK = '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};
const assets = [
  'app.js', 'styles.css', 'thanks.css', 'thanks.js',
  'assets/about.css', 'assets/chapters.css', 'assets/dashboard.css', 'assets/demo.css', 'assets/demo.js',
  'assets/hero-opening.css', 'assets/motion.js', 'assets/navigation.js',
  'assets/port-score.js', 'assets/progress-motion.css', 'assets/project-progress.js', 'assets/site-content.js',
  'assets/site-topbar.css', 'assets/site-widgets.css', 'assets/traffic-history.js', 'assets/vendor/lenis.min.js',
  'assets/ui/fluent.svg', 'assets/ui/octicons.svg', 'assets/ui/barlow-400-latin.woff2',
  'assets/ui/barlow-700-latin.woff2', 'assets/ui/barlow-condensed-700-latin.woff2', 'assets/ui/barlow-condensed-900-latin.woff2',
];
const staticFiles = new Map(assets.map(file => [`/${file}`, file]));
for (const [route, file] of [
  ['/', 'index.html'], ['/about/', 'about.html'], ['/about.html', 'about.html'], ['/index.html', 'index.html'], ['/thanks/', 'thanks.html'], ['/thanks.html', 'thanks.html'],
  ['/feedback/', 'feedback.html'], ['/feedback.html', 'feedback.html'],
]) staticFiles.set(route, file);

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

function sendContent(request, response, text, mime) {
  const length = Buffer.byteLength(text);
  const etag = `"${createHash('sha256').update(text).digest('base64url')}"`;
  if (request.headers['if-none-match'] === etag) {
    respond(request, response, 304, '', { ETag: etag });
    return;
  }
  respond(request, response, 200, text, { 'Content-Type': mime, 'Content-Length': length, ETag: etag });
}

function createDemoServer({ now = Date.now() } = {}) {
  const { content, metadata, history, traffic, trafficHistory, sponsors } = createFixtures(now);
  const errors = validateContent(content);
  if (errors.length) throw new Error(`Invalid demo fixture: ${JSON.stringify(errors)}`);
  const version = content;
  const updatedAt = new Date(now).toISOString();
  const dashboard = projectDashboard(version, { metadata, generatedAt: updatedAt, history });
  const jsonRoutes = new Map([
    ['/api/content', { content: projectPublicContent(version), updatedAt }],
    ['/api/dashboard', dashboard],
    ['/api/sponsors', { sponsors }],
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
      const { pathname } = new URL(request.url, origin);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        respond(request, response, 405, 'This demo provides read-only routes.', { Allow: 'GET, HEAD' });
        return;
      }
      if (pathname === '/favicon.ico') {
        respond(request, response, 204);
      } else if (pathname === '/thanks' || pathname === '/feedback' || pathname === '/about') {
        respond(request, response, 308, '', { Location: `${pathname}/` });
      } else if (jsonRoutes.has(pathname)) {
        sendContent(request, response, jsonRoutes.get(pathname), 'application/json; charset=utf-8');
      } else if (pathname === '/api/traffic/events') {
        respond(request, response, 200, `data: ${JSON.stringify(traffic)}\n\n`, {
          'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
        });
      } else if (pathname === RSS_PATH) {
        sendContent(request, response, buildNewsFeed(dashboard.timeline, origin), 'application/rss+xml; charset=utf-8');
      } else if (pathname === '/feedback/' || pathname === '/feedback.html') {
        sendContent(request, response, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>反馈说明</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/assets/demo.css"><main class="demo-info content-width"><section class="demo-info-panel"><h1 id="feedbackTitle">反馈说明</h1><p>本地站点模式提供反馈表单。</p><a class="text-link" href="/">返回首页</a></section></main></html>', 'text/html; charset=utf-8');
      } else if (staticFiles.has(pathname)) {
        const file = staticFiles.get(pathname);
        let data = await readFile(path.join(__dirname, file));
        if (file.endsWith('.html')) {
          data = data.toString('utf8')
            .replace(/^.*(?:<script[^>]*\/(?:feedback|danmaku|danmaku-mount)\.js|<link[^>]*\/(?:feedback|danmaku)\.css).*(?:\n|$)/gm, '')
            .replace('/assets/traffic.js', '/assets/demo.js')
            .replace('class="demo-traffic-label">本地', 'class="demo-traffic-label">样例')
            .replace('访问统计 · 本地', '访问统计 · 示例');
        }
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
