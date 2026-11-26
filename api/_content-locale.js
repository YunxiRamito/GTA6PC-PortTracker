// Keep editorial text separate from record identity, links and scoring inputs.
'use strict';

const DEFAULT_LOCALE = 'zh-CN';
const TRANSLATABLE_LOCALES = new Set(['en', 'ja']);
const NON_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff\ufffe\uffff]/u;

// Limits use UTF-16 code units, like the Chinese fields in the content store.
const NEWS_TRANSLATION_FIELDS = Object.freeze({ title: 400 });
const BUILD_TRANSLATION_FIELDS = Object.freeze({ title: 240, summary: 1800, sourceLabel: 160 });
const newsItem = { fields: NEWS_TRANSLATION_FIELDS };
const build = { fields: BUILD_TRANSLATION_FIELDS };
const project = {
  fields: { title: 180, summary: 800, progress: 600, game: 6400, state: 6400, approach: 6400, highlight: 6400 },
  children: { evidence: { fields: { tested: 180, blocker: 360 } } },
};
const home = { fields: { latestUpdate: 300 } };
const publicSections = {
  home: { ...home, children: { latestNews: [newsItem] } },
  countdown: {
    fields: { label: 200, source: 800 },
    children: { buttons: [{ fields: { label: 70 } }] },
  },
  roadmap: {
    children: {
      playability: { fields: { summary: 240 } },
      gameplayProgress: {
        fields: { title: 64, note: 600 },
        children: { milestones: [{ fields: { label: 64, evidence: 400 } }] },
      },
      privateRepositories: [build], communityBuild: build, externalProgress: build,
    },
  },
  announcements: {
    children: {
      items: [{ fields: { title: 240, summary: 2800 }, children: { buttons: [{ fields: { label: 80 } }] } }],
    },
  },
  downloads: {
    fields: { note: 600 },
    children: {
      items: [{ fields: { title: 200, description: 560 }, children: { channels: [{ fields: { label: 80 } }] } }],
    },
  },
  community: { children: { groups: [{ fields: { name: 100 } }] } },
};
const editorialShape = { children: { ...publicSections, home, news: [newsItem], projects: [project] } };
const publicShape = { children: publicSections };
const dashboardShape = {
  children: { projects: [project], privateRepositories: [build], communityBuild: build, externalProgress: build },
};

function resolveLocale(value) {
  return TRANSLATABLE_LOCALES.has(value) ? value : DEFAULT_LOCALE;
}

function isRecord(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readTranslations(value, fields, report = () => {}) {
  if (!fields || !isRecord(value)) {
    report('', fields ? '需要对象' : '此处不支持翻译');
    return;
  }
  const result = {};
  for (const [locale, entries] of Object.entries(value)) {
    if (!TRANSLATABLE_LOCALES.has(locale)) {
      report(`.${locale}`, '语言必须是 en 或 ja');
      continue;
    }
    if (!isRecord(entries)) {
      report(`.${locale}`, '需要对象');
      continue;
    }
    const translated = {};
    for (const [field, text] of Object.entries(entries)) {
      if (!Object.hasOwn(fields, field)) {
        report(`.${locale}.${field}`, '不是可翻译字段');
        continue;
      }
      const max = fields[field];
      if (typeof text !== 'string' || text.length > max || !text.trim() || NON_TEXT.test(text)) {
        report(`.${locale}.${field}`, `需要 1–${max} 个字符的纯文本`);
        continue;
      }
      translated[field] = text;
    }
    if (Object.keys(translated).length) result[locale] = translated;
  }
  return Object.keys(result).length ? result : undefined;
}

function projectTree(value, schema, locale) {
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) return value;
    let result = value;
    for (const [index, record] of value.entries()) {
      const next = projectTree(record, schema[0], locale);
      if (next !== record) {
        if (result === value) result = value.slice();
        result[index] = next;
      }
    }
    return result;
  }
  if (!isRecord(value)) return value;
  let result = projectRecord(value, schema.fields, locale);
  if (schema.children) {
    for (const [key, child] of Object.entries(schema.children)) {
      if (!Object.hasOwn(value, key)) continue;
      const next = projectTree(value[key], child, locale);
      if (next !== value[key]) {
        if (result === value) result = { ...value };
        result[key] = next;
      }
    }
  }
  return result;
}

