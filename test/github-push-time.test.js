'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = app.indexOf('  var pushWeekdayFormatter =');
const end = app.indexOf('  /* ---------------- states ---------------- */', start);
assert.ok(start >= 0 && end > start, 'the GitHub push time formatter is present');

function createFormatter() {
  const context = {};
  vm.runInNewContext(app.slice(start, end) + '\nglobalThis.lastPushLabel = lastPushLabel;', context);
  return context;
}

const local = (year, month, day, hour = 23, minute = 0) => new Date(year, month - 1, day, hour, minute);

test('push timestamps use the exact local calendar format', () => {
  const formatter = createFormatter();
  const now = local(2026, 1, 15, 0, 4);
  const cases = [
    [local(2026, 1, 15, 0, 3), '00:03'],
    [local(2026, 1, 14), '昨日 23:00'],
    [local(2026, 1, 12), '周一 23:00'],
    [local(2026, 1, 9), '周五 23:00'],
    [local(2026, 1, 8), '1.8 23:00'],
    [local(2025, 12, 30), '12.30 23:00'],
    [local(2025, 1, 15), '很久以前'],
  ];
  for (const [pushedAt, label] of cases) assert.equal(formatter.lastPushLabel(pushedAt, now), label);
});

test('push time is based on local calendar days across daylight-saving midnight', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const formatter = createFormatter();
    const now = local(2026, 3, 9, 0, 4);
    assert.equal(formatter.lastPushLabel(local(2026, 3, 8, 0, 15), now), '昨日 00:15');
    assert.equal(formatter.lastPushLabel(local(2026, 3, 7, 23), now), '周六 23:00');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
