'use strict';

const MAX_CHARS = 60;
const MAX_NICKNAME_UNITS = 12;
const NOISE = /[\p{White_Space}\p{P}\p{S}\p{Cf}\p{M}]/u;
const ASCII_WORD = /^[a-z0-9]+$/;
const INVALID_DISPLAY = /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

const INVALID_NICKNAME_DISPLAY = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const RESERVED_NICKNAMES = new Set([
  '管', '房管', '管理', '管理员', '管理員', '系统', '系統', '官方', '管理记录', '管理記錄',
  '版主', '站长', '站長', 'admin', 'administrator', 'mod', 'moderator', 'system', 'official',
]);

function cleanDanmakuText(value) {
  if (typeof value !== 'string' || INVALID_DISPLAY.test(value)) return;
  const text = value.normalize('NFC').trim();
  if ([...text].length > MAX_CHARS || !/[^\p{White_Space}\p{Cf}\p{M}]/u.test(text)) return;
  return text;
}

function fold(text) {
  return [...text.normalize('NFKC').toLowerCase()];
}

function danmakuWordKey(text) {
  return fold(text).filter(char => !NOISE.test(char)).join('');
}

// An empty string stands for no nickname. Null marks an invalid supplied value.
function cleanDanmakuNickname(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || INVALID_NICKNAME_DISPLAY.test(value)) return null;
  const nickname = value.normalize('NFC').trim();
  let units = 0;
  for (const char of nickname) {
    units += char.codePointAt(0) <= 0x7f ? 1 : 2;
    if (units > MAX_NICKNAME_UNITS) return null;
  }
  // Fold accents and invisible characters for role matching without changing the displayed nickname.
  const roleKey = danmakuWordKey(nickname.normalize('NFKD').replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, ''));
  return RESERVED_NICKNAMES.has(roleKey) ? null : nickname;
}

function createDanmakuFilter(terms) {
  const root = { next: new Map() };
  for (const term of terms) {
    const key = danmakuWordKey(term);
    const chars = [...key];
    // Use phrases rather than single-character homographs in ordinary game chat.
    if (chars.length < 2) continue;
    let node = root;
    for (const char of chars) {
      if (!node.next.has(char)) node.next.set(char, { next: new Map() });
      node = node.next.get(char);
    }
    node.match = ASCII_WORD.test(key) ? 'ascii' : 'phrase';
  }

  return text => {
    const raw = fold(text);
    const letters = raw.flatMap((char, index) => NOISE.test(char) ? [] : [{ char, index }]);
    for (let start = 0; start < letters.length; start++) {
      let node = root;
      for (let end = start; end < letters.length; end++) {
        node = node.next.get(letters[end].char);
        if (!node) break;
        if (node.match === 'phrase') return true;
        if (node.match === 'ascii' &&
            !ASCII_WORD.test(raw[letters[start].index - 1] ?? '') &&
            !ASCII_WORD.test(raw[letters[end].index + 1] ?? '')) return true;
      }
    }
    return false;
  };
}

let builtIn;
let builtInWords;
function listBuiltInDanmakuWords() {
  builtInWords ||= Object.freeze([]);
  return builtInWords;
}

function defaultDanmakuFilter() {
  builtIn ||= createDanmakuFilter(listBuiltInDanmakuWords());
  return builtIn;
}

module.exports = {
  cleanDanmakuText, cleanDanmakuNickname, createDanmakuFilter, defaultDanmakuFilter, listBuiltInDanmakuWords, danmakuWordKey,
};
