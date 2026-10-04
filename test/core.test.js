import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport, reportToCSV, formatDuration, formatHours, formatClock, monthRange, weekRange,
} from '../public/shared/core.js';

process.env.TZ = 'Europe/Berlin';

test('Formatierung', () => {
  assert.equal(formatDuration(5400000), '1:30');
  assert.equal(formatDuration(59999), '0:00');
  assert.equal(formatHours(5400000), '1,50');
  assert.equal(formatClock(3723000), '01:02:03');
});

test('Monats- und Wochengrenzen', () => {
  const [from, to] = monthRange(2026, 1);
  assert.equal(new Date(from).getDate(), 1);
  assert.equal(new Date(to).getMonth(), 2);
  const [ws, we] = weekRange(new Date(2026, 9, 4, 12).getTime()); // Sonntag
  assert.equal(new Date(ws).getDay(), 1);
  assert.equal(new Date(ws).getDate(), 28);
  assert.equal(we - ws, 7 * 24 * 3600 * 1000);
});

test('Report summiert je Kunde, ignoriert Gelöschte und andere Monate', () => {
  const customers = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];
  const t = (d, h) => new Date(2026, 9, d, h).getTime();
  const entries = [
    { id: '1', customer_id: 'a', start: t(1, 9), end: t(1, 11) },
    { id: '2', customer_id: 'b', start: t(2, 9), end: t(2, 10) },
    { id: '3', customer_id: 'a', start: t(3, 9), end: t(3, 10), deleted: true },
    { id: '4', customer_id: 'a', start: new Date(2026, 8, 30, 9).getTime(), end: new Date(2026, 8, 30, 10).getTime() },
    { id: '5', customer_id: 'b', start: t(4, 9), end: null },
  ];
  const [from, to] = monthRange(2026, 9);
  const r = buildReport({ entries, customers, from, to, now: t(4, 10) });
  assert.equal(r.total, 4 * 3600000);
  assert.equal(r.count, 3);
  assert.equal(r.running, 1);
  assert.deepEqual(r.byCustomer.map((c) => [c.name, c.ms]), [['Alpha', 7200000], ['Beta', 7200000]]);
});

test('CSV ist Excel-tauglich und schützt vor Formel-Injektion', () => {
  const customers = [{ id: 'a', name: '=HYPERLINK("x")' }];
  const entries = [{ id: '1', customer_id: 'a', start: 0, end: 3600000, note: 'a;b' }];
  const r = buildReport({ entries, customers, from: 0, to: 1e13 });
  const csv = reportToCSV(r, customers);
  assert.ok(csv.startsWith('﻿Datum;Kunde'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes('"a;b"'));
});