function validateContentTranslations(content, check, retiredRoadmapFields) {
  // Inspect unknown records too, so they cannot introduce unsupported translation maps.
  const pending = [{ value: content, schema: editorialShape, location: '' }];
  while (pending.length) {
    const { value, schema, location } = pending.pop();
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        if (item && typeof item === 'object') {
          pending.push({ value: item, schema: Array.isArray(schema) ? schema[0] : undefined, location: `${location}[${index + 1}]` });
        }
      }
      continue;
    }
    if (!isRecord(value)) continue;
    if (Object.hasOwn(value, 'translations')) {
      const at = location ? `${location}.translations` : 'translations';
      readTranslations(value.translations, schema?.fields, (suffix, reason) => check(false, at + suffix, reason));
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'translations' || !child || typeof child !== 'object' ||
          (value === content.roadmap && retiredRoadmapFields.has(key))) continue;
      const childSchema = schema?.children && Object.hasOwn(schema.children, key) ? schema.children[key] : undefined;
      pending.push({ value: child, schema: childSchema, location: location ? `${location}.${key}` : key });
    }
  }
}

function copyTranslations(record, fields) {
  if (!Object.hasOwn(record, 'translations')) return {};
  const translations = readTranslations(record.translations, fields);
  return translations ? { translations } : {};
}

function newsTranslationsMatch(first, second) {
  const left = readTranslations(first.translations, NEWS_TRANSLATION_FIELDS);
  const right = readTranslations(second.translations, NEWS_TRANSLATION_FIELDS);
  for (const locale of TRANSLATABLE_LOCALES) {
    if ((left?.[locale]?.title ?? first.title) !== (right?.[locale]?.title ?? second.title)) return false;
  }
  return true;
}

function projectRecord(record, fields, locale) {
  if (!isRecord(record) || !Object.hasOwn(record, 'translations')) return record;
  const { translations, ...base } = record;
  const safe = readTranslations(translations, fields);
  if (locale !== DEFAULT_LOCALE) return { ...base, ...safe?.[locale] };
  return safe ? { ...base, translations: safe } : base;
}

function localizePublicContent(content, locale = DEFAULT_LOCALE) {
  return projectTree(content, publicShape, locale);
}

function localizeTimelineItem(item, locale = DEFAULT_LOCALE) {
  // An older snapshot may use the editorial record shape without a timeline kind.
  const editorial = item?.kind === 'milestone' || (item?.kind === undefined && typeof item?.id === 'string');
  return projectRecord(item, editorial ? NEWS_TRANSLATION_FIELDS : undefined, locale);
}

function localizeDashboard(dashboard, locale = DEFAULT_LOCALE) {
  const result = { ...projectTree(dashboard, dashboardShape, locale) };
  if (Array.isArray(result.timeline)) result.timeline = result.timeline.map(item => localizeTimelineItem(item, locale));
  const leaderId = result.progress?.leaderId;
  if (locale === DEFAULT_LOCALE || typeof leaderId !== 'string') return result;

  const findLeader = list => Array.isArray(list) ? list.find(record => record?.id === leaderId) : undefined;
  const leader = findLeader(result.projects) || findLeader(result.privateRepositories) ||
    (result.communityBuild?.id === leaderId ? result.communityBuild : undefined);
  if (typeof leader?.title === 'string') result.progress = { ...result.progress, leaderName: leader.title };
  return result;
}

module.exports = {
  DEFAULT_LOCALE, NEWS_TRANSLATION_FIELDS, BUILD_TRANSLATION_FIELDS, resolveLocale, validateContentTranslations,
  copyTranslations, newsTranslationsMatch, localizePublicContent, localizeDashboard, localizeTimelineItem,
};
