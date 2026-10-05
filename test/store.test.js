// Tests der lokalen Datenhaltung (public/store.js) ohne Browser.
// IndexedDB/localStorage fehlen in Node – store.js fällt dann still zurück.
// fetch liefert 401, damit kein Sync-Timer offen bleibt.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = async () => new Response('{}', { status: 401 });
const { store } = await import('../public/store.js');

beforeEach(async () => {
  await store.load();
  store.state.customers = {};
  store.state.entries = {};
  store.state.pending = { customers: {}, entries: {} };
});

test('Stoppen behält die Notiz des laufenden Timers', () => {
  const c = store.saveCustomer({ name: 'Kunde' });
  const e = store.start(c.id);
  store.saveEntry({ id: e.id, note: 'Wichtige Notiz' });
  const stopped = store.stop();
  assert.equal(stopped.note, 'Wichtige Notiz');
  assert.notEqual(stopped.end, null);
  assert.equal(store.state.pending.entries[e.id].note, 'Wichtige Notiz');
});

test('Neuer Start stoppt den laufenden Timer ohne dessen Notiz zu löschen', () => {
  const c = store.saveCustomer({ name: 'Kunde' });
  const first = store.start(c.id, 'Erste Notiz');
  store.start(c.id, 'Zweite Notiz');
  const prev = store.state.entries[first.id];
  assert.equal(prev.note, 'Erste Notiz');
  assert.notEqual(prev.end, null);
  assert.equal(store.running.note, 'Zweite Notiz');
});

test('Notiz nachträglich speichern startet einen gestoppten Timer nicht neu', () => {
  const c = store.saveCustomer({ name: 'Kunde' });
  const e = store.start(c.id);
  store.stop();
  store.saveEntry({ id: e.id, note: 'spät gespeichert' });
  assert.notEqual(store.state.entries[e.id].end, null);
  assert.equal(store.running, null);
});

test('Teiländerungen behalten alle übrigen Felder', () => {
  const c = store.saveCustomer({ name: 'Kunde' });
  const e = store.saveEntry({ customer_id: c.id, start: 1000, end: 5000, note: 'x' });
  store.saveEntry({ id: e.id, end: 4000 });
  assert.deepEqual(
    { ...store.state.entries[e.id], updated_at: 0 },
    { id: e.id, customer_id: c.id, start: 1000, end: 4000, note: 'x', deleted: false, updated_at: 0 },
  );
});

test('Neue Einträge bekommen Standardwerte', () => {
  const c = store.saveCustomer({ name: 'Kunde' });
  const e = store.saveEntry({ customer_id: c.id, start: 1000 });
  assert.equal(e.note, '');
  assert.equal(e.end, null);
  assert.equal(e.deleted, false);
  assert.equal(c.archived, false);
});

test('Umbenennen eines archivierten Kunden hebt die Archivierung nicht auf', () => {
  const c = store.saveCustomer({ name: 'Alt' });
  store.saveCustomer({ id: c.id, archived: true });
  store.saveCustomer({ id: c.id, name: 'Neu' });
  assert.equal(store.customer(c.id).archived, true);
  assert.equal(store.customer(c.id).name, 'Neu');
});
