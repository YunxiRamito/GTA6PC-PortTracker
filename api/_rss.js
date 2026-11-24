'use strict';

const { createHash } = require('node:crypto');

const RSS_PATH = '/rss.xml';
const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function xml(value) {
  return String(value ?? '')
    .replace(/[^\x09\x0a\x0d\x20-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replace(/[&<>"']/g, char => XML_ENTITIES[char]);
}

function itemLink(value, fallback) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* Items without a source still link to the public timeline. */ }
  return fallback;
}

function buildNewsFeed(timeline, origin) {
  const page = new URL('/#timeline', origin).href;
  const self = new URL(RSS_PATH, origin).href;
  const seen = new Set();
  const items = [];
  for (const { title, repo, date, kind, url } of timeline) {
    const guid = createHash('sha256').update(JSON.stringify([kind, repo, date, title, kind === 'milestone' ? '' : url])).digest('hex');
    if (seen.has(guid)) continue;
    seen.add(guid);
    const dateOnly = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
    const timestamp = !dateOnly && date ? new Date(date) : null;
    const description = [dateOnly ? date : '', repo ? `@${repo}` : '社区新闻'].filter(Boolean).join(' · ');
    items.push([
      '    <item>',
      `      <title>${xml(title || '收录了一条项目动态')}</title>`,
      `      <link>${xml(itemLink(url, page))}</link>`,
      `      <guid isPermaLink="false">${guid}</guid>`,
      `      <description>${xml(description)}</description>`,
      ...(timestamp && Number.isFinite(+timestamp) ? [`      <pubDate>${timestamp.toUTCString()}</pubDate>`] : []),
      '    </item>',
    ].join('\n'));
  }
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>GTA VI 移植观测站 · 新闻时间线</title>',
    `    <link>${xml(page)}</link>`,
    '    <description>GTA VI 移植观测站源码演示。全部条目为虚构数据。</description>',
    '    <language>zh-cn</language>',
    `    <atom:link href="${xml(self)}" rel="self" type="application/rss+xml" />`,
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

module.exports = { RSS_PATH, buildNewsFeed };
