'use strict';

const { createHash } = require('node:crypto');
const { DEFAULT_LOCALE, localizeTimelineItem, resolveLocale } = require('./_content-locale');

const RSS_PATH = '/rss.xml';
const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const COPY = {
  'zh-CN': {
    title: 'GTA VI 移植观测站 · 新闻时间线', description: 'GTA VI 移植观测站源码演示。随附的新闻均为虚构数据。',
    language: 'zh-cn', community: '社区新闻', untitled: '收录了一条项目动态',
  },
  en: {
    title: 'GTA VI PC Port Tracker · News Timeline', description: 'GTA VI PC Port Tracker demo. All bundled news is fictional.',
    language: 'en', community: 'Community news', untitled: 'A project update was added',
  },
  ja: {
    title: 'GTA VI PC移植トラッカー · ニュースタイムライン', description: 'GTA VI PC 移植トラッカーのデモです。付属のニュースはすべて架空です。',
    language: 'ja', community: 'コミュニティニュース', untitled: 'プロジェクトの動向を追加しました',
  },
};

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

function buildNewsFeed(timeline, origin, language) {
  const locale = resolveLocale(language);
  const copy = COPY[locale];
  const itemFallback = new URL('/#timeline', origin);
  const page = new URL(itemFallback);
  const self = new URL(RSS_PATH, origin);
  if (locale !== DEFAULT_LOCALE) {
    page.searchParams.set('lang', locale);
    itemFallback.searchParams.set('lang', locale);
    self.searchParams.set('lang', locale);
  }
  const seen = new Set();
  const items = [];
  for (const item of timeline) {
    const { title, repo, date, kind, url } = item;
    // Hash the original news, not the translated title, to keep subscription identity stable.
    const guid = createHash('sha256').update(JSON.stringify([kind, repo, date, title, kind === 'milestone' ? '' : url])).digest('hex');
    if (seen.has(guid)) continue;
    seen.add(guid);
    const dateOnly = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
    const timestamp = !dateOnly && date ? new Date(date) : null;
    const description = [dateOnly ? date : '', repo ? `@${repo}` : copy.community].filter(Boolean).join(' · ');
    items.push([
      '    <item>',
      `      <title>${xml(localizeTimelineItem(item, locale).title || copy.untitled)}</title>`,
      `      <link>${xml(itemLink(url, itemFallback.href))}</link>`,
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
    `    <title>${xml(copy.title)}</title>`,
    `    <link>${xml(page.href)}</link>`,
    `    <description>${xml(copy.description)}</description>`,
    `    <language>${xml(copy.language)}</language>`,
    `    <atom:link href="${xml(self.href)}" rel="self" type="application/rss+xml" />`,
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

module.exports = { RSS_PATH, buildNewsFeed };
